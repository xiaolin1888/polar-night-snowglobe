/**
 * 雪人平滑法线版：原始资产是平直着色（flat shading）风格，
 * 每个三角形独立法线，所以表面是"钻石切面"。这里把同位置顶点的法线取平均，
 * 得到平滑着色版本，用于对比哪种更符合场景观感。
 *
 * 用法：node tools/snowman_smooth.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, weld, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const TARGET_TRIS = Number(process.argv[2] || 60000);
const TEX = Number(process.argv[3] || 4096);

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const doc = await io.read(path.join(ROOT, 'assets/raw/snowman.glb'));
const root = doc.getRoot();

/* 关键顺序：先 weld 把重复顶点焊接（原始资产是平直着色，同位置有多个副本），
   再 simplify 减面，最后统一平滑法线。
   之前直接减面会保留"每面独立法线"的结构，棱面感完全不会消失。 */
await doc.transform(weld({ tolerance: 1e-5 }));

let tris = 0;
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
  const i = p.getIndices();
  tris += Math.floor((i ? i.getCount() : p.getAttribute('POSITION').getCount()) / 3);
}
console.log('after weld:', tris, 'tris');
if (TARGET_TRIS < tris) {
  await doc.transform(simplify({
    simplifier: MeshoptSimplifier,
    ratio: TARGET_TRIS / tris,
    error: 0.0008,
    lockBorder: false,
  }));
}

for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const nrm = prim.getAttribute('NORMAL');
    if (!pos || !nrm) continue;
    const n = pos.getCount();
    const pa = pos.getArray();
    const na = nrm.getArray();

    const buckets = new Map();
    const keys = new Array(n);
    for (let i = 0; i < n; i++) {
      const px = Math.round(pa[i * 3] * 1e4);
      const py = Math.round(pa[i * 3 + 1] * 1e4);
      const pz = Math.round(pa[i * 3 + 2] * 1e4);
      const k = px + ',' + py + ',' + pz;
      keys[i] = k;
      let b = buckets.get(k);
      if (!b) { b = [0, 0, 0]; buckets.set(k, b); }
      b[0] += na[i * 3]; b[1] += na[i * 3 + 1]; b[2] += na[i * 3 + 2];
    }
    for (let i = 0; i < n; i++) {
      const b = buckets.get(keys[i]);
      const L = Math.hypot(b[0], b[1], b[2]) || 1;
      na[i * 3] = b[0] / L;
      na[i * 3 + 1] = b[1] / L;
      na[i * 3 + 2] = b[2] / L;
    }
    nrm.setArray(na);
    console.log('smoothed:', n, 'verts,', buckets.size, 'unique positions');
  }
}

// 贴图降采样（保留法线贴图，它是表面细节的来源）
const resize = async (tex, size, quality) => {
  if (!tex) return null;
  const buf = Buffer.from(tex.getImage());
  let img = sharp(buf);
  const meta = await img.metadata();
  if (!meta.width) return null;
  if (meta.width > size) img = img.resize(size, size, { kernel: 'lanczos3' });
  const out = await img.jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer();
  return new Uint8Array(out);
};
for (const mat of root.listMaterials()) {
  const bc = mat.getBaseColorTexture();
  const nm = mat.getNormalTexture();
  if (bc) {
    const d = await resize(bc, TEX, 94);
    if (d) { const t = doc.createTexture('snow_base').setImage(d).setMimeType('image/jpeg'); t.setURI(''); mat.setBaseColorTexture(t); }
  }
  if (nm) {
    const d = await resize(nm, 2048, 95);
    if (d) { const t = doc.createTexture('snow_normal').setImage(d).setMimeType('image/jpeg'); t.setURI(''); mat.setNormalTexture(t); mat.setNormalScale(1.0); }
  }
  mat.setEmissiveTexture(null);
}

await doc.transform(prune());
const out = path.join(ROOT, 'assets/opt/snowman_smooth.glb');
await io.write(out, doc);
console.log('wrote', out, Math.round(fs.statSync(out).size / 1024), 'KB');
