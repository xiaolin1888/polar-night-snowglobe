/**
 * 把整个水晶球场景打成单个 HTML（可直接双击打开，file:// 下可用）。
 *
 * 做法：
 *   1. three.module.js / BufferGeometryUtils / GLTFLoader / app.js 逐个从 ESM 转成普通脚本
 *      （去掉 import/export，用 IIFE 串联），避免 file:// 下 ES module 的 CORS 限制。
 *   2. 场景用到的 GLB 以 base64 内联进 window.__EMBED，GLTFLoader 直接 parse ArrayBuffer。
 *   3. 兜底封面图内联为 data URL；importmap 与外部 script 引用全部移除。
 *
 * 用法： node tools/build-single.mjs
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---------- ESM → 普通脚本 ---------- */

function convertExportBlock(src) {
  // 末尾的 export { A, B as C }; → return { A, B: C };
  const m = src.match(/export\s*\{([\s\S]*?)\}\s*;?\s*$/);
  if (!m) return { body: src, names: [] };
  const entries = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const as = s.split(/\s+as\s+/);
      return as.length === 2 ? `${as[1].trim()}: ${as[0].trim()}` : s;
    });
  const body = src.slice(0, m.index) + `\nreturn { ${entries.join(', ')} };\n`;
  return { body, names: entries };
}

function convertImports(src, scopeMap) {
  // import { A, B as C } from 'x'
  src = src.replace(
    /import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g,
    (_all, names, from) => {
      const target = scopeMap[from];
      if (!target) throw new Error('未知的导入来源: ' + from);
      const list = names
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const as = s.split(/\s+as\s+/);
          return as.length === 2 ? `${as[0].trim()}: ${as[1].trim()}` : s;
        });
      return `const { ${list.join(', ')} } = ${target};`;
    }
  );
  // import * as NS from 'x'
  src = src.replace(
    /import\s*\*\s*as\s*(\w+)\s*from\s*['"]([^'"]+)['"]\s*;?/g,
    (_all, ns, from) => `const ${ns} = ${scopeMap[from] || from};`
  );
  return src;
}

function toIife(src, scopeMap = {}) {
  let out = convertImports(src, scopeMap);
  // export function / export class / export const ...
  out = out.replace(/\bexport\s+(function|class|const|let|var)\b/g, '$1');
  return convertExportBlock(out).body;
}

/* ---------- 资产 ---------- */

// 只内联场景真正用到的模型（与 app.js 的 MODELS 对应）
const MODEL_FILES = [
  'cabin', 'balloon', 'gondola', 'tree-a', 'lamp', 'postbox',
  'fence', 'bench', 'snowman', 'sled', 'giftbox', 'train-loco', 'train-car', 'hero',
];

const embed = {};
let rawBytes = 0;
for (const f of MODEL_FILES) {
  const buf = fs.readFileSync(path.join(ROOT, 'assets/opt', f + '.glb'));
  rawBytes += buf.length;
  embed[f] = buf.toString('base64');
}

/* ---------- 组装 ---------- */

const three = toIife(read('vendor/three/build/three.module.js'));
const utils = toIife(read('vendor/three/examples/jsm/utils/BufferGeometryUtils.js'), { three: 'THREE' });
const gltf = toIife(read('vendor/three/examples/jsm/loaders/GLTFLoader.js'), {
  three: 'THREE',
  '../utils/BufferGeometryUtils.js': '__UTILS',
});
let app = read('app.js');
app = app
  .replace(/^import\s+\*\s+as\s+THREE\s+from\s+['"]three['"];?\s*$/m, '')
  .replace(/^import\s*\{[^}]*\}\s*from\s*['"]three\/addons\/loaders\/GLTFLoader\.js['"];?\s*$/m, '');
if (/^\s*import\s/m.test(app)) throw new Error('app.js 里还有未处理的 import');

const bundle = `
/* ===== three.js r160 ===== */
var THREE = (function () {
${three}
})();

/* ===== BufferGeometryUtils ===== */
var __UTILS = (function () {
${utils}
})();

/* ===== GLTFLoader ===== */
var GLTFLoader = (function () {
${gltf}
})().GLTFLoader;

/* ===== 内嵌模型 ===== */
window.__EMBED = ${JSON.stringify(embed)};

/* ===== 场景 ===== */
(function () {
${app}
})();
`;

const poster = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(ROOT, 'assets/poster.jpg')).toString('base64');

let html = read('index.html');
// 注意：String.replace 的字符串替换里 $ 是特殊模式（three 源码含 '$'），必须用函数式替换
html = html
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, () => '')
  .replace(/<script type="module" src="\.\/app\.js"><\/script>/, () => '<script>\n' + bundle + '\n</script>')
  .replace('src="./assets/poster.jpg"', () => `src="${poster}"`);

if (html.includes('type="module"')) throw new Error('仍存在 module 脚本引用');

const out = path.join(ROOT, 'solstice-isle.html');
fs.writeFileSync(out, html);

const mb = (n) => (n / 1048576).toFixed(1) + 'MB';
console.log(JSON.stringify({
  out: path.relative(ROOT, out),
  size: mb(Buffer.byteLength(html)),
  models: MODEL_FILES.length,
  modelRaw: mb(rawBytes),
  three: mb(three.length),
  app: mb(app.length),
}, null, 2));
