/**
 * 单个场景资产高质量重制：从 assets/raw 重新生成到 assets/opt
 *
 * 背景：现有 assets/opt 把 50 万面压到了 2~6%，雪人只剩 5.6%（50万→2.8万面），
 * 近看非常糊。这个脚本按指定资产单独重跑，给更高面数与更大贴图。
 *
 * 用法：
 *   node tools/asset_rehi.mjs snowman 120000 4096 2048 1024
 *   参数依次是：资产名 目标面数 颜色贴图 法线贴图 ORM贴图
 *
 * 不传参数时使用内置清单。
 */
import fs from 'fs';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');

// 高质量清单：只给"近看显眼"的资产
const PLAN = {
  snowman:     { tris: 120000, color: 4096, normal: 2048, orm: 1024 },
  cabin:       { tris: 120000, color: 4096, normal: 2048, orm: 1024 },
  'tree-a':    { tris: 140000, color: 3072, normal: 2048, orm: 1024 },
  'tree-b':    { tris: 120000, color: 3072, normal: 2048, orm: 1024 },
  bench:       { tris:  60000, color: 3072, normal: 1536, orm: 768 },
  lamp:        { tris:  60000, color: 3072, normal: 1536, orm: 768 },
  postbox:     { tris:  50000, color: 2560, normal: 1536, orm: 768 },
  sled:        { tris:  50000, color: 2560, normal: 1536, orm: 768 },
  giftbox:     { tris:  50000, color: 2560, normal: 1536, orm: 768 },
  fence:       { tris:  45000, color: 2560, normal: 1536, orm: 768 },
  gondola:     { tris:  70000, color: 2560, normal: 1536, orm: 768 },
  balloon:     { tris:  50000, color: 2560, normal: 1536, orm: 768 },
  'train-loco':{ tris:  80000, color: 3072, normal: 2048, orm: 1024 },
  'train-car': { tris:  70000, color: 3072, normal: 2048, orm: 1024 },
};

const args = process.argv.slice(2);
const only = args[0] && !args[0].startsWith('-') ? args[0] : null;
const override = only && args[1] ? {
  tris: Number(args[1]),
  color: Number(args[2] || 4096),
  normal: Number(args[3] || 2048),
  orm: Number(args[4] || 1024),
} : null;

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

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
  // 只在原图更大时缩小，绝不放大（放大只会让文件变大、细节不变）
  if (meta.width > size) img = img.resize(size, size, { kernel: 'lanczos3' });
  const out = mime === 'png'
    ? await img.png({ compressionLevel: 9 }).toBuffer()
    : await img.jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer();
  return { data: new Uint8Array(out), mime, from: meta.width };
};

const entries = only ? Object.entries(PLAN).filter(([n]) => n === only) : Object.entries(PLAN);
if (only && entries.length === 0) {
  console.error('未知资产:', only, '\n可选:', Object.keys(PLAN).join(', '));
  process.exit(1);
}

for (const [name, basePlan] of entries) {
  const plan = override ? { ...basePlan, ...override } : basePlan;
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

  for (const mat of root.listMaterials()) {
    const bc = mat.getBaseColorTexture();
    const nm = mat.getNormalTexture();

    if (bc) {
      const r = await resize(bc, plan.color, 94, 'jpeg');
      if (r) {
        const t = doc.createTexture(`${name}_base`).setImage(r.data).setMimeType('image/jpeg');
        t.setURI('');
        mat.setBaseColorTexture(t);
        console.log(`  base  ${r.from} -> ${Math.min(r.from, plan.color)}`);
      }
    }
    if (nm && plan.normal) {
      const r = await resize(nm, plan.normal, 95, 'jpeg');
      if (r) {
        const t = doc.createTexture(`${name}_normal`).setImage(r.data).setMimeType('image/jpeg');
        t.setURI('');
        mat.setNormalTexture(t);
        mat.setNormalScale(1.0);
        console.log(`  normal ${r.from} -> ${Math.min(r.from, plan.normal)}`);
      }
    } else {
      mat.setNormalTexture(null);
    }

    const orm = mat.getMetallicRoughnessTexture() || mat.getOcclusionTexture();
    if (orm && plan.orm) {
      const r = await resize(orm, plan.orm, 95, 'jpeg');
      if (r) {
        const t = doc.createTexture(`${name}_orm`).setImage(r.data).setMimeType('image/jpeg');
        t.setURI('');
        mat.setMetallicRoughnessTexture(t);
        mat.setOcclusionTexture(t);
        mat.setOcclusionStrength(1.0);
        mat.setMetallicFactor(1.0);
        mat.setRoughnessFactor(1.0);
        console.log(`  orm    ${r.from} -> ${Math.min(r.from, plan.orm)}`);
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
  const out = path.join(ROOT, 'assets/opt', `${name}.glb`);
  await io.write(out, doc);
  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log(name.padEnd(12), before, '->', countTris(root), 'tris', kb, 'KB');
}
