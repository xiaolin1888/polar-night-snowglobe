/* 给角色 GLB 补回丢失的法线贴图与粗糙度/金属度贴图
 *
 * 源：FBX 内嵌的 4 张 4096 PNG（extract 见下）
 *   embedded_0 → baseColor（已在 glb 里）
 *   embedded_1 → normal（127,127,254）
 *   embedded_2 → roughness（灰度）
 *   embedded_3 → metallic（近黑）
 *
 * 用法：
 *   node tools/hero_maps.mjs assets/opt/hero.glb build/tex_raw
 *
 * 做法：glTF 的 metallicRoughnessTexture 用 G=roughness、B=metallic，
 * 所以把两张灰度图合成一张 ORM（R 留白给 AO）。
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const ROOT = path.resolve(import.meta.dirname, '..');
const [glb, texDir] = process.argv.slice(2);
const NORMAL_PX = Number(process.env.HERO_NORMAL || 2048);
const ORM_PX = Number(process.env.HERO_ORM || 1024);

const D = path.join(ROOT, texDir);
const base = path.join(ROOT, glb);

const normalSrc = path.join(D, 'embedded_1.png');
const roughSrc = path.join(D, 'embedded_2.png');
const metalSrc = path.join(D, 'embedded_3.png');
for (const p of [normalSrc, roughSrc, metalSrc]) {
  if (!fs.existsSync(p)) throw new Error('missing ' + p);
}

// 法线用高质量 JPEG（4:4:4）：PNG 无损要 2.6MB，这种卡通材质上 JPEG 的损失看不出来
const normalBuf = await sharp(normalSrc)
  .resize(NORMAL_PX, NORMAL_PX, { kernel: 'lanczos3' })
  .jpeg({ quality: 93, chromaSubsampling: '4:4:4' })
  .toBuffer();

// ORM：G=roughness, B=metallic
const rGray = await sharp(roughSrc).resize(ORM_PX, ORM_PX, { kernel: 'lanczos3' }).greyscale().raw().toBuffer();
const mGray = await sharp(metalSrc).resize(ORM_PX, ORM_PX, { kernel: 'lanczos3' }).greyscale().raw().toBuffer();

const orm = Buffer.alloc(ORM_PX * ORM_PX * 3);
for (let i = 0; i < ORM_PX * ORM_PX; i++) {
  orm[i * 3] = 255;          // R: AO 不用
  orm[i * 3 + 1] = rGray[i];  // G: roughness
  orm[i * 3 + 2] = mGray[i];  // B: metallic
}
const ormBuf = await sharp(orm, { raw: { width: ORM_PX, height: ORM_PX, channels: 3 } })
  .jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
  .toBuffer();

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(base);
const root = doc.getRoot();

const tn = doc.createTexture('normal').setImage(new Uint8Array(normalBuf)).setMimeType('image/jpeg').setURI('');
const to = doc.createTexture('orm').setImage(new Uint8Array(ormBuf)).setMimeType('image/jpeg').setURI('');

for (const mat of root.listMaterials()) {
  mat.setNormalTexture(tn);
  mat.setNormalScale(1.0);
  mat.setMetallicRoughnessTexture(to);
  // 用贴图后，这两个因子是乘数：保持 1/1，让贴图说了算
  mat.setMetallicFactor(1.0);
  mat.setRoughnessFactor(1.0);
}

await io.write(base, doc);
console.log(JSON.stringify({
  glb,
  normal: NORMAL_PX + 'px png ' + Math.round(normalBuf.length / 1024) + 'KB',
  orm: ORM_PX + 'px jpeg ' + Math.round(ormBuf.length / 1024) + 'KB',
  sizeMB: +(fs.statSync(base).size / 1048576).toFixed(2),
}));
