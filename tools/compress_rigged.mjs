/**
 * 带骨骼角色的贴图压缩：把 4096 贴图降到 2048/1024，保留 skin 数据
 * 用法: node tools/compress_rigged.mjs <in.glb> <out.glb> [colorSize] [normalSize] [ormSize]
 */
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup } from '@gltf-transform/functions';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const [inFile, outFile, cArg, nArg, oArg] = process.argv.slice(2);
const COLOR = Number(cArg || 2048);
const NORMAL = Number(nArg || 1024);
const ORM = Number(oArg || 512);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(path.isAbsolute(inFile) ? inFile : path.join(ROOT, inFile));
const root = doc.getRoot();

const resize = async (tex, size, quality) => {
  if (!tex) return null;
  const buf = Buffer.from(tex.getImage());
  let img = sharp(buf);
  const meta = await img.metadata();
  if (!meta.width) return null;
  const target = Math.min(meta.width, size);
  if (meta.width > target) img = img.resize(target, target, { kernel: 'lanczos3' });
  const out = await img.jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer();
  return { data: new Uint8Array(out), from: meta.width, to: target };
};

let i = 0;
for (const mat of root.listMaterials()) {
  const bc = mat.getBaseColorTexture();
  const nm = mat.getNormalTexture();
  const orm = mat.getMetallicRoughnessTexture() || mat.getOcclusionTexture();

  if (bc) {
    const r = await resize(bc, COLOR, 92);
    if (r) {
      const t = doc.createTexture(`base${i}`).setImage(r.data).setMimeType('image/jpeg');
      t.setURI('');
      mat.setBaseColorTexture(t);
      console.log(`base   ${r.from} -> ${r.to}`);
    }
  }
  if (nm) {
    const r = await resize(nm, NORMAL, 94);
    if (r) {
      const t = doc.createTexture(`normal${i}`).setImage(r.data).setMimeType('image/jpeg');
      t.setURI('');
      mat.setNormalTexture(t);
      console.log(`normal ${r.from} -> ${r.to}`);
    }
  }
  if (orm) {
    const r = await resize(orm, ORM, 92);
    if (r) {
      const t = doc.createTexture(`orm${i}`).setImage(r.data).setMimeType('image/jpeg');
      t.setURI('');
      mat.setMetallicRoughnessTexture(t);
      mat.setOcclusionTexture(t);
      console.log(`orm    ${r.from} -> ${r.to}`);
    }
  }
  i++;
}

await doc.transform(prune(), dedup());

// 关键：确认 skin 还在
const skins = root.listSkins();
console.log('skins:', skins.length, ' joints:', skins.length ? skins[0].listJoints().length : 0);

const out = path.isAbsolute(outFile) ? outFile : path.join(ROOT, outFile);
await io.write(out, doc);
const kb = Math.round(fs.statSync(out).size / 1024);
console.log('wrote', out, kb, 'KB');
