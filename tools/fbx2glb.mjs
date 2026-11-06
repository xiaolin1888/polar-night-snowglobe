/**
 * FBX → GLB（Node 侧，带最小 DOM 桩）
 * 只导出几何 / 骨骼 / 动画，材质用纯色占位，贴图稍后单独挂回去。
 *
 * 用法：node tools/fbx2glb.mjs assets/raw/hero.fbx build/hero_raw.glb
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const [src, out] = process.argv.slice(2);

/* ---------- 最小 DOM 桩 ---------- */
const noop = () => {};
class FakeImage {
  constructor() { this.width = 0; this.height = 0; this.style = {}; }
  set src(v) { this._src = v; setTimeout(() => this.onerror && this.onerror(new Error('stub')), 0); }
  get src() { return this._src; }
  addEventListener() {}
  removeEventListener() {}
  decode() { return Promise.reject(new Error('stub')); }
}
const fakeCanvas = () => ({
  width: 1, height: 1, style: {},
  getContext: () => ({
    drawImage: noop, fillRect: noop, clearRect: noop, getImageData: () => ({ data: new Uint8Array(4) }),
    putImageData: noop, createImageData: () => ({ data: new Uint8Array(4) }), save: noop, restore: noop,
    translate: noop, scale: noop, rotate: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    stroke: noop, fill: noop, arc: noop, rect: noop, clip: noop, setTransform: noop,
    measureText: () => ({ width: 0 }), fillText: noop, strokeText: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => ({}), canvas: null,
  }),
  toDataURL: () => 'data:,',
  addEventListener: noop,
});

const doc = {
  createElement: (t) => (t === 'canvas' ? fakeCanvas() : t === 'img' ? new FakeImage() : { style: {}, appendChild: noop }),
  createElementNS: (_ns, t) => (t === 'img' ? new FakeImage() : fakeCanvas()),
  createTextNode: () => ({}),
  body: { appendChild: noop, removeChild: noop },
  documentElement: { style: {} },
};

const g = globalThis;
g.self = g;
g.window = g;
g.document = doc;
try { Object.defineProperty(g, 'navigator', { value: { userAgent: 'node' }, configurable: true }); } catch (_) {}
g.HTMLCanvasElement = function () {};
g.HTMLImageElement = FakeImage;
g.Image = FakeImage;
g.createImageBitmap = () => Promise.reject(new Error('stub'));
g.URL.createObjectURL = () => 'blob:stub';
g.URL.revokeObjectURL = noop;
// GLTFExporter 用 FileReader 读 canvas blob
g.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((b) => { this.result = b; this.onloadend && this.onloadend(); })
      .catch((e) => { this.onerror && this.onerror(e); });
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((b) => {
      this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + Buffer.from(b).toString('base64');
      this.onloadend && this.onloadend();
    });
  }
};
g.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 16);
g.cancelAnimationFrame = noop;

/* ---------- 解析 FBX ---------- */
const { pathToFileURL } = await import('node:url');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const THREE = await imp('vendor/three/build/three.module.js');
const { FBXLoader } = await imp('vendor/three/examples/jsm/loaders/FBXLoader.js');
const { GLTFExporter } = await imp('vendor/three/examples/jsm/exporters/GLTFExporter.js');

const buf = fs.readFileSync(path.join(ROOT, src));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
console.log('parse', (buf.length / 1048576).toFixed(1) + 'MB');

const obj = new FBXLoader().parse(ab, '');

let meshes = 0, tris = 0, bones = 0;
obj.traverse((o) => {
  if (o.isMesh) {
    meshes++;
    const geo = o.geometry;
    tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    // 纯色占位材质：贴图稍后单独挂
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
    m.name = 'hero_base';
    o.material = m;
  }
  if (o.isBone) bones++;
  if (o.isMesh) {
    // FBXLoader 可能把 UV 命名为 uv1/uv2，统一成 uv，否则导出器不会写 TEXCOORD_0
    const g = o.geometry;
    const names = Object.keys(g.attributes);
    if (!g.attributes.uv) {
      const cand = names.find((n) => /^uv\d+$/.test(n));
      if (cand) {
        g.setAttribute('uv', g.attributes[cand]);
        g.deleteAttribute(cand);
        console.log('renamed', cand, '-> uv');
      }
    }
    console.log('attrs', Object.keys(g.attributes).join(','));
  }
});
console.log('meshes', meshes, 'tris', Math.round(tris), 'bones', bones, 'anims', obj.animations.length);

const exporter = new GLTFExporter();
const glb = await exporter.parseAsync(obj, {
  binary: true,
  onlyVisible: false,
  animations: obj.animations,
});

fs.mkdirSync(path.dirname(path.join(ROOT, out)), { recursive: true });
fs.writeFileSync(path.join(ROOT, out), Buffer.from(glb));
console.log('wrote', out, (glb.byteLength / 1048576).toFixed(1) + 'MB');
