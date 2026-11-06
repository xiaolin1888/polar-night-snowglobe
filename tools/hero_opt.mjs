/**
 * 角色 GLB 后处理：减面 + 贴图（base color）挂回 + 体积压缩
 *
 * 用法：node tools/hero_opt.mjs build/hero_raw.glb assets/opt/hero.glb 15000 build/tex/hero_03.png
 */
import fs from 'fs';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, prune, dedup } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const [src, out, targetArg, texArg] = process.argv.slice(2);
const target = Number(targetArg || 15000);

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(path.join(ROOT, src));
const root = doc.getRoot();

const countTris = () => {
  let t = 0;
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
    const i = p.getIndices();
    t += Math.floor((i ? i.getCount() : p.getAttribute('POSITION').getCount()) / 3);
  }
  return t;
};

const before = countTris();
console.log('before', before, 'tris');

await doc.transform(weld({ tolerance: 0 }), dedup());
await doc.transform(simplify({
  simplifier: MeshoptSimplifier,
  ratio: Math.min(1, target / before),
  error: Number(process.env.HERO_ERR || 0.001),
  lockBorder: false,
}));
// ---- 均匀缩放（烘进数据）：蒙皮网格无法靠父级缩放改尺寸 ----
// 同时缩放：顶点、骨骼静止位置、动画位移、逆绑定矩阵的平移列，四者一致才不变形
const TARGET_H = Number(process.env.HERO_H || 0.158);
{
  // 模型可能是 Z-up（高度在 Z 上），必须按世界坐标算高度，不能只看 POSITION 的 Y 范围
  const mul = (a, b) => {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let v = 0; for (let i = 0; i < 4; i++) v += a[i * 4 + r] * b[c * 4 + i];
      o[c * 4 + r] = v;
    }
    return o;
  };
  const xf = (m, v) => [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
  const measureWorld = () => {
    let mn = Infinity, mx = -Infinity;
    const walk = (node, parent) => {
      const m = mul(parent, node.getMatrix());
      const mesh = node.getMesh();
      if (mesh) for (const p of mesh.listPrimitives()) {
        const at = p.getAttribute('POSITION');
        if (!at) continue;
        const a = at.getMin([]), b = at.getMax([]);
        for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) {
          const w = xf(m, [x, y, z]);
          mn = Math.min(mn, w[1]); mx = Math.max(mx, w[1]);
        }
      }
      for (const c of node.listChildren()) walk(c, m);
    };
    const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    for (const n of root.listScenes()[0].listChildren()) walk(n, I);
    return mx - mn;
  };
  const curH = measureWorld();
  const k = TARGET_H / curH;
  if (Math.abs(k - 1) > 1e-6) {
    const scaleArr = (acc, elem, fn) => { const a = acc.getArray(); for (let i = 0; i < a.length; i += elem) fn(a, i); acc.setArray(a); };

    for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
      const at = p.getAttribute('POSITION');
      if (!at) continue;
      const a = at.getArray();
      for (let i = 0; i < a.length; i++) a[i] *= k;
      at.setArray(a);   // 包围盒 min/max 由 glTF-Transform 在写出时重算
    }
    for (const node of root.listNodes()) {
      const t = node.getTranslation();
      if (t[0] || t[1] || t[2]) node.setTranslation([t[0] * k, t[1] * k, t[2] * k]);
    }
    for (const anim of root.listAnimations()) {
      for (const ch of anim.listChannels()) {
        if (ch.getTargetPath() !== 'translation') continue;
        scaleArr(ch.getSampler().getOutput(), 3, (a, i) => { a[i] *= k; a[i + 1] *= k; a[i + 2] *= k; });
      }
    }
    for (const skin of root.listSkins()) {
      const ibm = skin.getInverseBindMatrices();
      if (ibm) scaleArr(ibm, 16, (a, i) => { a[i + 12] *= k; a[i + 13] *= k; a[i + 14] *= k; });
    }
    console.log('scaled by', k.toFixed(6), 'world height', curH.toFixed(3), '->', TARGET_H, 'verify', measureWorld().toFixed(3));
  }
}

// 注意：prune 必须放在挂贴图之后，否则未使用的 TEXCOORD_0 会被一并删掉

// ---- 贴图：base color 压到 1024 JPEG 挂回 ----
if (texArg && fs.existsSync(path.join(ROOT, texArg))) {
  // 贴图边长可用 HERO_TEX 覆盖：原来写死 1024，是模型"糊"的主因之一
  const TEX = Number(process.env.HERO_TEX || 2048);
  const Q = Number(process.env.HERO_Q || 93);
  const jpg = await sharp(path.join(ROOT, texArg))
    .resize(TEX, TEX, { kernel: 'lanczos3' })
    .jpeg({ quality: Q, chromaSubsampling: '4:4:4' })
    .toBuffer();
  console.log('texture', TEX + 'px', 'q' + Q, Math.round(jpg.length / 1024) + 'KB');

  const tex = doc.createTexture('basecolor')
    .setImage(new Uint8Array(jpg))
    .setMimeType('image/jpeg');
  const buf = doc.getRoot().listBuffers()[0] || doc.createBuffer();
  tex.setURI('');

  for (const mat of root.listMaterials()) {
    mat.setBaseColorTexture(tex);
    mat.setBaseColorFactor([1, 1, 1, 1]);
    mat.setMetallicFactor(0);
    mat.setRoughnessFactor(0.86);
    mat.setNormalTexture(null);
    mat.setMetallicRoughnessTexture(null);
    mat.setOcclusionTexture(null);
    mat.setEmissiveTexture(null);
    mat.setEmissiveFactor([0, 0, 0]);
    mat.setAlphaMode('OPAQUE');
    mat.setDoubleSided(false);
    void buf;
  }
}

await doc.transform(prune());
await io.write(path.join(ROOT, out), doc);
const stat = fs.statSync(path.join(ROOT, out));
console.log(JSON.stringify({
  out,
  before,
  after: countTris(),
  sizeKB: Math.round(stat.size / 1024),
  animations: root.listAnimations().map((a) => a.getName()),
  skins: root.listSkins().length,
}, null, 2));
