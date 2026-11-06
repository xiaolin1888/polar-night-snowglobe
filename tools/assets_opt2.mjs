/**
 * 场景资产重优化：保留法线贴图 + 提高颜色贴图分辨率 + 提高面数预算
 *
 * 之前的 assets/opt 把 500k 面压到 9k、贴图压到 1024 JPEG、法线/ORM 全丢，
 * 近看就是"糊 + 平"。这个脚本重新从 assets/raw 出：
 *   - 颜色贴图 → 2048（重点资产）/ 1024（远景小件）JPEG q92
 *   - 法线贴图 → 1024 JPEG q94（保留表面细节，这比加面数便宜得多）
 *   - 面数 → 按 PLAN 给的目标，不再是越低越好
 *   - ORM 仍然丢掉，材质统一 metalness 0 / roughness 0.85（原调色按这个来的）
 *
 * 用法：node tools/assets_opt2.mjs [outDir]
 */
import fs from 'fs';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = process.argv[2] || 'assets/opt2';

// tris: 目标面数；color/normal: 贴图边长
const PLAN = {
  'cabin':      { tris: 30000, color: 2560, normal: 1536, orm: 768 },
  'tree-a':     { tris: 56000, color: 2560, normal: 1536, orm: 768 },
  'tree-b':     { tris: 48000, color: 2048, normal: 1536, orm: 768 },
  'snowman':    { tris: 28000, color: 2560, normal: 1536, orm: 768 },
  'bench':      { tris: 20000, color: 2048, normal: 1536, orm: 768 },
  'lamp':       { tris: 18000, color: 2048, normal: 1536, orm: 768 },
  'train-loco': { tris: 28000, color: 2048, normal: 1536, orm: 768 },
  'train-car':  { tris: 24000, color: 2048, normal: 1536, orm: 768 },
  'balloon':    { tris: 12000, color: 1536, normal: 1024, orm: 512 },
  'gondola':    { tris: 16000, color: 1280, normal: 1024, orm: 512 },
  'postbox':    { tris: 12000, color: 2048, normal: 1536, orm: 768 },
  'sled':       { tris: 10000, color: 1280, normal: 1024, orm: 512 },
  'giftbox':    { tris: 10000, color: 1280, normal: 1024, orm: 512 },
  'fence':      { tris: 9000,  color: 1280, normal: 1024, orm: 512 },
};

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
fs.mkdirSync(path.join(ROOT, OUT), { recursive: true });

const countTris = (root) => {
  let t = 0;
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
    const i = p.getIndices();
    t += Math.floor((i ? i.getCount() : p.getAttribute('POSITION').getCount()) / 3);
  }
  return t;
};

const resize = async (tex, size, quality, mime) => {
  if (!tex || !size) return null;
  const buf = Buffer.from(tex.getImage());
  let img = sharp(buf);
  const meta = await img.metadata();
  if (!meta.width) return null;
  if (meta.width > size) img = img.resize(size, size, { kernel: 'lanczos3' });
  const out = mime === 'png'
    ? await img.png({ compressionLevel: 9 }).toBuffer()
    : await img.jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer();
  return { data: new Uint8Array(out), mime };
};

const report = [];
for (const [name, plan] of Object.entries(PLAN)) {
  const src = path.join(ROOT, 'assets/raw', `${name}.glb`);
  if (!fs.existsSync(src)) { console.log('skip (no raw)', name); continue; }

  const doc = await io.read(src);
  const root = doc.getRoot();
  const before = countTris(root);

  await doc.transform(weld({ tolerance: 0 }), dedup());
  const ratio = Math.min(1, plan.tris / before);
  if (ratio < 0.999) {
    await doc.transform(simplify({
      simplifier: MeshoptSimplifier,
      ratio,
      error: Number(process.env.OPT_ERR || 0.005),
      lockBorder: false,
    }));
  }

  // ---- 贴图：颜色 + 法线 ----
  for (const mat of root.listMaterials()) {
    const bc = mat.getBaseColorTexture();
    const nm = mat.getNormalTexture();

    if (bc) {
      const r = await resize(bc, plan.color, 92, 'jpeg');
      if (r) {
        const t = doc.createTexture(`${name}_base`)
          .setImage(r.data).setMimeType('image/jpeg');
        t.setURI('');
        mat.setBaseColorTexture(t);
      }
    }
    if (nm && plan.normal) {
      const r = await resize(nm, plan.normal, 94, 'jpeg');
      if (r) {
        const t = doc.createTexture(`${name}_normal`)
          .setImage(r.data).setMimeType('image/jpeg');
        t.setURI('');
        mat.setNormalTexture(t);
        mat.setNormalScale(1.0);
      }
    } else {
      mat.setNormalTexture(null);
    }

    // ---- ORM 保留：丢掉它等于让木头、金属、布料共用一套反光参数 ----
    const orm = mat.getMetallicRoughnessTexture() || mat.getOcclusionTexture();
    if (orm && plan.orm) {
      const r = await resize(orm, plan.orm, 95, 'jpeg');
      if (r) {
        const t = doc.createTexture(`${name}_orm`)
          .setImage(r.data).setMimeType('image/jpeg');
        t.setURI('');
        mat.setMetallicRoughnessTexture(t);
        mat.setOcclusionTexture(t);
        mat.setOcclusionStrength(1.0);
        mat.setMetallicFactor(1.0);     // 由贴图决定
        mat.setRoughnessFactor(1.0);
      }
    } else {
      mat.setMetallicRoughnessTexture(null);
      mat.setOcclusionTexture(null);
      mat.setMetallicFactor(0);
      mat.setRoughnessFactor(0.85);
    }
    mat.setEmissiveTexture(null);
    mat.setBaseColorFactor([1, 1, 1, 1]);
    mat.setDoubleSided(false);
  }

  await doc.transform(prune());
  const out = path.join(ROOT, OUT, `${name}.glb`);
  await io.write(out, doc);
  const kb = Math.round(fs.statSync(out).size / 1024);
  const after = countTris(root);
  report.push({ name, tris: `${before}->${after}`, kb });
  console.log(name.padEnd(12), String(before).padStart(7), '->', String(after).padStart(6), 'tris', String(kb).padStart(6), 'KB');
}

const total = report.reduce((a, r) => a + r.kb, 0);
console.log('total', (total / 1024).toFixed(1), 'MB');
