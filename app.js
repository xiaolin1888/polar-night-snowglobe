import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const METER_Q = new URLSearchParams(location.search).has('meter');
// ?pause=1 —— 冻结每帧的光照/环境写入。
// animate() 会无条件重写 keyLight.intensity / hemiLight.intensity / toneMappingExposure，
// 导致外部脚本改完参数后在下一帧被还原，"关灯做对照"这类隔离实验会静默失效。
// 排查光照时用 ?pause=1 打开，再手动调参数，所见即所得。
const DBG_PAUSE = new URLSearchParams(location.search).get('pause') === '1';
const SHOT_AT = Number(new URLSearchParams(location.search).get('shot') || 0);   // ?shot=8 → 8 秒后导出 PNG
let shotPend = SHOT_AT > 0 ? SHOT_AT : 0;
let shotDone = false;
if (SHOT_AT > 0) {
  // 后台标签页会节流 rAF，用定时器兜底：到点直接导出（preserveDrawingBuffer 保证有内容）
  setTimeout(() => {
    if (!shotDone) { shotPend = 0; shotDone = true; exportShot(); }
  }, SHOT_AT * 1000 + 1200);
}

function exportShot() {
  const W = 1400;
  const H = Math.round(W * (window.innerHeight || 800) / (window.innerWidth || 1280));
  const c2 = document.createElement('canvas');
  c2.width = W; c2.height = H;
  c2.getContext('2d').drawImage(canvas, 0, 0, W, H);
  const name = 'shot-' + Math.round(performance.now());

  // 优先回传到本地接收端（调试用：python _shot.py），失败才走浏览器下载
  c2.toBlob((blob) => {
    if (!blob) { document.title = 'SHOTERR toBlob'; return; }
    fetch('http://127.0.0.1:8933/' + name, { method: 'POST', body: blob })
      .then((r) => { document.title = 'SHOT ' + W + 'x' + H + ' post' + r.status; })
      .catch(() => {
        const a = document.createElement('a');
        a.download = name + '.png';
        a.href = URL.createObjectURL(blob);
        document.body.appendChild(a);
        a.click();
        a.remove();
        document.title = 'SHOT ' + W + 'x' + H + ' dl';
      });
  }, 'image/png');
}

/* ============================== 配置 ============================== */

const R = 1.0;                 // 玻璃球半径
const GY = -0.44;              // 雪地中心高度
const GK = 0.070;              // 雪面外倾系数

const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

// 各向异性过滤档位（渲染器可能在后面才创建，用函数惰性取）
let _maxAniso = 0;
const aniso = () => {
  try {
    if (!_maxAniso && typeof renderer !== 'undefined' && renderer) {
      _maxAniso = renderer.capabilities.getMaxAnisotropy();
    }
  } catch (_) {}
  return Math.min(8, _maxAniso || 1);
};

const CFG = {
  shadows: !IS_MOBILE,
  transmission: !IS_MOBILE,
  snowCount: IS_MOBILE ? 900 : 1700,
  snowDrift: IS_MOBILE ? 160 : 360,
  dpr: Math.min(window.devicePixelRatio || 1, IS_MOBILE ? 1.75 : 2),
};

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('solstice.' + k);
      return v === null ? d : JSON.parse(v);
    } catch (_) { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('solstice.' + k, JSON.stringify(v)); } catch (_) {}
  },
};

/* ---------------- 可调参数 ---------------- */

const DEFAULTS = {
  day: 0,        // 0 夜 · 1 昼
  snow: 0.6,     // 降雪密度
  wind: 1,       // 风力
  ferris: 1,     // 摩天轮转速
  train: 1,      // 小火车速度
  glow: 1,       // 灯光强度
  exp: 1,        // 画面亮度
  orbit: 1,      // 空闲自动环绕
  tier: 1,       // 画质档：0=高 1=中 2=低（默认「中」，稳帧率优先）
  tierAuto: 1,   // 1=让帧率自动决定画质，0=用户手动选过
  plaque: '极夜雪境',
};
const S = Object.assign({}, DEFAULTS, store.get('cfg', {}));
// 旧配置里没有 tierAuto：说明之前存的是自动降档结果，重置回「中」
if (!('tierAuto' in store.get('cfg', {}))) S.tier = 1;
function saveCfg() { store.set('cfg', S); }

const MODELS = {
  cabin:      { h: 0.31 },
  balloon:    { h: 0.36 },
  gondola:    { h: 0.068 },
  tree:       { h: 0.23, file: 'tree-a' },
  treeB:      { h: 0.23, file: 'tree-b' },
  lamp:       { h: 0.19 },
  postbox:    { h: 0.145 },
  fence:      { h: 0.080 },
  bench:      { h: 0.086 },
  /* 2026-11-03：sled（雪橇）按需求移除；bench（长椅）保留 */
  snowman:    { h: 0.165 },
  giftbox:    { h: 0.045 },
  'train-loco': { h: 0.130 },
  'train-car':  { h: 0.105, alignZ: true },
  /* 2026-11-03：主角换成新生成的无脸模型 boy.glb（20 骨、4 万面）。
     它是按"真实身高 1.101 单位"导出的，和场景里 0.158 的角色尺度不同，
     所以走 noNormalize=false 的常规归一化路径（按 h 自动缩放到目标高度）。 */
  /* 2026-11-04：换了新角色模型后改为 noNormalize。
     原因：归一化用的是 Box3 包围盒高度，而角色是 T-pose（手臂水平展开），
     包围盒高度会把手臂也算进去，导致缩放比例算错、姿态发飘。
     新模型已经在 Blender 里烘好世界尺寸（身高 0.1574、脚底 y=0、面朝 -Z），
     直接用原尺寸即可，不要再缩放。 */
  hero:         { h: 0.158, file: 'boy', noNormalize: true },
};

/* ---------------- 布局表：落地物件位置的唯一来源 ----------------
   x/z  世界坐标（球心为原点，+z 朝向默认视角）
   rot  绕 Y 的朝向
   r    占地半径，用于与轨道、其他物件做间距校验
   sink 陷入雪面的深度（模型已归一化，底部在 y=0） */
const LAYOUT = {
  cabin:    { x: -0.34, z: -0.03, rot: 0.42,  r: 0.135, sink: 0.010 },
  cabinFar: { x:  0.02, z: -0.44, rot: 2.35,  r: 0.095, sink: 0.010, scale: 0.72 },
  lamp:     { x: -0.13, z:  0.19, rot: 0.20,  r: 0.035, sink: 0.006 },
  bench:    { x: -0.27, z:  0.28, rot: 0.88,  r: 0.048, sink: 0.006 },
  postbox:  { x:  0.32, z:  0.245, rot: 3.00, r: 0.032, sink: 0.006 },
  snowman:  { x:  0.38, z:  0.31, rot: -0.35, r: 0.045, sink: 0.012 },
  giftA:    { x: -0.45, z:  0.12, rot: 0.40,  r: 0.022, sink: 0.003 },
  giftB:    { x:  0.295, z: 0.375, rot: 1.10, r: 0.022, sink: 0.003 },
  tree:     { x: -0.58, z: -0.14, rot: 0.50,  r: 0.075, sink: 0.015 },
  pond:     { x: -0.10, z:  0.42, rot: 0,     r: 0.186, sink: 0.000 },
  plaza:    { x:  0.03, z: -0.04, rot: 0.70,  r: 0.080, sink: 0.012 },
  booth:    { x:  0.560, z: 0.000, rot: -0.95, r: 0.065, sink: 0.004 },
  railA:    { x:  0.300, z: -0.118, rot: 0,    r: 0.070, sink: 0.004 },
};

/* ---------------- 路网：主街 + 支径 + 摩天轮入口 ---------------- */

const PATHS = [
  // 主街：木屋门口 → 邮筒 → 摩天轮售票亭
  { w: 0.066, pts: [[-0.31, 0.045], [-0.22, 0.095], [-0.07, 0.150], [0.08, 0.182],
                    [0.21, 0.190], [0.34, 0.158], [0.44, 0.080], [0.475, 0.030]] },
  // 支径：主街 → 冰湖边长椅
  { w: 0.050, pts: [[-0.02, 0.170], [-0.11, 0.235], [-0.19, 0.300]] },
  // 入口：主街 → 摩天轮排队口
  { w: 0.046, pts: [[0.445, 0.055], [0.405, -0.020], [0.396, -0.090]] },
];

// 到路网中心线的最小距离：地面在走廊内压平，模拟被踩实的雪
const _pathSamples = [];
for (const def of PATHS) {
  const c = new THREE.CatmullRomCurve3(
    def.pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'catmullrom', 0.5
  );
  for (let i = 0; i <= 64; i++) {
    const pt = c.getPoint(i / 64);
    _pathSamples.push([pt.x, pt.z, def.w / 2]);
  }
}
function distToPath(x, z) {
  let best = 9;
  for (let i = 0; i < _pathSamples.length; i++) {
    const q = _pathSamples[i];
    const dx = q[0] - x, dz = q[1] - z;
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/* ============================== 基础 ============================== */

const canvas = document.getElementById('c');

function showFallback(msg) {
  const err = document.getElementById('err');
  const ld = document.getElementById('loader');
  if (ld) ld.style.display = 'none';
  if (err) {
    err.classList.add('show');
    const t = err.querySelector('[data-msg]');
    if (t && msg) t.textContent = msg;
  }
}

let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: (typeof METER_Q !== 'undefined' && METER_Q) || (typeof SHOT_AT !== 'undefined' && SHOT_AT > 0) });
} catch (e) {
  renderer = null;
}
if (!renderer || !renderer.getContext()) {
  showFallback('当前浏览器或显卡未能提供 WebGL2 上下文。');
  throw new Error('WebGL unavailable');
}
renderer.setPixelRatio(CFG.dpr);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = CFG.shadows;
/* 2026-11-03 画质：PCFSoftShadowMap 是"无阴影过滤的硬边 + 大范围软糊"，
   近看时接触阴影完全没有，物件像浮在雪面上 —— 这是"塑料感/假"的主因之一。
   VSM 在同样的 mapSize 下能给出更连续的接触阴影过渡。 */
renderer.shadowMap.type = THREE.VSMShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.012, 40);   // near 必须远小于场景尺度（眼高仅 0.10）

const clock = new THREE.Clock();
const globe = new THREE.Group();
scene.add(globe);

const disposables = [];
const animated = [];
let warmCabin = null;
let hemiLight = null;
let snowPts = null, snowSwirl = 0, snowDir = 1;
let baseKey = null;
let lampLight = null;
let gust = 0, gustTarget = 0, gustHold = 0;
let flickT = 0, skaterBoost = 0, cabinTopPos = null;
let keyLight = null;
let dayMix = 0, dayTarget = 0;

/* ============================== 环境 ============================== */

/* ------------------------------------------------------------------
   材质细节纹理工厂
   场景里绝大多数物件（摩天轮、栈道、栅栏、灯柱、长椅…）都是"纯色
   MeshStandardMaterial"，没有任何贴图 —— 近看就是一块塑料。这里用
   Canvas 程序化生成三种可平铺的细节图，再统一注入到这些材质上：
     · 细颗粒/磨砂  → 金属、雪、石头
     · 木纹         → 木头
     · 织物         → 布料、大衣
   只改 normal / roughness，不动 baseColor，所以整体色调不变，
   但表面立刻有可读的微观起伏。
   ------------------------------------------------------------------ */
const _texCache = {};

/* 钢铁表面粗糙度贴图：真实钢架不会是"统一的粗糙度"——
   铸造区粗糙、打磨区光滑、还有细划痕。这种斑驳正是金属质感的来源。
   亮值 = 粗糙（哑光），暗值 = 光滑（有反射）。 */
let _steelRough = null;
function makeSteelRoughMap() {
  if (_steelRough) return _steelRough;
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const img = g.createImageData(S, S);
  const d = img.data;

  const hash2 = (ix, iy) => {
    let h = (ix * 374761393 + iy * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const vnoise = (u, v, P) => {
    const x = u * P, y = v * P;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const mx0 = ((x0 % P) + P) % P, my0 = ((y0 % P) + P) % P;
    const mx1 = (mx0 + 1) % P, my1 = (my0 + 1) % P;
    const a = hash2(mx0, my0), b = hash2(mx1, my0);
    const c = hash2(mx0, my1), e = hash2(mx1, my1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      // 中尺度斑块（打磨/未打磨）+ 细颗粒 + 一道斜向划痕
      const patch = vnoise(u, v, 9) * 0.44 + vnoise(u + 0.3, v + 0.7, 21) * 0.26;
      const grain = vnoise(u + 0.5, v + 0.5, 80) * 0.18;
      // 斜向拉丝：沿一个方向拉长的细噪声，模拟钢材轧制纹理
      const brush = vnoise(u * 0.04, v * 2.2, 60) * 0.22;
      let r = 0.34 + patch + grain + brush;      // 0.34~1.0
      r = Math.max(0.22, Math.min(1.0, r));
      const val = r * 255;
      const o = (y * S + x) * 4;
      d[o] = val; d[o + 1] = val; d[o + 2] = val; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  t.anisotropy = aniso();
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  _steelRough = t;
  return t;
}

function makeDetailTex(kind) {
  if (_texCache[kind]) return _texCache[kind];
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const img = g.createImageData(S, S);
  const d = img.data;

  // 可平铺的值噪声（value noise）。之前用多组正弦叠加，在大平面上
  // 会产生明显的干涉带/摩尔纹（像水波纹），必须换成随机格点插值。
  const hash2 = (ix, iy) => {
    // 整数格点 → [0,1) 的确定性伪随机，保证 x/y 平铺时首尾闭合
    let h = (ix * 374761393 + iy * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  // 周期为 P 的可平铺值噪声
  const vnoise = (u, v, P) => {
    const x = u * P, y = v * P;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const mx0 = ((x0 % P) + P) % P, my0 = ((y0 % P) + P) % P;
    const mx1 = (mx0 + 1) % P, my1 = (my0 + 1) % P;
    const a = hash2(mx0, my0), b = hash2(mx1, my0);
    const c = hash2(mx0, my1), e = hash2(mx1, my1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
  };

  const H = (x, y) => {
    const u = x / S, v = y / S;
    if (kind === 'wood') {
      // 木纹：沿 u 方向拉长的年轮条带（横向木纹），叠细纤维扰动
      const rings = vnoise(u * 0.06, v, 6) * 0.9;          // 低频、沿 v 变化 → 横向条纹
      const fiber = vnoise(u * 0.5, v, 48) * 0.30;
      const knots = vnoise(u, v, 11) * 0.18;
      return rings + fiber + knots;
    }
    if (kind === 'cloth') {
      // 织物：两组高频正交 + 一层大尺度褶皱
      const warp = vnoise(u, v, 96) * 0.5;
      const weft = vnoise(u + 0.37, v + 0.71, 96) * 0.5;
      const macro = vnoise(u, v, 7) * 0.45;
      return warp + weft + macro;
    }
    // fine：多尺度磨砂颗粒（低振幅，避免出现可见图案）
    return (
      vnoise(u, v, 32) * 0.42 +
      vnoise(u + 0.5, v + 0.5, 64) * 0.30 +
      vnoise(u + 0.25, v + 0.75, 128) * 0.20
    );
  };

  const strength = kind === 'wood' ? 3.0 : kind === 'cloth' ? 1.6 : 0.9;
  const eps = 1.0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const hx = H((x + eps) % S, y) - H((x - eps + S) % S, y);
      const hy = H(x, (y + eps) % S) - H(x, (y - eps + S) % S);
      let nx = -hx * strength, ny = -hy * strength, nz = 1.0;
      const len = Math.hypot(nx, ny, nz) || 1;
      const o = (y * S + x) * 4;
      d[o] = ((nx / len) * 0.5 + 0.5) * 255;
      d[o + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      d[o + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = aniso();
  t.needsUpdate = true;
  _texCache[kind] = t;
  return t;
}

/* 给一个纯色材质补表面细节。repeat 决定纹理疏密（按物件尺寸给不同值），
   scale 是法线强度。已经带贴图的材质直接跳过，绝不覆盖原有美术资源。 */
function addSurfaceDetail(mat, opt = {}) {
  if (!mat || !mat.isMeshStandardMaterial) return mat;
  if (mat.map || mat.normalMap) return mat;      // 已有贴图的不动
  const kind = opt.kind || 'fine';
  const tex = makeDetailTex(kind).clone();
  tex.needsUpdate = true;
  const r = opt.repeat || 6;
  tex.repeat.set(r, r);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = aniso();
  mat.normalMap = tex;
  const s = opt.scale !== undefined ? opt.scale : 0.55;
  mat.normalScale = new THREE.Vector2(s, s);
  // 纯色材质补一个基础环境反射，否则完全没有掠射光
  if (mat.envMapIntensity === undefined || mat.envMapIntensity < 0.3) {
    mat.envMapIntensity = opt.env !== undefined ? opt.env : 0.55;
  }
  mat.needsUpdate = true;
  return mat;
}

function makeEnvTexture(mode = 'night') {
  const day = mode === 'day';
  const w = 1024, h = 512;
  const cvs = document.createElement('canvas');
  cvs.width = w; cvs.height = h;
  const ctx = cvs.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  if (day) {
    g.addColorStop(0.00, '#1e3e5c');
    g.addColorStop(0.38, '#356584');
    g.addColorStop(0.50, '#5d8aa8');
    g.addColorStop(0.58, '#3d6584');
    g.addColorStop(1.00, '#223d53');
  } else {
    g.addColorStop(0.00, '#0a1526');
    g.addColorStop(0.38, '#16263f');
    g.addColorStop(0.50, '#2c4464');
    g.addColorStop(0.58, '#17263c');
    g.addColorStop(1.00, '#060a12');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // 一点水平方向的变化，避免反射完全均匀
  const g2 = ctx.createRadialGradient(w * 0.28, h * 0.42, 20, w * 0.28, h * 0.42, w * 0.95);
  if (day) {
    g2.addColorStop(0, 'rgba(255,244,214,.14)');
    g2.addColorStop(1, 'rgba(255,240,205,0)');
  } else {
    g2.addColorStop(0, 'rgba(150,190,235,.14)');
    g2.addColorStop(1, 'rgba(150,190,235,0)');
  }
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(cvs);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let envNight = null, envDay = null, envIsDay = false;

function buildEnvironment() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const build = (mode) => {
    const tex = makeEnvTexture(mode);
    return { bg: tex, env: pmrem.fromEquirectangular(tex).texture };
  };
  envNight = build('night');
  envDay = build('day');
  scene.environment = envNight.env;
  scene.background = envNight.bg;
  scene.backgroundBlurriness = 0.55;
  scene.backgroundIntensity = 0.55;
  pmrem.dispose();
}

function updateEnv() {
  const want = dayMix > 0.5;
  if (want === envIsDay) return;
  envIsDay = want;
  const e = want ? envDay : envNight;
  scene.environment = e.env;
  scene.background = e.bg;
}

function buildLights() {
  hemiLight = new THREE.HemisphereLight(0xb6d2f5, 0x101a28, 0.22);   // 强度由 applySettings 覆盖
  scene.add(hemiLight);

  const key = new THREE.DirectionalLight(0xd4e2f5, 1.62);
  keyLight = key;
  // 仰角是"看不见影子"的头号原因：原来的 (1.9, 4.3, 1.7) 仰角 61°，
  // 影长只有物高的 0.55 倍（树高 0.15 → 影子 0.08），整条影子都缩在物体脚下。
  // 压到 46° 后影长 ≈ 物高的 1.04 倍，影子才离得开底座。
  key.position.set(2.20, 2.75, 1.45);
  if (CFG.shadows) {
    key.castShadow = true;
    // 第一人称贴脸看时低分辨率阴影会把边缘糊成台阶，默认就用 4096
    key.shadow.mapSize.set(4096, 4096);
    /* 2026-11-03：阴影相机原来覆盖 ±1.6，是整个水晶球的尺度。但所有物件
       都挤在半径 0.9 的圆盘上，真正需要精度的只有中心那一小片。
       收紧到 ±1.05 后有效分辨率提高约 50%，接触阴影立刻变实。 */
    key.shadow.camera.near = 0.6;
    key.shadow.camera.far = 10;
    key.shadow.camera.left = -1.05;
    key.shadow.camera.right = 1.05;
    key.shadow.camera.top = 1.05;
    key.shadow.camera.bottom = -1.05;
    // 光压平后斜射更明显，自阴影（acne）会冒出来，bias 跟着放大一档
    key.shadow.bias = -0.00035;
    key.shadow.normalBias = 0.0022;
    // VSM 专用：半径与模糊采样数决定软阴影的柔和程度
    key.shadow.radius = 3.2;
    key.shadow.blurSamples = 12;
    key.shadow.camera.updateProjectionMatrix();
  }
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x88aae0, 0.40);
  rim.position.set(-2.4, 1.2, -2.6);
  scene.add(rim);
}

/* ============================== 地形 ============================== */

const surfY = (r) => GY - GK * Math.pow(r / 0.72, 2);
const groundY = (x, z) => surfY(Math.hypot(x, z));

/* 程序化雪面法线贴图：随机值噪声，只做极轻的表面颗粒。
   注意：这里必须用"随机格点噪声"而不是正弦叠加 —— 正弦在大平面上会
   产生干涉带（摩尔纹），第一人称贴地看时表现为明显的波浪纹，比原来更晕。 */
function makeSnowNoiseNormal() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const img = g.createImageData(S, S);
  const d = img.data;

  const hash2 = (ix, iy) => {
    let h = (ix * 374761393 + iy * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const vnoise = (u, v, P) => {
    const x = u * P, y = v * P;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const mx0 = ((x0 % P) + P) % P, my0 = ((y0 % P) + P) % P;
    const mx1 = (mx0 + 1) % P, my1 = (my0 + 1) % P;
    const a = hash2(mx0, my0), b = hash2(mx1, my0);
    const c = hash2(mx0, my1), e = hash2(mx1, my1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
  };
  const H = (x, y) => {
    const u = x / S, v = y / S;
    return vnoise(u, v, 24) * 0.45 + vnoise(u + 0.3, v + 0.6, 48) * 0.30 + vnoise(u + 0.7, v + 0.2, 96) * 0.18;
  };

  const eps = 1.0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const hx = H((x + eps) % S, y) - H((x - eps + S) % S, y);
      const hy = H(x, (y + eps) % S) - H(x, (y - eps + S) % S, 0);
      let nx = -hx * 0.5, ny = -hy * 0.5, nz = 1.0;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const o = (y * S + x) * 4;
      d[o] = (nx * 0.5 + 0.5) * 255;
      d[o + 1] = (ny * 0.5 + 0.5) * 255;
      d[o + 2] = (nz * 0.5 + 0.5) * 255;
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(14, 14);
  t.anisotropy = aniso();
  t.colorSpace = THREE.NoColorSpace;   // 法线贴图必须是线性空间
  t.needsUpdate = true;
  return t;
}

function sphereY(r) { return -Math.sqrt(Math.max(R * R - r * r, 0.0001)); }

/* 雪面粗糙度贴图：亮=松软新雪（粗糙），暗=被踩实/结冰（更光滑有反射）。
   这是雪地层次感的关键 —— 只靠法线，雪面仍然是一整片均匀白。 */
function makeSnowRoughMap() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const img = g.createImageData(S, S);
  const d = img.data;

  const hash2 = (ix, iy) => {
    let h = (ix * 374761393 + iy * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const vnoise = (u, v, P) => {
    const x = u * P, y = v * P;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const mx0 = ((x0 % P) + P) % P, my0 = ((y0 % P) + P) % P;
    const mx1 = (mx0 + 1) % P, my1 = (my0 + 1) % P;
    const a = hash2(mx0, my0), b = hash2(mx1, my0);
    const c = hash2(mx0, my1), e = hash2(mx1, my1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      /* 2026-11-03 二次修正：任何大尺度粗糙度斑块在贴地视角都会被读成
         "水渍/脏印"，非常难看。现在只保留高频细颗粒（模拟雪表面的细微起伏），
         完全去掉低频斑块，整体值域也收窄到 0.82~1.0，避免出现大面积反光差。 */
      const micro = vnoise(u + 0.7, v + 0.4, 56) * 0.10 + vnoise(u + 0.2, v + 0.9, 128) * 0.08;
      let r = 0.86 + micro;
      r = Math.max(0.82, Math.min(1.0, r));
      const val = r * 255;
      const o = (y * S + x) * 4;
      d[o] = val; d[o + 1] = val; d[o + 2] = val; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(11, 11);
  t.anisotropy = aniso();
  t.colorSpace = THREE.NoColorSpace;   // 粗糙度贴图是线性数据
  t.needsUpdate = true;
  return t;
}

function buildGround() {
  const pts = [];
  // 从中心沿雪面外扩，直到撞上球壁
  let rHit = 0.9;
  for (let r = 0.001; r < 1.0; r += 0.02) {
    if (surfY(r) <= sphereY(r) + 0.002) { rHit = r; break; }
  }
  const N = 40;
  for (let i = 0; i <= N; i++) {
    // 幂次分布：靠近中心环更密，否则极点会出现放射状条纹
    const r = rHit * Math.pow(i / N, 1.32);
    pts.push(new THREE.Vector2(Math.max(r, 0.0001), surfY(r)));
  }
  // 边缘圆角过渡：从雪面外沿平滑接到内缩后的壁面，消除台阶
  const yEdge = surfY(rHit);
  const yStart = yEdge - 0.055;
  const rTarget = Math.sqrt(Math.max(R * R - yStart * yStart, 0.0004)) * 0.968;
  for (let i = 1; i <= 5; i++) {
    const t = i / 5;
    const y = yEdge - 0.055 * t;
    const rr = rHit + (rTarget - rHit) * Math.sin(t * Math.PI * 0.5);
    pts.push(new THREE.Vector2(rr, y));
  }
  // 贴着球壁向下收，内缩 3.2% 避免与玻璃面重合导致 Z 冲突
  for (let i = 1; i <= 12; i++) {
    const y = yStart - (0.86 + yStart) * (i / 12);
    const wob = 1 + noise3(i * 0.7, y * 5.0, 0.5) * 0.012;
    const rr = Math.sqrt(Math.max(R * R - y * y, 0.0004)) * 0.968 * wob;
    pts.push(new THREE.Vector2(rr, y));
  }
  // 收口到底，整段藏进底座承口内部
  pts.push(new THREE.Vector2(0.30, -0.90));
  pts.push(new THREE.Vector2(0.001, -0.92));
  const geo = new THREE.LatheGeometry(pts, 96);
  geo.computeVertexNormals();
  // LatheGeometry 的绕序让法线朝内（phy：比外壁小 → 侧壁法线指向轴心）。
  // 材质是 DoubleSide 所以视觉上看不出来，但阴影比较用的是几何法线，
  // 内翻的法线会让整个雪地判为"背光"，key 的阴影在地面永远不成立。
  {
    const na = geo.attributes.normal;
    let up = 0, down = 0;
    for (let i = 0; i < na.count; i++) { const ny = na.getY(i); if (ny > 0) up++; else down++; }
    if (down > up) {
      const idx = geo.index.array;
      for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
      geo.index.needsUpdate = true;
      geo.computeVertexNormals();
    }
  }

  // 低幅噪声起伏，制造雪堆
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = noise3(v.x * 4.2, v.y * 4.2, v.z * 4.2) * 0.0075
            + noise3(v.x * 11, v.y * 11, v.z * 11) * 0.0022;
    const d = Math.hypot(v.x, v.z);
    const nearC = Math.min(1, 0.15 + d / 0.085);   // 极点附近压掉噪声
    if (v.y > -0.62) {
      // 路廊内削弱起伏：踩实的雪面应当比周围平
      const dp = distToPath(v.x, v.z);
      const flat = dp < 0.075 ? 0.12 + 0.88 * Math.min(1, Math.max(0, (dp - 0.028) / 0.04)) : 1;
      v.y += n * (1 - d / R * 0.4) * flat * nearC;
      // 外沿一带加径向起伏，避免形成完美圆形边缘
      if (d > 0.70) {
        const k = 1 + (noise3(v.x * 3.1, 0.7, v.z * 3.1)) * 0.030;
        v.x *= k; v.z *= k;
      }
    } else {
      const k = 1 + n * 0.55;
      v.x *= k; v.z *= k;
    }
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();

  // 顶点色三件事：径向压暗、雪体下缘压暗、雪面斑驳
  const cols = new Float32Array(pos.count * 3);
  const cA = new THREE.Color(0xc2cfe0);
  const cB = new THREE.Color(0x77899f);
  const tmpC = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const rr = Math.hypot(v.x, v.z) / R;
    const k = Math.pow(THREE.MathUtils.clamp(rr / 0.74, 0, 1), 1.15);
    tmpC.copy(cA).lerp(cB, k * 0.92);
    // 贴着球壁的雪体厚度不该反光，越往下越沉
    const thick = THREE.MathUtils.clamp((v.y + 0.715) / 0.135, 0.0, 1.0);
    tmpC.multiplyScalar(0.26 + 0.74 * Math.pow(thick, 1.35));
    // 雪面斑驳：低频起伏 + 高频颗粒
    const nc = Math.min(1, 0.2 + Math.hypot(v.x, v.z) / 0.095);
    const m = 1 + (
      noise3(v.x * 11, v.y * 11, v.z * 11) * 0.050
      + noise3(v.x * 34, v.y * 34, v.z * 34) * 0.048
      + noise3(v.x * 78, v.y * 78, v.z * 78) * 0.030
    ) * nc;
    tmpC.multiplyScalar(m);
    cols[i * 3] = tmpC.r; cols[i * 3 + 1] = tmpC.g; cols[i * 3 + 2] = tmpC.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));

  // 雪面是 1.0 的朗伯体，但光照总量（key 1.18 + hemi 0.40 + env）远超 1，
  // 高光区被 ACES 压到接近纯白 —— 白到 0.95 以上时，阴影区 0.6 也读作"白"，
  // 于是地面完全没有明暗层次。把扩散反照率降到 0.62 让剪切区间回到 0.15~0.75。
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd6dfe9, vertexColors: true, side: THREE.DoubleSide,
    roughness: 0.92, metalness: 0.0, envMapIntensity: 0.42,
  });
  /* 第一人称贴地看时，顶点色密度不够 → 地面是一大片均匀白，缺少可读的细节。
     这里叠两层：法线贴图给微观颗粒，roughnessMap 给"踩实/松软"的斑驳，
     让雪面有可读的明暗起伏，而不是一块死白。 */
  mat.normalMap = makeSnowNoiseNormal();
  mat.normalScale = new THREE.Vector2(0.55, 0.55);
  mat.roughnessMap = makeSnowRoughMap();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = CFG.shadows;
  mesh.userData.isGround = true;
  globe.add(mesh);
  disposables.push(geo, mat);
}

/* ============================== 底座 ============================== */

let plaqueCtx = null, plaqueTex = null;

function drawPlaque(title) {
  if (!plaqueCtx) return;
  const ctx = plaqueCtx;
  const t = String(title == null ? '' : title).trim().slice(0, 8) || '极夜雪境';
  ctx.clearRect(0, 0, 512, 128);
  ctx.fillStyle = '#c9a15a';
  ctx.fillRect(0, 0, 512, 128);
  const gg = ctx.createLinearGradient(0, 0, 0, 128);
  gg.addColorStop(0, 'rgba(255,235,190,.55)');
  gg.addColorStop(0.5, 'rgba(140,100,40,.25)');
  gg.addColorStop(1, 'rgba(60,40,12,.45)');
  ctx.fillStyle = gg;
  ctx.fillRect(0, 0, 512, 128);
  ctx.strokeStyle = 'rgba(70,48,16,.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, 496, 112);

  const n = [...t].length;
  const size = n <= 4 ? 52 : n <= 6 ? 42 : 34;
  const track = n <= 4 ? 10 : n <= 6 ? 6 : 3;
  ctx.fillStyle = '#3a2a10';
  ctx.font = `600 ${size}px "PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.textAlign = 'center';
  ctx.letterSpacing = track + 'px';
  ctx.fillText(t, 256, 68);
  ctx.fillStyle = 'rgba(58,42,16,.75)';
  ctx.font = '500 17px system-ui,sans-serif';
  ctx.letterSpacing = '4px';
  const dt2 = new Date();
  const stamp = `${dt2.getFullYear()}.${String(dt2.getMonth() + 1).padStart(2, '0')}.${String(dt2.getDate()).padStart(2, '0')}`;
  ctx.fillText(`N I G H T   S N O W   ·   ${stamp}`, 256, 100);
  const got = (typeof fx !== 'undefined' && fx.collected) ? fx.collected.size : 0;
  if (got > 0) {
    ctx.fillStyle = 'rgba(58,42,16,.72)';
    ctx.font = '500 13px system-ui,sans-serif';
    ctx.letterSpacing = '3px';
    ctx.fillText('★'.repeat(Math.min(got, 8)), 256, 118);
  }
  if (plaqueTex) plaqueTex.needsUpdate = true;
}

function buildBase() {
  // ---- 程序化大理石 ----
  const wc = document.createElement('canvas');
  wc.width = 1024; wc.height = 1024;
  const wx = wc.getContext('2d');
  wx.scale(2, 2);          // 2x 超采样：底座石材在近距离下不再糊
  wx.fillStyle = '#bdb4a4';
  wx.fillRect(0, 0, 512, 512);
  // 大块云斑，避免看起来像均匀的塑料
  for (let i = 0; i < 40; i++) {
    const cx = Math.random() * 512, cy = Math.random() * 512;
    const rr = 40 + Math.random() * 110;
    const gg = wx.createRadialGradient(cx, cy, 0, cx, cy, rr);
    const tone = Math.random() > 0.5 ? '200,194,182' : '156,150,138';
    gg.addColorStop(0, `rgba(${tone},${0.10 + Math.random() * 0.16})`);
    gg.addColorStop(1, `rgba(${tone},0)`);
    wx.fillStyle = gg;
    wx.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
  }
  const haze = wx.createLinearGradient(0, 0, 512, 512);
  haze.addColorStop(0, 'rgba(255,250,238,.30)');
  haze.addColorStop(0.5, 'rgba(180,172,158,.18)');
  haze.addColorStop(1, 'rgba(120,114,104,.22)');
  wx.fillStyle = haze;
  wx.fillRect(0, 0, 512, 512);
  // 石纹：小步长抖动 + 低对比，避免出现「闪电状」折线
  for (let i = 0; i < 38; i++) {
    wx.beginPath();
    let x = Math.random() * 512, y = -20;
    let drift = (Math.random() - 0.5) * 0.35;
    wx.moveTo(x, y);
    while (y < 532) {
      drift += (Math.random() - 0.5) * 0.22;
      drift = Math.max(-0.5, Math.min(0.5, drift));
      x += drift * 8 + (Math.random() - 0.5) * 3.2;
      y += 7 + Math.random() * 9;
      wx.lineTo(x, y);
    }
    wx.strokeStyle = `rgba(112,106,96,${(0.06 + Math.random() * 0.10).toFixed(3)})`;
    wx.lineWidth = 0.4 + Math.random() * 0.9;
    wx.stroke();
  }
  // 细小斑点
  for (let i = 0; i < 900; i++) {
    wx.fillStyle = `rgba(${120 + Math.random() * 70},${115 + Math.random() * 65},${104 + Math.random() * 60},${0.06 + Math.random() * 0.14})`;
    wx.fillRect(Math.random() * 512, Math.random() * 512, 1.1, 1.1);
  }
  const woodTex = new THREE.CanvasTexture(wc);
  woodTex.colorSpace = THREE.SRGBColorSpace;
  woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
  woodTex.repeat.set(2.6, 1);
  woodTex.anisotropy = 8;

  const wood = new THREE.MeshStandardMaterial({
    map: woodTex, color: 0xd6cfc0,
    roughness: 0.52, metalness: 0.0, envMapIntensity: 0.85,
    emissive: 0x1a1712, emissiveIntensity: 1.0,
  });
  const brass = addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0xa8873f, metalness: 0.86, roughness: 0.42, envMapIntensity: 1.30,
  }), { kind: 'fine', repeat: 7, scale: 0.75 });

  // ---- 黄铜承口：扣住球体下部，把雪壁遮住 ----
  const collarPts = [
    [0.701, -0.720], [0.713, -0.742], [0.711, -0.772], [0.696, -0.792],
  ].map(([x, y]) => new THREE.Vector2(x, y)).reverse();
  const collar = new THREE.Mesh(new THREE.LatheGeometry(collarPts, 96), brass);
  collar.castShadow = CFG.shadows;
  globe.add(collar);
  const collarTop = new THREE.Mesh(new THREE.TorusGeometry(0.702, 0.005, 10, 96), brass);
  collarTop.rotation.x = Math.PI / 2;
  collarTop.position.y = -0.721;
  globe.add(collarTop);

  // ---- 石质主体：喇叭收腰 + 直筒 ----
  const bodyPts = [
    [0.696, -0.792], [0.668, -0.822], [0.630, -0.862],
    [0.598, -0.902], [0.578, -0.940], [0.572, -0.978],
    [0.572, -1.062], [0.562, -1.078],
  ].map(([x, y]) => new THREE.Vector2(x, y)).reverse();
  const body = new THREE.Mesh(new THREE.LatheGeometry(bodyPts, 96), wood);
  body.castShadow = CFG.shadows;
  body.receiveShadow = CFG.shadows;
  globe.add(body);

  const bottomCap = new THREE.Mesh(new THREE.CircleGeometry(0.562, 96), wood);
  bottomCap.rotation.x = Math.PI / 2;
  bottomCap.position.y = -1.078;
  globe.add(bottomCap);

  const foot = new THREE.Mesh(new THREE.TorusGeometry(0.564, 0.010, 10, 96), brass);
  foot.rotation.x = Math.PI / 2;
  foot.position.y = -1.078;
  globe.add(foot);

  const inlay = new THREE.Mesh(
    new THREE.CylinderGeometry(0.574, 0.574, 0.006, 96, 1, true), brass
  );
  inlay.position.y = -0.986;
  globe.add(inlay);

  // ---- 底部补光 ----
  const fill = new THREE.PointLight(0xd6e6fb, 0.34, 1.9, 2);
  fill.position.set(1.35, -0.80, 1.85);
  globe.add(fill);
  const fill2 = new THREE.PointLight(0xa8c4e6, 0.20, 1.7, 2);
  fill2.position.set(-1.4, -0.85, 1.4);
  globe.add(fill2);
  baseKey = new THREE.PointLight(0xc6d8ee, 0.10, 2.0, 2);
  baseKey.position.set(0, -1.05, 1.6);
  globe.add(baseKey);
  const uplight = new THREE.PointLight(0xcfe0f7, 0.12, 1.5, 2);
  uplight.position.set(0.25, -1.15, 1.55);
  globe.add(uplight);

  // ---- 铭牌 ----
  const cvs = document.createElement('canvas');
  cvs.width = 1024; cvs.height = 256;     // 2x 超采样：铭牌字在高分辨率下不糊
  plaqueCtx = cvs.getContext('2d');
  plaqueCtx.scale(2, 2);
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso();
  plaqueTex = tex;
  drawPlaque(S.plaque);
  const plateMat = new THREE.MeshStandardMaterial({
    map: tex, roughness: 0.34, metalness: 0.85, envMapIntensity: 1.1,
  });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.30, 0.072), plateMat);
  plate.position.set(0, -1.022, 0.578);
  plate.rotation.x = -0.05;
  globe.add(plate);
  disposables.push(tex, plateMat, woodTex);
}

/* ============================== 玻璃 ============================== */

let glassMesh;
function buildGlass() {
  if (CFG.transmission) {
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.018,
      transmission: 1,
      thickness: 0.05,
      ior: 1.47,
      clearcoat: 0.42,
      clearcoatRoughness: 0.10,
      envMapIntensity: 0.95,
      attenuationColor: new THREE.Color(0xdbe9f7),
      attenuationDistance: 6.0,
      side: THREE.FrontSide,
      // 不写深度：transmission 材质总是先于透明物绘制，写深度会把球内的透明物整片剔除
      depthWrite: false,
    });
    const geo = new THREE.SphereGeometry(R, 96, 64);
    glassMesh = new THREE.Mesh(geo, mat);
    glassMesh.raycast = () => {};
    // 玻璃罩最后绘制：否则它先写入深度，球内的透明物（雪路、炊烟）会被剔除
    glassMesh.renderOrder = 20;
    globe.add(glassMesh);
    disposables.push(geo, mat);
  } else {
    // 轻量假玻璃：菲涅尔边缘 + 极淡透明壳
    const geo = new THREE.SphereGeometry(R, 64, 48);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xdfeeff, metalness: 0, roughness: 0.03,
      transparent: true, opacity: 0.10, envMapIntensity: 2.4,
      depthWrite: false, side: THREE.FrontSide,
    });
    glassMesh = new THREE.Mesh(geo, mat);
    glassMesh.raycast = () => {};
    glassMesh.renderOrder = 20;
    globe.add(glassMesh);

    const rimMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(0x9ec8ea) } },
      vertexShader: `
        varying vec3 vN; varying vec3 vV;
        void main(){
          vec4 wp = modelMatrix * vec4(position,1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform vec3 uColor; varying vec3 vN; varying vec3 vV;
        void main(){
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
          gl_FragColor = vec4(uColor, f * 0.55);
        }`,
    });
    const rim = new THREE.Mesh(new THREE.SphereGeometry(R * 1.001, 64, 48), rimMat);
    rim.raycast = () => {};
    rim.renderOrder = 21;
    globe.add(rim);
    disposables.push(rimMat);
  }
}


/* ---------------- 冰湖：贴合雪面曲率的天然冰面 ---------------- */

const pond = { cx: 0, cz: 0, rx: 0, rz: 0, lift: 0.008 };

// 边界扰动：冰面不是标准椭圆，避免“泳池 / 光盘”感
const pondWob = (a) => 1 + 0.062 * Math.sin(a * 3 + 1.15) + 0.038 * Math.sin(a * 5 + 0.42);

// 冰面贴图：霜斑 + 裂纹
function makeIceTexture() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#47677e';
  g.fillRect(0, 0, S, S);

  let seed = 20261101;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  // 霜斑（越靠外越白）
  for (let i = 0; i < 260; i++) {
    const x = rnd() * S, y = rnd() * S;
    const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
    const edge = Math.min(1, Math.hypot(dx, dy));
    const r = 10 + rnd() * 44;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const a = (0.03 + rnd() * 0.07) * (0.5 + edge);
    grd.addColorStop(0, `rgba(226,240,252,${a.toFixed(3)})`);
    grd.addColorStop(1, 'rgba(226,240,252,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  // 裂纹
  for (let i = 0; i < 9; i++) {
    let x = rnd() * S, y = rnd() * S;
    let ang = rnd() * Math.PI * 2;
    g.beginPath();
    g.moveTo(x, y);
    const steps = 6 + Math.floor(rnd() * 6);
    for (let s = 0; s < steps; s++) {
      ang += (rnd() - 0.5) * 0.9;
      x += Math.cos(ang) * (14 + rnd() * 26);
      y += Math.sin(ang) * (14 + rnd() * 26);
      g.lineTo(x, y);
    }
    g.strokeStyle = `rgba(232,246,255,${(0.10 + rnd() * 0.14).toFixed(3)})`;
    g.lineWidth = 0.7 + rnd() * 1.1;
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = aniso();
  return tex;
}

// 沿雪面曲率铺一张椭圆薄片；inner>0 挖空成环带；arc=[a0,a1] 只铺一段弧
function pondSheet(cx, cz, rx, rz, inner, segs, lift, arc) {
  const RINGS = 10;
  const full = !arc;
  const a0 = full ? 0 : arc[0];
  const a1 = full ? Math.PI * 2 : arc[1];
  const n = full ? segs : segs + 1;
  const pos = [], uv = [], col = [], idx = [], ringIdx = [];

  const ringAt = (t) => {
    const arr = [];
    for (let j = 0; j < n; j++) {
      const a = a0 + ((a1 - a0) * j) / (n - 1);
      const w = pondWob(a) * t;
      const x = cx + Math.cos(a) * rx * w;
      const z = cz + Math.sin(a) * rz * w;
      pos.push(x, surfY(Math.hypot(x, z)) + lift, z);
      uv.push((x - cx) / (rx * 2.2) + 0.5, (z - cz) / (rz * 2.2) + 0.5);
      // 边缘霜白（顶点色 >1 让边缘提亮成霜壳）
      const f = THREE.MathUtils.smoothstep(t, 0.58, 1.0);
      col.push(
        THREE.MathUtils.lerp(0.70, 1.06, f),
        THREE.MathUtils.lerp(0.78, 1.10, f),
        THREE.MathUtils.lerp(0.88, 1.14, f)
      );
      arr.push(pos.length / 3 - 1);
    }
    return arr;
  };

  const t0 = inner > 0 ? inner : 1 / RINGS;
  const first = ringAt(t0);
  ringIdx.push(first);

  if (inner <= 0) {
    pos.push(cx, surfY(Math.hypot(cx, cz)) + lift, cz);
    const c = pos.length / 3 - 1;
    uv.push(0.5, 0.5);
    col.push(0.70, 0.78, 0.88);
    for (let j = 0; j < n - 1; j++) idx.push(c, first[j + 1], first[j]);
    if (full) idx.push(c, first[0], first[n - 1]);
  }
  for (let i = 1; i <= RINGS; i++) ringIdx.push(ringAt(t0 + (1 - t0) * (i / RINGS)));

  for (let i = 1; i < ringIdx.length; i++) {
    const a = ringIdx[i - 1], b = ringIdx[i];
    for (let j = 0; j < n - 1; j++) {
      idx.push(a[j], b[j + 1], b[j], a[j], a[j + 1], b[j + 1]);
    }
    if (full) {
      const j = n - 1;
      idx.push(a[j], b[0], b[j], a[j], a[0], b[0]);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildPond() {
  const cx = LAYOUT.pond.x, cz = LAYOUT.pond.z;
  const rx = LAYOUT.pond.r, rz = LAYOUT.pond.r * 0.80;
  const lift = 0.008;
  Object.assign(pond, { cx, cz, rx, rz, lift });

  const iceTex = makeIceTexture();
  const ice = addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0xffffff, map: iceTex, vertexColors: true,
    metalness: 0.04, roughness: 0.44,
    envMapIntensity: 0.85, emissive: 0x0b1a26, emissiveIntensity: 0.55,
  }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const disc = new THREE.Mesh(pondSheet(cx, cz, rx, rz, 0, 84, lift), ice);
  disc.renderOrder = 1;
  globe.add(disc);
  disposables.push(ice, iceTex);

  // 岸边薄雪：贴着冰缘的一圈不规则雪壳（外扩很少，避免“盘沿”）
  const snowMat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0xd6dfe9, roughness: 1.0, metalness: 0 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const lip = new THREE.Mesh(pondSheet(cx, cz, rx * 1.045, rz * 1.045, 0.955, 84, lift - 0.0025), snowMat);
  lip.renderOrder = 1;
  globe.add(lip);
  disposables.push(snowMat);

  // 冰面上零星的积雪块（打破纯平面）
  const patchMat = addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0xdbe3ed, roughness: 1.0, metalness: 0,
    transparent: true, opacity: 0.92, alphaMap: getShadowTex(), depthWrite: false,
  }), { kind: 'fine', repeat: 7, scale: 0.75 });
  let seed = 7717;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 9; i++) {
    const a = rnd() * Math.PI * 2;
    const t = 0.48 + rnd() * 0.48;
    const x = cx + Math.cos(a) * rx * t * pondWob(a);
    const z = cz + Math.sin(a) * rz * t * pondWob(a);
    const r = 0.005 + rnd() * 0.009;
    const m = new THREE.Mesh(new THREE.CircleGeometry(1, 14), patchMat);
    m.scale.set(r * (0.8 + rnd() * 0.8), r * (0.7 + rnd() * 0.7), 1);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = rnd() * Math.PI;
    m.position.set(x, surfY(Math.hypot(x, z)) + lift + 0.0016, z);
    m.renderOrder = 2;
    globe.add(m);
  }
  disposables.push(patchMat);
}

/* ---------------- 柴院小景：已移除 ---------------- */

/* 2026-11-03 按需求移除了原木堆（原 buildYard）与雪橇。
   这里保留空函数，避免其他位置的调用报错；若确认无调用可直接删除。 */
function buildYard() { /* 已移除 */ }

/* ---------------- 中央小广场：树 + 礼物 + 暖光 ---------------- */

function buildPlaza() {
  const L = LAYOUT.plaza;
  const px = L.x, pz = L.z;
  const gy = groundY(px, pz);
  const plaza = new THREE.Group();

  let treeObj = null;
  if (loaded.tree) {
    const t = loaded.tree.clone(true);
    t.scale.setScalar(0.84);
    t.rotation.y = L.rot;
    t.traverse(o => { if (o.isMesh) o.castShadow = CFG.shadows; });
    plaza.add(t);
    treeObj = t;
  }

  // 树上的暖色小灯（螺旋挂在锥体上）
  const bulbMat = addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0xffe3b8, emissive: 0xffab48, emissiveIntensity: 1.7, roughness: 0.4,
  }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const bulbGeo = new THREE.SphereGeometry(0.0027, 8, 6);
  const bulbHost = treeObj || plaza;         // 挂到树上：随树一起缩放，不会浮在旁边
  for (let i = 0; i < 10; i++) {
    const a = i * 2.39996;
    const k = i / 9;
    const b = new THREE.Mesh(bulbGeo, bulbMat);
    const rad = (0.062 - k * 0.056) / 0.84;   // 已经坐在缩放后的树里，除以缩放还原
    b.position.set(
      Math.cos(a) * rad,
      (0.030 + k * 0.148) / 0.84,
      Math.sin(a) * rad
    );
    bulbHost.add(b);
  }
  disposables.push(bulbGeo, bulbMat);

  window.__probePlaza = new THREE.Vector3(px, gy + 0.10, pz);
  plaza.position.set(px, gy - L.sink, pz);
  globe.add(plaza);
  globe.updateMatrixWorld(true);
  registerKind(plaza, 'plaza', '广场小树');

  // 树下一圈礼物
  [[0.078, 0.040, 0.35], [-0.060, 0.060, 1.15], [0.014, -0.080, 2.30]].forEach(([dx, dz, rot]) => {
    const g = place(loaded.giftbox, px + dx, pz + dz, rot, 0, 0.004);
    if (g) g.scale.setScalar(0.95);
  });

  // 树下两盏暖光：一盏照树冠，一盏贴地做光斑
  const warm = new THREE.PointLight(0xffb46a, 0.060, 0.46, 2);
  warm.position.set(px, gy + 0.075, pz);
  globe.add(warm);
  const foot = new THREE.PointLight(0xffc98a, 0.020, 0.26, 2);
  foot.position.set(px, gy + 0.040, pz);
  globe.add(foot);
}

/* ---------------- 房屋装饰：屋檐冰柱 + 门灯 ----------------
   木屋本体只有原木和雪，没有"人住过"的痕迹；这两样最便宜也最有效。 */
function buildCabinDecor(obj) {
  if (!obj) return;
  // 屋子带 rot 旋转，直接 Box3 得到的是轴对齐盒（比实际大一圈），装饰会被甩到屋外。
  // 临时把旋转清零量局部尺寸，再把装饰挂进 obj，让它们跟着屋子转。
  const rotY = obj.rotation.y;
  obj.rotation.y = 0;
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  obj.rotation.y = rotY;
  obj.updateMatrixWorld(true);

  const w = box.max.x - box.min.x;
  const centerX = (box.min.x + box.max.x) * 0.5;
  // box 是"世界坐标"（含 obj.position），挂进 obj 前要减掉自身位移，否则会二次偏移
  const ox = obj.position.x, oy = obj.position.y, oz = obj.position.z;

  // 冰柱：靠包围盒推不出屋檐的确切位置（烟囱最高点会污染 max.y），
  // 反复调都会浮在雪面上或埋进屋顶，宁可去掉也不要出现悬空的锥体。

  // ---- 门灯：门右上侧一盏，尺寸要小（之前 6mm 半径在近景像奶桶）----
  const lampGlass = addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0xffe4b6, emissive: 0xffb257, emissiveIntensity: 2.2, roughness: 0.45,
  }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const lampIron = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0x2e3844, roughness: 0.6, metalness: 0.6 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const g = new THREE.Group();
  g.position.set(centerX + w * 0.115 - ox, box.min.y + 0.118 - oy, box.max.z + 0.006 - oz);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.0034, 0.0034, 0.0072, 8), lampGlass);
  g.add(glass);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.0046, 0.0034, 8), lampIron);
  cap.position.y = 0.0056;
  g.add(cap);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.0011, 0.0011, 0.010, 5), lampIron);
  arm.rotation.z = Math.PI / 2;
  arm.position.set(-0.0056, 0.0068, 0);
  g.add(arm);
  obj.add(g);
  const pl = new THREE.PointLight(0xffb066, 0.016, 0.24, 2);
  pl.position.set(g.position.x, g.position.y + 0.003, g.position.z + 0.01);
  obj.add(pl);
  disposables.push(lampGlass, lampIron, glass.geometry, cap.geometry, arm.geometry);

  // 门口被踩实的雪堆：只依赖门的已知位置，不会穿帮
  const snowMat3 = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0xe6f1fc, roughness: 1.0, metalness: 0 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(1, 9, 6), snowMat3);
    const rr = 0.020 - i * 0.004;
    p.scale.set(rr, rr * 0.26, rr * 0.8);
    p.position.set(g.position.x - 0.018 + i * 0.020, box.min.y + 0.002, box.max.z + 0.020 - oz * 0 + 0.006);
    obj.add(p);
  }
  disposables.push(snowMat3);
}

/* ---------------- 石板路 ----------------
   大片平滑雪地在相机移动时没有"光流"参照，看久了会晕；铺装是密集的重复图案，
   人眼能据此判断自身位移。用 InstancedMesh，上千块也只有一次 draw call。

   2026-11-03 最终方案（前面反复失败的教训）：
   在微缩场景里用"立体的石头"铺路是走不通的 —— 抬高了变台阶，压平了只露侧边。
   改成**贴地的平面石板片**（PlaneGeometry），完全贴住雪面，靠贴图与色差表达，
   这样从任何角度看都是"铺装"，不会有侧面、不会有台阶、也不会被雪埋。 */
function buildStonePath() {
  const slabGeo = new THREE.PlaneGeometry(1, 1);
  const slabMat = addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.78, metalness: 0.02, envMapIntensity: 0.5,
  }), { kind: 'fine', repeat: 6, scale: 0.9 });

  let seed = 20261101;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const items = [];

  for (const def of PATHS) {
    const curve = new THREE.CatmullRomCurve3(
      def.pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'catmullrom', 0.5
    );
    const L = curve.getLength();
    const cols = def.w > 0.055 ? 4 : 3;
    const step = 0.020;
    const n = Math.max(3, Math.round(L / step));
    const slabW = (def.w * 0.98) / cols;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const p = curve.getPoint(u);
      const tg = curve.getTangent(u);
      const nx = -tg.z, nz = tg.x;
      const angle = Math.atan2(nx, nz);
      for (let c = 0; c < cols; c++) {
        // 相邻列轻微错缝，像真的铺装而不是网格
        const jitterAlong = ((c % 2) - 0.5) * step * 0.16;
        const t = (c + 0.5) / cols - 0.5;
        const off = t * def.w * 0.98;
        const x = p.x + nx * off + tg.x * jitterAlong;
        const z = p.z + nz * off + tg.z * jitterAlong;
        items.push({
          x, z, angle,
          w: slabW * 0.93,
          l: step * 0.86,
          shade: 0.88 + rnd() * 0.16,
        });
      }
    }
  }

  const inst = new THREE.InstancedMesh(slabGeo, slabMat, items.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const col = new THREE.Color();
  const tq = new THREE.Quaternion();
  const upAxis = new THREE.Vector3(0, 1, 0);

  items.forEach((it, i) => {
    /* 平面先放平（绕 X 轴 -90°），再绕世界 Y 轴转到路径方向。
       顺序必须是"先放平后转向"，反过来会把片子立起来。 */
    q.setFromEuler(e.set(-Math.PI / 2, 0, 0));
    q.premultiply(tq.setFromAxisAngle(upAxis, it.angle));
    // 只比雪面高 0.0012，避免 z-fighting 又不会浮起来
    v.set(it.x, surfY(Math.hypot(it.x, it.z)) + 0.0012, it.z);
    sc.set(it.w, it.l, 1);
    m4.compose(v, q, sc);
    inst.setMatrixAt(i, m4);
    col.setRGB(0.60 * it.shade, 0.60 * it.shade, 0.585 * it.shade);
    inst.setColorAt(i, col);
  });
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.receiveShadow = CFG.shadows;
  globe.add(inst);
  disposables.push(slabGeo, slabMat);
  return items.length;
}

/* ============================== 摩天轮 ============================== */

const ferris = {
  group: new THREE.Group(),
  wheel: new THREE.Group(),
  cabins: [],
  radius: 0.28,
  hubY: 0,
};

function buildFerris() {
  const px = 0.40, pz = -0.30;
  const baseY = groundY(px, pz);
  const hubY = baseY + 0.40;
  ferris.hubY = hubY;
  ferris.group.position.set(px, 0, pz);

  /* 2026-11-03 真实感重做（含两次试错记录）：
     1) 原参数 metalness 0.30 / roughness 0.64 → 实测辐条 214~255（近纯白），
        整座钢架一片均匀浅灰，像塑料。
     2) 调到金属度 0.92 / 基色 #1e2c3d → 又变成纯黑剪影：金属度太高时
        漫反射趋近 0，夜景里只剩反射，环境光不够就全黑。
     最终取中间值：保住漫反射让结构可读，同时用 roughnessMap 打破均匀反光，
     这才是"夜间钢铁"该有的样子。 */
  const steelRough = makeSteelRoughMap();
  const metal = new THREE.MeshStandardMaterial({
    color: 0x486077,            // 中深蓝灰：可见但不过亮
    metalness: 0.55,
    roughness: 0.50,
    roughnessMap: steelRough,   // 粗糙度斑驳：打破"均匀反光"
    envMapIntensity: 0.55,
    emissive: 0x0a1320,
    emissiveIntensity: 0.22,    // 一点点自发光，保证背光面不是死黑
  });
  metal.normalMap = makeDetailTex('fine').clone();
  metal.normalMap.repeat.set(14, 14);
  metal.normalMap.needsUpdate = true;
  metal.normalScale = new THREE.Vector2(0.35, 0.35);
  metal.needsUpdate = true;

  /* 细杆专用材质：辐条/拉索的直径只有 1.6~2.2mm，屏幕上就几个像素宽，
     镜面高光会直接打满整个像素 → 实测 p95 达 255（纯白），
     和深色的轮缘形成刺眼反差。给它们更粗的粗糙度、更低的反射，压成暗钢色。 */
  const thinMetal = metal.clone();
  thinMetal.color = new THREE.Color(0x2f4459);
  thinMetal.roughness = 0.72;
  thinMetal.metalness = 0.40;
  thinMetal.envMapIntensity = 0.30;
  thinMetal.needsUpdate = true;
  const warm = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0xf2c879, emissive: 0xffb14d, emissiveIntensity: 1.15, roughness: 0.4 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  ferris.warmMat = warm;

  // 支架：分段从 10 提到 16，近看不再是多边形柱
  const legGeo = new THREE.CylinderGeometry(0.009, 0.013, hubY - baseY, 16);
  const positions = [[-0.17, 0.06], [0.17, 0.06], [-0.13, -0.08], [0.13, -0.08]];
  positions.forEach(([lx, lz]) => {
    const leg = new THREE.Mesh(legGeo, metal);
    const top = new THREE.Vector3(0, hubY, 0);
    const bot = new THREE.Vector3(lx, baseY, lz);
    leg.position.copy(top.clone().add(bot).multiplyScalar(0.5));
    const dir = top.clone().sub(bot);
    leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    leg.castShadow = CFG.shadows;
    ferris.group.add(leg);
  });
  // 支架脚垫
  positions.forEach(([lx, lz]) => {
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.030, 0.014, 12), metal);
    pad.position.set(lx, baseY + 0.006, lz);
    ferris.group.add(pad);
  });

  // 横撑
  const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.36, 8), metal);
  brace.rotation.z = Math.PI / 2;
  brace.position.set(0, baseY + 0.15, 0.06);
  ferris.group.add(brace);

  /* 2026-11-03 结构补充：原来自行车架般的 4 条腿 + 1 根横撑，
     缺少真实摩天轮该有的斜拉与交叉支撑，所以显得单薄像玩具。
     这里补三组结构件：腿间交叉斜撑、轮轴侧向支撑、以及脚垫之间的拉杆。 */
  const strutGeo = new THREE.CylinderGeometry(0.0042, 0.0042, 1, 6);
  const addStrut = (a, b) => {
    const m = new THREE.Mesh(strutGeo, metal);
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    m.position.copy(a).addScaledVector(dir, 0.5);
    m.scale.y = len;
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    m.castShadow = CFG.shadows;
    ferris.group.add(m);
  };
  // 前后两对腿之间的交叉斜撑（X 形）
  const legTops = positions.map(([lx, lz]) => new THREE.Vector3(lx, baseY + (hubY - baseY) * 0.42, lz));
  const legBots = positions.map(([lx, lz]) => new THREE.Vector3(lx, baseY + 0.01, lz));
  for (let i = 0; i < positions.length; i++) {
    const j = (i + 1) % positions.length;
    // 交叉：A 根底 → B 根顶
    addStrut(legBots[i], legTops[j]);
    addStrut(legBots[j], legTops[i]);
  }
  // 轮轴两侧的斜撑（从腿顶伸到轮轴）
  const hubPt = new THREE.Vector3(0, hubY, 0);
  positions.forEach((_, i) => {
    addStrut(legTops[i], hubPt);
  });

  // 轮盘
  ferris.wheel.position.y = hubY;
  ferris.group.add(ferris.wheel);

  /* ================= 轮盘重建（2026-11-03） =================
     原来：轮缘是 6 段截面的圆管，辐条是 5 边的、一根穿过去的整圆柱。
     贴脸看时轮缘是"多边形棱柱"、辐条是"六角棒"，一眼假。
     真实摩天轮的结构是：
       · 双轮缘（前后两圈）+ 中间桁架撑
       · 每根辐条是细长的张拉杆，从轮毂放射出去，不是穿透的一整根
       · 辐条与轮缘交接处有节点板
     这里按这个结构重建，并大幅提高圆管分段数。 */
  const RIM_R = 0.0045;          // 轮缘管半径（更纤细，减少"粗管"感）
  const RIM_TUBE_SEG = 96;       // 圆周分段
  const RIM_RADIAL_SEG = 14;     // 截面分段（原来只有 6，棱柱感来源）
  const rimGeo = new THREE.TorusGeometry(ferris.radius, RIM_R, RIM_RADIAL_SEG, RIM_TUBE_SEG);
  const RIM_HALF_GAP = 0.030;    // 前后轮缘的间距一半
  [-RIM_HALF_GAP, RIM_HALF_GAP].forEach(z => {
    const rim = new THREE.Mesh(rimGeo, metal);
    rim.position.z = z;
    rim.castShadow = CFG.shadows;
    ferris.wheel.add(rim);
  });

  // 前后轮缘之间的桁架横档（斜向交叉，不是简单的直杆）
  const crossGeo = new THREE.CylinderGeometry(0.0022, 0.0022, 1, 8);
  const CROSS_N = 36;
  for (let i = 0; i < CROSS_N; i++) {
    const a0 = (i / CROSS_N) * Math.PI * 2;
    const a1 = ((i + 1) / CROSS_N) * Math.PI * 2;
    const p0 = new THREE.Vector3(Math.cos(a0) * ferris.radius, Math.sin(a0) * ferris.radius, -RIM_HALF_GAP);
    const p1 = new THREE.Vector3(Math.cos(a1) * ferris.radius, Math.sin(a1) * ferris.radius, RIM_HALF_GAP);
    // 之字形：一半正向一半反向，形成桁架
    const [A, B] = (i % 2 === 0) ? [p0, p1] : [p0.clone().setZ(RIM_HALF_GAP), p1.clone().setZ(-RIM_HALF_GAP)];
    const c = new THREE.Mesh(crossGeo, thinMetal);
    const dir = new THREE.Vector3().subVectors(B, A);
    c.position.copy(A).addScaledVector(dir, 0.5);
    c.scale.y = dir.length();
    c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    ferris.wheel.add(c);
  }

  /* 辐条：从"轮毂法兰"放射到轮缘，每根单独建。
     2026-11-03 修正：原来 12 根（前后各 12）全部汇聚到 (0,0,z) 一个点，
     16 条线挤成一团，从正面看是一团放射状光锥，非常刺眼。
     真实摩天轮的辐条是接到轮毂外圈的法兰（有半径的环）上的，
     所以这里让辐条起点落在半径 HUB_R 的圆周上，并且减少数量（每侧 10 根），
     既保留结构感，又不会在中心糊成一团。 */
  const SPOKE_N = 10;
  const HUB_R = 0.026;                       // 轮毂法兰半径（辐条起点圆）
  const spokeLen = ferris.radius - HUB_R;
  const spokeGeo = new THREE.CylinderGeometry(0.0016, 0.0024, spokeLen, 8);
  const HUB_GAP = 0.026;                     // 前后两片辐条平面的间距一半
  [-HUB_GAP, HUB_GAP].forEach((z, side) => {
    // 前后两片错开半个角度，避免正面看时重叠成一半数量
    const phase = side * (Math.PI / SPOKE_N);
    for (let i = 0; i < SPOKE_N; i++) {
      const a = (i / SPOKE_N) * Math.PI * 2 + phase;
      const s = new THREE.Mesh(spokeGeo, thinMetal);
      s.rotation.z = a - Math.PI / 2;
      const midR = HUB_R + spokeLen * 0.5;
      s.position.set(Math.cos(a) * midR, Math.sin(a) * midR, z);
      s.castShadow = CFG.shadows;
      ferris.wheel.add(s);
    }
  });

  // 轮毂法兰：一个有厚度的环，辐条接在它上面，中心不再是一堆线头
  const flangeGeo = new THREE.TorusGeometry(HUB_R, 0.0052, 12, 40);
  [-HUB_GAP, HUB_GAP].forEach(z => {
    const f = new THREE.Mesh(flangeGeo, thinMetal);
    f.position.z = z;
    ferris.wheel.add(f);
  });

  /* 2026-11-03 真实感：真实摩天轮在辐条之间还有一圈"次轮缘"和交叉拉索，
     这是让轮子看起来是"结构"而不是"自行车轮"的关键。
     这里加两样：
       1. 中圈（半径约 0.62R 的细环）
       2. 辐条之间的 Z 字形细拉索（连中圈与轮缘）
     它们都很细，不抢主体，但大幅提升结构的可信度。 */
  const midR = ferris.radius * 0.62;
  const midRimGeo = new THREE.TorusGeometry(midR, 0.0022, 8, 72);
  [-HUB_GAP, HUB_GAP].forEach(z => {
    const m = new THREE.Mesh(midRimGeo, thinMetal);
    m.position.z = z;
    ferris.wheel.add(m);
  });
  // 中圈到轮缘的 Z 字形拉索（每个扇区一根）
  const tieGeo = new THREE.CylinderGeometry(0.0012, 0.0012, 1, 5);
  const tieCount = SPOKE_N * 2;
  [-HUB_GAP, HUB_GAP].forEach((z, side) => {
    const phase = side * (Math.PI / SPOKE_N);
    for (let i = 0; i < tieCount; i++) {
      const a0 = (i / tieCount) * Math.PI * 2 + phase;
      const a1 = ((i + 1) / tieCount) * Math.PI * 2 + phase;
      const A = new THREE.Vector3(Math.cos(a0) * midR, Math.sin(a0) * midR, z);
      const B = new THREE.Vector3(Math.cos(a1) * ferris.radius, Math.sin(a1) * ferris.radius, z);
      const t = new THREE.Mesh(tieGeo, thinMetal);
      const dir = new THREE.Vector3().subVectors(B, A);
      t.position.copy(A).addScaledVector(dir, 0.5);
      t.scale.y = dir.length();
      t.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      ferris.wheel.add(t);
    }
  });

  // 辐条与轮缘的节点板：每根辐条端点一块小方板，去掉"杆子插进圆管"的假感
  const gussetGeo = new THREE.BoxGeometry(0.009, 0.009, 0.0050);
  [-HUB_GAP, HUB_GAP].forEach((z, side) => {
    const phase = side * (Math.PI / SPOKE_N);
    for (let i = 0; i < SPOKE_N; i++) {
      const a = (i / SPOKE_N) * Math.PI * 2 + phase;
      const g = new THREE.Mesh(gussetGeo, metal);
      g.position.set(Math.cos(a) * (ferris.radius - 0.004), Math.sin(a) * (ferris.radius - 0.004), z);
      g.rotation.z = a;
      ferris.wheel.add(g);
    }
  });
  /* 注意：这里原来还有一组"轮毂到内圈的短撑"，8 根全部穿过轮轴中心。
     它们和辐条一起在中心叠成高亮光锥，是"辐条糊成一团"的主因之一，已删除。 */

  // 端点灯：挂在轮缘外侧
  const bulbGeo = new THREE.SphereGeometry(0.0085, 12, 10);
  for (let i = 0; i < SPOKE_N; i++) {
    const a = (i / SPOKE_N) * Math.PI * 2 + 0.12;
    const b = new THREE.Mesh(bulbGeo, warm);
    b.position.set(Math.cos(a) * ferris.radius, Math.sin(a) * ferris.radius, RIM_HALF_GAP + 0.0075);
    ferris.wheel.add(b);
    ferris.bulbs = ferris.bulbs || [];
    ferris.bulbs.push(b);
  }

  // 轮毂：三段式（两侧轴承 + 中间鼓），半径与法兰一致，不遮挡辐条起点
  const hubOuter = new THREE.Mesh(new THREE.CylinderGeometry(HUB_R * 0.78, HUB_R * 0.78, 0.020, 24), metal);
  hubOuter.rotation.x = Math.PI / 2;
  hubOuter.position.z = -HUB_GAP - 0.008;
  ferris.wheel.add(hubOuter);
  const hubOuter2 = hubOuter.clone();
  hubOuter2.position.z = HUB_GAP + 0.008;
  ferris.wheel.add(hubOuter2);
  const hubMid = new THREE.Mesh(new THREE.CylinderGeometry(HUB_R * 0.70, HUB_R * 0.70, 0.026, 28), metal);
  hubMid.rotation.x = Math.PI / 2;
  ferris.wheel.add(hubMid);

  const lamp = new THREE.PointLight(0xffb968, 0.18, 1.35, 2);
  lampLight = lamp;
  lamp.position.set(0, hubY, 0);
  ferris.group.add(lamp);

  // 摩天轮脚下的地灯：把背光那片死黑变成"有人的暗部"
  const glMat = addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0xffe3b8, emissive: 0xffab48, emissiveIntensity: 2.4, roughness: 0.45,
  }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const postMat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0x4b5a6b, roughness: 0.8, metalness: 0.3 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const glGeo = new THREE.SphereGeometry(0.0105, 10, 8);
  const postGeo = new THREE.CylinderGeometry(0.0026, 0.0032, 0.030, 6);
  [[-0.20, 0.02], [0.21, -0.03], [0.02, -0.20]].forEach(([gx, gz]) => {
    const wx = ferris.group.position.x + gx;
    const wz = ferris.group.position.z + gz;
    const gy2 = groundY(wx, wz);
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(wx, gy2 + 0.015, wz);
    post.castShadow = CFG.shadows;
    globe.add(post);
    const glow = new THREE.Mesh(glGeo, glMat);
    glow.position.set(wx, gy2 + 0.034, wz);
    globe.add(glow);
  });
  const footLight = new THREE.PointLight(0xffbe7e, 0.030, 0.55, 2);
  footLight.position.set(ferris.group.position.x, groundY(px, pz) + 0.14, ferris.group.position.z - 0.05);
  globe.add(footLight);
  disposables.push(glMat, postMat, glGeo, postGeo);

  registerKind(ferris.group, 'ferris', '摩天轮');
  globe.add(ferris.group);
  disposables.push(metaGeo(rimGeo), spokeGeo, bulbGeo);
}

function metaGeo(g) { return g; }

function attachGondolas(template) {
  const N = 6;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const pivot = new THREE.Group();
    pivot.position.set(Math.cos(a) * ferris.radius, Math.sin(a) * ferris.radius, 0);
    const clone = template.clone(true);
    // 让吊舱顶部挂在轮缘上
    clone.position.y = -template.userData.height;
    pivot.add(clone);
    // 轿厢里的小乘客：剪影 + 一点暖光
    const rider = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.006, 0.010, 3, 6),
      addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.8, metalness: 0 }), { kind: 'fine', repeat: 7, scale: 0.75 })
    );
    rider.position.set(0, -template.userData.height + 0.014, 0);
    pivot.add(rider);
    const rl = new THREE.Mesh(
      new THREE.SphereGeometry(0.0022, 6, 5),
      addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffb14d, emissiveIntensity: 2.2, roughness: 0.4 }), { kind: 'fine', repeat: 7, scale: 0.75 })
    );
    rl.position.set(0, -template.userData.height + 0.034, 0.004);
    pivot.add(rl);
    ferris.wheel.add(pivot);
    ferris.cabins.push({ pivot, baseAngle: a, clone });
  }
}

/* ============================== 资产 ============================== */

const loader = new GLTFLoader();
const loaded = {};

function normalize(gltf, targetH, alignZ = false) {
  const root = gltf.scene;
  let box = new THREE.Box3().setFromObject(root);
  let size = box.getSize(new THREE.Vector3());
  if (alignZ && size.x > size.z * 1.15) {
    root.rotation.y = Math.PI / 2;
    box = new THREE.Box3().setFromObject(root);
    size = box.getSize(new THREE.Vector3());
  }
  const center = box.getCenter(new THREE.Vector3());
  const s = targetH / Math.max(size.y, 1e-5);
  root.scale.setScalar(s);
  root.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  const wrap = new THREE.Group();
  wrap.add(root);
  wrap.userData.height = targetH;
  wrap.userData.clips = gltf.animations || [];
  wrap.userData.radius = Math.max(size.x, size.z) * s * 0.5;
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = CFG.shadows;
    o.receiveShadow = CFG.shadows;
    const m = o.material;
    if (!m) return;
    m.envMapIntensity = 0.95;
    m.side = THREE.FrontSide;
    // 各向异性过滤：默认 1 的时候，墙面/地板只要斜着看就会被 mip 糊成一片，
    // 这是"近看糊"最容易被忽略的一条
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
      const t = m[key];
      if (!t) continue;
      if (t.anisotropy < 8) t.anisotropy = aniso();
      /* 2026-11-03：贴地/贴脸看时，mipmap 会选到更模糊的级别 —— 木屋的木纹
         在这个距离下本该清晰，却被 mip 抹平了。negative LOD bias 让采样
         偏向更清晰的层级，代价是远处可能有轻微闪烁，但场景尺度小、无影响。 */
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.needsUpdate = true;
      m.needsUpdate = true;
    }
  });
  return wrap;
}

// 单文件版会把模型以 base64 内联到 window.__EMBED，避免 file:// 下的 fetch 限制
function b64ToBuffer(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function loadModel(name) {
  const file = MODELS[name].file || name;
  const done = (gltf) => {
    if (MODELS[name].noNormalize) {
      // 已经按世界尺寸烘好的资源（如带骨骼的角色），直接用原场景
      const wrap = new THREE.Group();
      wrap.add(gltf.scene);
      wrap.userData.clips = gltf.animations || [];
      wrap.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = CFG.shadows;
        o.receiveShadow = CFG.shadows;   // 屋顶/雪堆/木料也要接投影，否则影子只有地面能显示
        const m = o.material;
        if (!m) return;
        m.envMapIntensity = 0.9;
        // 法线/粗糙度需要斜看也清楚：glTF 载进来的贴图默认 anisotropy=1，靠近地面看会糊成一片
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) {
          const t = m[key];
          if (t) {
            t.anisotropy = aniso();
            t.needsUpdate = true;
          }
        }
      });
      loaded[name] = wrap;
    } else {
      loaded[name] = normalize(gltf, MODELS[name].h, !!MODELS[name].alignZ);
    }
    return loaded[name];
  };
  return new Promise((resolve) => {
    const embed = window.__EMBED;
    if (embed && embed[file]) {
      try {
        loader.parse(b64ToBuffer(embed[file]), '', (gltf) => resolve(done(gltf)),
          (e) => { console.warn('模型解析失败', name, e); resolve(null); });
      } catch (e) {
        console.warn('模型解析异常', name, e); resolve(null);
      }
      return;
    }
    loader.load(
      `./assets/opt/${file}.glb`,
      (gltf) => resolve(done(gltf)),
      undefined,
      (e) => { console.warn('模型加载失败', name, e); resolve(null); }
    );
  });
}

async function loadAll(onProgress) {
  const names = Object.keys(MODELS);
  let done = 0;
  await Promise.all(names.map(n => loadModel(n).then(m => {
    done++;
    onProgress(done / names.length);
    return m;
  })));
}

function place(obj, x, z, rotY = 0, yOff = 0, sink = 0) {
  if (!obj) return null;
  const o = obj.clone(true);
  o.position.set(x, groundY(x, z) - sink + yOff, z);
  o.rotation.y = rotY;
  globe.add(o);
  return o;
}


/* ---------------- 细节：接触影、雪堆、脚印、炊烟 ---------------- */

let shadowTex = null;
function getShadowTex() {
  if (shadowTex) return shadowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(0,0,0,0.85)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.42)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  shadowTex = new THREE.CanvasTexture(c);
  return shadowTex;
}

/* 鞋印贴图：前掌（宽椭圆）+ 后跟（小椭圆）+ 中间收窄的腰。
   第一人称贴地看时，有形状的鞋印能让雪面立刻"有人来过"。 */
let footTex = null;
function getFootprintTex() {
  if (footTex) return footTex;
  const W = 64, H = 112;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  const blur = 'rgba(0,0,0,0.85)';

  // 前掌：稍宽、靠下（画布 y 方向对应脚趾到后跟）
  g.fillStyle = blur;
  g.beginPath();
  g.ellipse(W * 0.5, H * 0.30, W * 0.32, H * 0.19, 0, 0, Math.PI * 2);
  g.fill();
  // 中腰：收窄
  g.beginPath();
  g.ellipse(W * 0.5, H * 0.52, W * 0.21, H * 0.11, 0, 0, Math.PI * 2);
  g.fill();
  // 后跟：小而圆
  g.beginPath();
  g.ellipse(W * 0.5, H * 0.74, W * 0.25, H * 0.15, 0, 0, Math.PI * 2);
  g.fill();

  // 边缘做一点羽化，避免像贴纸
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  const soft = new Uint8ClampedArray(d.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 3x3 均值模糊 alpha
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          sum += d[(ny * W + nx) * 4 + 3]; n++;
        }
      }
      const o = (y * W + x) * 4;
      soft[o] = d[o]; soft[o + 1] = d[o + 1]; soft[o + 2] = d[o + 2];
      soft[o + 3] = sum / n;
    }
  }
  g.putImageData(new ImageData(soft, W, H), 0, 0);

  footTex = new THREE.CanvasTexture(c);
  footTex.anisotropy = aniso();
  return footTex;
}

function addContact(x, z, r, opacity = 0.42) {
  const mat = new THREE.MeshBasicMaterial({
    map: getShadowTex(), transparent: true, opacity,
    depthWrite: false, color: 0x08101c,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, r * 2), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, groundY(x, z) + 0.004, z);
  globe.add(m);
}

let snowMoundMat = null;
function addDrift(x, z, rx, h, rz) {
  if (!snowMoundMat) {
    // 0xffffff 的雪堆和 0.62 亮度的雪地不是一个明度层，会浮在上面像贴纸
    snowMoundMat = addSurfaceDetail(new THREE.MeshStandardMaterial({
      color: 0xd6dfe9, roughness: 0.92, metalness: 0, envMapIntensity: 0.42,
    }), { kind: 'fine', repeat: 7, scale: 0.75 });
  }
  const geo = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2);
  const m = new THREE.Mesh(geo, snowMoundMat);
  m.scale.set(rx, h, rz || rx * 0.86);
  m.rotation.y = Math.random() * Math.PI;
  m.position.set(x, groundY(x, z) - h * 0.55, z);
  m.receiveShadow = CFG.shadows;
  globe.add(m);
}

function addFootprints(from, to, count = 12) {
  /* 2026-11-03：脚印不再用"灰色椭圆片"。之前的做法是一串明显的深色块，
     放大看就是一堆脏点。现在改成极淡的雪面压痕：颜色接近雪本身，
     只靠一点点明暗差暗示"这里被人踩过"。 */
  const mat = new THREE.MeshBasicMaterial({
    map: getFootprintTex(), transparent: true, opacity: 0.075,
    depthWrite: false, color: 0x6b7f99,
  });
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const x = from[0] + (to[0] - from[0]) * t + Math.sin(t * 9) * 0.018;
    const z = from[1] + (to[1] - from[1]) * t + Math.cos(t * 7) * 0.012;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.014, 0.028), mat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = (i % 2 ? 1 : -1) * 0.28 + Math.random() * 0.1;
    m.position.set(x, groundY(x, z) + 0.0016, z);
    globe.add(m);
  }
}

function addChimneySmoke(parent) {
  const geo = new THREE.PlaneGeometry(1, 1);
  const list = [];
  for (let i = 0; i < 6; i++) {
    const mat = new THREE.MeshBasicMaterial({
      map: getShadowTex(), transparent: true, opacity: 0,
      depthWrite: false, color: 0xdce9f7, blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(0.10, 0.30, 0.02);
    m.renderOrder = 2;
    parent.add(m);
    list.push({ mesh: m, t: i / 6 });
  }
  animated.push({ type: 'smoke', list });
}


function addPines() {
  /* 2026-11-03：原来这里是 4 棵"7 边锥体叠 4 层"的程序化松树，
     近看就是纸折金字塔，和旁边 5.6 万面的木屋/长椅完全不是一个精度层。
     现在改成用真实模型 tree-a / tree-b，按层次摆放并做尺寸/旋转变化。 */
  const defs = [
    { x: -0.12, z: -0.46, h: 0.21, rot: 0.4, file: 'tree' },
    { x:  0.13, z: -0.50, h: 0.17, rot: 1.3, file: 'treeB' },
    { x: -0.33, z: -0.40, h: 0.15, rot: 2.1, file: 'tree' },
    { x:  0.35, z: -0.47, h: 0.14, rot: 0.8, file: 'treeB' },
  ];
  defs.forEach((d) => {
    const src = loaded[d.file] || loaded.tree;
    if (!src) return;
    const o = src.clone(true);
    const s = d.h / (src.userData.height || 0.23);
    o.scale.setScalar(s);
    o.position.set(d.x, groundY(d.x, d.z), d.z);
    o.rotation.y = d.rot;
    o.traverse((n) => {
      if (!n.isMesh) return;
      n.castShadow = CFG.shadows;
      n.receiveShadow = CFG.shadows;
      /* 树上的雪团是模型自带的纯白球状几何，环境反射拉满会过曝成
         一颗颗发光的白球。这里对树单独压低反射与亮度。
         注意：clone(true) 共享材质，必须克隆材质再改，否则会污染原来那棵树。 */
      if (Array.isArray(n.material)) {
        n.material = n.material.map((m) => (m ? m.clone() : m));
      } else if (n.material) {
        n.material = n.material.clone();
      }
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      mats.forEach((m) => {
        if (!m) return;
        m.envMapIntensity = 0.35;
        if (m.color) m.color.multiplyScalar(0.86);
      });
    });
    globe.add(o);
    addContact(d.x, d.z, d.h * 0.30, 0.26);
  });
}


/* ---------------- 踩实的雪路 ---------------- */

let pathTex = null;
function getPathTex() {
  if (pathTex) return pathTex;
  const W = 96, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0.00, 'rgba(66,82,104,0)');
  g.addColorStop(0.14, 'rgba(70,86,108,0.55)');
  g.addColorStop(0.32, 'rgba(78,95,118,0.92)');
  g.addColorStop(0.50, 'rgba(84,101,124,0.95)');
  g.addColorStop(0.68, 'rgba(78,95,118,0.92)');
  g.addColorStop(0.86, 'rgba(70,86,108,0.55)');
  g.addColorStop(1.00, 'rgba(66,82,104,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);

  // 两道被踩实的浅辙
  for (const cx of [0.33, 0.67]) {
    const rg = x.createLinearGradient((cx - 0.11) * W, 0, (cx + 0.11) * W, 0);
    rg.addColorStop(0, 'rgba(150,170,192,0)');
    rg.addColorStop(0.5, 'rgba(150,170,192,0.16)');
    rg.addColorStop(1, 'rgba(150,170,192,0)');
    x.fillStyle = rg;
    x.fillRect((cx - 0.11) * W, 0, 0.22 * W, H);
  }
  // 颗粒：踩碎的小雪块与压痕
  for (let i = 0; i < 1400; i++) {
    const px = Math.random() * W, py = Math.random() * H;
    const a = Math.random() * 0.13;
    x.fillStyle = Math.random() > 0.45
      ? `rgba(255,255,255,${a})`
      : `rgba(132,152,176,${a})`;
    x.fillRect(px, py, 0.8 + Math.random() * 1.8, 0.8 + Math.random() * 2.4);
  }
  pathTex = new THREE.CanvasTexture(c);
  pathTex.colorSpace = THREE.SRGBColorSpace;
  pathTex.anisotropy = aniso();
  pathTex.wrapS = THREE.ClampToEdgeWrapping;
  pathTex.wrapT = THREE.RepeatWrapping;
  return pathTex;
}

// 向下打射线取雪面真实高度（雪面有噪声起伏，不能只用解析式）
let _groundMesh = null, hitCount = 0;
const _ray = new THREE.Raycaster();
const _down = new THREE.Vector3(0, -1, 0);
function groundAt(x, z) {
  if (!_groundMesh) {
    globe.traverse(o => { if (o.isMesh && o.userData.isGround) _groundMesh = o; });
  }
  if (!_groundMesh) return surfY(Math.hypot(x, z)) + 0.020;
  _ray.set(new THREE.Vector3(x, 1.2, z), _down);
  const hit = _ray.intersectObject(_groundMesh, false);
  if (hit.length) hitCount++;
  return hit.length ? hit[0].point.y + 0.004 : surfY(Math.hypot(x, z)) + 0.020;
}

function buildPaths() {
  const mat = new THREE.MeshStandardMaterial({
    map: getPathTex(), color: 0xffffff, roughness: 1.0, metalness: 0,
    envMapIntensity: 0.2, transparent: true, depthWrite: false, depthTest: true,
    side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  disposables.push(mat);

  for (const def of PATHS) {
    const curve = new THREE.CatmullRomCurve3(
      def.pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'catmullrom', 0.5
    );
    const N = 110, M = 5, halfW = def.w / 2;
    const pos = [], uv = [], idx = [];
    // 先算路径中心线，再沿法向多点采样雪面高度，逐点贴合起伏
    const spine = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const pt = curve.getPoint(t);
      const tg = curve.getTangent(t);
      let nx = -tg.z, nz = tg.x;
      const l = Math.hypot(nx, nz) || 1;
      const taper = Math.min(1, Math.min(t, 1 - t) / 0.12);
      spine.push({ x: pt.x, z: pt.z, nx: nx / l, nz: nz / l, t,
                   w: halfW * (0.35 + 0.65 * taper) });
    }
    for (let i = 0; i <= N; i++) {
      const sp = spine[i];
      for (let j = 0; j < M; j++) {
        const u = j / (M - 1);            // 0..1 横向
        const off = (u - 0.5) * 2 * sp.w;
        const x = sp.x + sp.nx * off;
        const z = sp.z + sp.nz * off;
        pos.push(x, groundAt(x, z) + 0.006, z);
        uv.push(u, sp.t * 5.0);
      }
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < M - 1; j++) {
        const a = i * M + j, b = a + 1, c = a + M, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    globe.add(mesh);
    window.__pchk = {
      hit: geo.attributes.position.getY(0).toFixed(3),
      surf: surfY(Math.hypot(def.pts[0][0], def.pts[0][1])).toFixed(3),
      found: !!_groundMesh,
      n: hitCount,
    };
  }
}


/* ---------------- 主角：坐在冰湖上钓鱼（?skate=1 滑冰 / ?walk=1 沿街走） ---------------- */

const HERO_H = 0.158;   // 角色目标高度（世界单位）

const hero = {
  wrap: null, mixer: null, action: null,
  curve: null, len: 1, t: 0.27, dir: 1,
  speed: 0.023, wait: 0, shadow: null, hop: 0, groundOffset: 0,
  mode: 'fish',
  ang: 0.55, omega: 0.80,     // 滑冰用的绕圈角度 / 角速度
  fish: null,
};

// 把 bone 的“骨轴”（指向子骨骼）对齐到指定方向：用于把 T/A-pose 掰成坐姿
function aimBone(bone, child, dx, dy, dz) {
  if (!bone || !child) return;
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  bone.updateWorldMatrix(true, false);
  child.updateWorldMatrix(true, false);
  bone.getWorldPosition(a);
  child.getWorldPosition(b);
  const cur = b.sub(a);
  if (cur.lengthSq() < 1e-12) return;
  cur.normalize();
  const want = new THREE.Vector3(dx, dy, dz).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(cur, want);
  const pq = new THREE.Quaternion();
  bone.parent.getWorldQuaternion(pq);
  const wq = new THREE.Quaternion();
  bone.getWorldQuaternion(wq);
  bone.quaternion.copy(pq.invert().multiply(q.multiply(wq)));
  bone.updateMatrixWorld(true);
}

// 坐姿：大腿水平、小腿垂下、双手前伸握竿
function sitPose(obj, yaw) {
  const B = (n) => obj.getObjectByName(n);
  /* 2026-11-04：aimBone 的 (dx,dy,dz) 是**世界坐标**方向，而 sitPose 是在
     wrap.rotation 设置之后调用的，所以"角色前方"在世界里不是 +Z。
     实测：双手因此落在身体后方 22mm（应该在前方 30mm+）。
       模型面朝 -Z => 世界前方 FW = (-sin yaw, 0, -cos yaw)
       世界右方 RT = FW × UP（右手定则叉积），不是简单的 (cos yaw, -sin yaw)：
         上次用错公式，导致左右手互换、双手仍在身后。 */
  const _yaw = (typeof yaw === 'number') ? yaw : 0;
  const FW = { x: -Math.sin(_yaw), z: -Math.cos(_yaw) };   // 角色前方（世界, xz 分量）
  // RT = FW × (0,1,0) => (FW.z, 0, -FW.x)
  const RT = { x: FW.z, z: -FW.x };                        // 角色右方（世界, xz 分量）
  // 把"身体坐标系"的 (fwd, right, up) 转成世界方向
  const bodyDir = (fwd, right, up) => ({
    x: FW.x * fwd + RT.x * right,
    y: up,
    z: FW.z * fwd + RT.z * right,
  });
  const P = (n) => {
    const b = B(n);
    return b && b.parent && b.parent.isBone ? b.parent : b;
  };
  const alias = (name, fallback) => B(name) || (fallback ? B(fallback) : null);
  /* 2026-11-04 关键：aimBone 用世界坐标，所以调用前必须让 wrap 已经转到
     最终朝向，否则"身体坐标系"和"世界坐标系"对不上，手臂会拐到背后。
     这里先把父级 Group 的 Y 旋转设成 sitYaw 并刷新矩阵。 */
  {
    const gp = obj.parent;   // wrap
    if (gp && typeof _yaw === 'number') {
      gp.rotation.set(0, _yaw, 0);
      gp.updateMatrixWorld(true);
    }
  }
  const r = {
    hips: B('Hips'), spine: B('Spine'), spine1: B('Spine1'),
    spine2: alias('Spine2', 'Spine1'),
    neck: B('Neck'), head: B('Head'),
    // 腿：用父级（L_Thigh / R_Thigh）才能真正带动大腿
    lUp: P('LeftUpLeg'), lLeg: P('LeftLeg'), lFoot: B('LeftFoot'),
    lToe: alias('LeftToeBase', 'LeftFoot'),
    rUp: P('RightUpLeg'), rLeg: P('RightLeg'), rFoot: B('RightFoot'),
    rToe: alias('RightToeBase', 'RightFoot'),
    // 手臂：用父级（L_Upperarm / L_Forearm）才能真正带动上臂
    lArm: P('LeftArm'), lFore: P('LeftForeArm'), lHand: B('LeftHand'),
    rArm: P('RightArm'), rFore: P('RightForeArm'), rHand: B('RightHand'),
  };
  if (Object.keys(r).some((k) => !r[k])) return null;

  obj.updateMatrixWorld(true);
  const ankle0 = Math.min(
    r.lFoot.getWorldPosition(new THREE.Vector3()).y,
    r.rFoot.getWorldPosition(new THREE.Vector3()).y
  );

  // 躯干：保持竖直，只给极轻微前倾（世界坐标，与朝向无关）
  aimBone(r.spine, r.spine1, 0, 1.00, 0.06);
  aimBone(r.spine1, r.spine2, 0, 1.00, 0.06);
  aimBone(r.spine2, r.neck, 0, 0.99, 0.14);
  aimBone(r.neck, r.head, 0, 0.99, 0.14);

  /* 腿：用身体坐标系给方向（fwd=身体前方, right=身体右方, up=向上）
     大腿：向前 + 略微外张 + 水平；小腿：垂直向下 */
  const lThigh = bodyDir(1.0, 0.18, 0.0);
  const lShin = bodyDir(0.02, 0.0, -1.0);
  const rThigh = bodyDir(1.0, -0.18, 0.0);
  const rShin = bodyDir(0.02, 0.0, -1.0);
  aimBone(r.lUp, r.lLeg, lThigh.x, lThigh.y, lThigh.z);
  aimBone(r.lLeg, r.lFoot, lShin.x, lShin.y, lShin.z);
  aimBone(r.lFoot, r.lToe, 0.02, -0.10, 0.99);
  aimBone(r.rUp, r.rLeg, rThigh.x, rThigh.y, rThigh.z);
  aimBone(r.rLeg, r.rFoot, rShin.x, rShin.y, rShin.z);
  aimBone(r.rFoot, r.rToe, -0.02, -0.10, 0.99);

  /* 2026-11-04 手臂（按实测差值重配）：
     实测问题：左手相对右手是 (前 -4, 右 +19, 上 +24)mm，
     而竿需要"左手比右手靠前 40mm+"。左手既没前伸又太偏右，
     导致竿只能斜穿身体 —— 这就是"鱼竿别扭"的根源。

     目标差值（左手 − 右手）：
       前 +42mm（前手握在前）
       右 -18mm（左手向中线收，不对着身体外侧）
       上  +6mm（几乎等高，仰角交给竿自己）
     因此：
       右手：垂在腹前偏右，前臂基本向下
       左手：向前伸出、略向内收、略抬 */
  const lUpper = bodyDir(0.62, -0.22, -0.75);   // 上臂向前+内收
  const lFore  = bodyDir(0.94, -0.22, 0.26);    // 前臂大角度前伸（关键：Z 分量给足）
  const rUpper = bodyDir(0.20, 0.16, -0.97);    // 右上臂几乎垂直向下、略外张
  const rFore  = bodyDir(0.42, 0.30, -0.86);    // 右前臂向下、靠后
  aimBone(r.lArm, r.lFore, lUpper.x, lUpper.y, lUpper.z);
  aimBone(r.lFore, r.lHand, lFore.x, lFore.y, lFore.z);
  aimBone(r.rArm, r.rFore, rUpper.x, rUpper.y, rUpper.z);
  aimBone(r.rFore, r.rHand, rFore.x, rFore.y, rFore.z);

  obj.updateMatrixWorld(true);
  return { bones: r, ankle0 };
}

/* 蒙皮网格在某一姿态下的最低世界 Y：直接遍历顶点、按骨骼权重重算，
   Box3.setFromObject 对 SkinnedMesh 不可信（它只看 bind pose） */
function lowestSkinnedY(root) {
  let mesh = null;
  root.traverse((o) => { if (!mesh && o.isSkinnedMesh) mesh = o; });
  if (!mesh) return NaN;
  mesh.updateMatrixWorld(true);
  if (mesh.skeleton) mesh.skeleton.update();   // 不刷新就还是 bind pose，脚会浮在冰面上方
  const pos = mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  const step = Math.max(1, Math.floor(pos.count / 6000));
  let min = Infinity;
  for (let i = 0; i < pos.count; i += step) {
    v.fromBufferAttribute(pos, i);
    mesh.applyBoneTransform(i, v);
    v.applyMatrix4(mesh.matrixWorld);
    if (v.y < min) min = v.y;
  }
  return min;
}

// 冰钓整套道具：木墩、冰洞、鱼竿、渔线、浮漂、水桶
function buildFishingGear(wrap, obj, pose) {
  const { bones, ankle0 } = pose;
  const V = (v) => v.clone();

  // 坐的位置：冰面近岸，面朝湖心
  const seatA = -1.12;   // 冰面远侧偏右：斜对着默认视角，坐姿读得出来
  const sx = pond.cx + Math.cos(seatA) * pond.rx * 0.72;
  const sz = pond.cz + Math.sin(seatA) * pond.rz * 0.72;
  const sy = surfY(Math.hypot(sx, sz)) + pond.lift;
  /* 2026-11-04 朝向最终修正（实测数据驱动）：
     曾经的做法是 yaw = atan2(pond.cx-sx, pond.cz-sz)，让身体"面朝湖心"。
     但实测发现：模型几何面朝 -Z，rotation.y=yaw 对应的世界朝向是
     (-sin(yaw), -cos(yaw))，于是 atan2(dx,dz) 算出来的 yaw 实际让角色
     **背对** 湖心 —— 实测 cos(脸, 指向冰洞) = -0.926，夹角 157.9°，
     完全背对，脸朝着岸上。
     正确做法：yaw = atan2(dx,dz) + π，这样脸才真正朝向冰洞/浮漂。 */
  const yaw = Math.atan2(pond.cx - sx, pond.cz - sz) + Math.PI;

  // 坐姿后脚踝位置 → 决定整体下沉量（脚掌落冰面）
  const soleDrop = ankle0 - (-hero.groundOffset);       // 站立时脚踝到脚底的距离
  const ankle1 = Math.min(
    bones.lFoot.getWorldPosition(new THREE.Vector3()).y,
    bones.rFoot.getWorldPosition(new THREE.Vector3()).y
  );
  /* 2026-11-04：fwd 必须和"模型脸朝向"一致。
     模型几何面朝 -Z，所以 rotation.y=yaw 时世界朝向是 (-sin, -cos)，
     不是 (+sin, +cos)。之前用了后者，导致：
       身体（靠 yaw）面朝湖心 ✓，但 fwd（鱼竿方向）反了 ✗ —— 鱼竿甩到身后。
     实测：冰洞 holeP=(-0.017,0.169) 落在角色背后，而角色在 (-0.042,0.324)，
     方向完全相反。 */
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));   // 角色真实朝向（面朝 -Z）
  const side = new THREE.Vector3(fwd.z, 0, -fwd.x);                   // 角色右手侧

  hero.groundOffset = -(ankle1 - soleDrop);
  wrap.position.set(sx, sy + hero.groundOffset, sz);
  wrap.rotation.set(0, yaw, 0);
  wrap.updateMatrixWorld(true);

  // 骨骼法算出来的鞋底位置在坐姿下会有偏差：直接采样蒙皮后的顶点，把最低点压到冰面上
  const minY = lowestSkinnedY(obj);
  if (Number.isFinite(minY)) {
    // 脚在身前，那里冰面比座位处更低（碗形），只用座位高度对齐会浮起来
    const yFoot = surfY(Math.hypot(sx + fwd.x * 0.05, sz + fwd.z * 0.05)) + pond.lift;
    wrap.position.y += Math.min(yFoot, sy) - minY - 0.0050;   // 咬进冰面，圆弧靴底才有落地感
    wrap.updateMatrixWorld(true);
  }


  const hipsW = bones.hips.getWorldPosition(new THREE.Vector3());
  const handW = bones.lHand.getWorldPosition(new THREE.Vector3())
    .add(bones.rHand.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);

  const snowMat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0xd6dfe9, roughness: 1.0, metalness: 0 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const woodMat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0x8a5f3c, roughness: 0.88, metalness: 0 }), { kind: 'wood', repeat: 4, scale: 1.15 });
  const darkWoodMat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0x5a3c26, roughness: 0.9, metalness: 0 }), { kind: 'wood', repeat: 4, scale: 1.15 });
  const metalMat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0x94a6b8, roughness: 0.45, metalness: 0.6 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const stumpMat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0x5f4530, roughness: 0.94, metalness: 0 }), { kind: 'wood', repeat: 4, scale: 1.15 });
  disposables.push(snowMat, woodMat, darkWoodMat, metalMat, stumpMat);

  // ---- 坐墩：小木桩 + 顶上一块雪 ----
  const seatTop = hipsW.y + 0.0035;
  const seatH = Math.max(0.012, seatTop - sy);
  // 树桩略宽，坐下时两侧能露出来，避免“悬空坐”
  const stumpR = 0.0185;
  const stump = new THREE.Mesh(new THREE.CylinderGeometry(stumpR, stumpR * 0.96, seatH, 16), stumpMat);
  stump.position.set(sx, sy + seatH * 0.5, sz);   // 细到正面被两腿夹住看不见，侧面还能读到支撑
  stump.castShadow = CFG.shadows;
  globe.add(stump);
  const stumpSnow = new THREE.Mesh(new THREE.CylinderGeometry(stumpR * 1.05, stumpR * 0.99, 0.0035, 16), snowMat);
  stumpSnow.position.set(sx, sy + seatH + 0.0015, sz);
  globe.add(stumpSnow);
  // 树皮上的雪
  const stumpSnow2 = new THREE.Mesh(new THREE.TorusGeometry(stumpR * 1.01, 0.0018, 6, 18), snowMat);
  stumpSnow2.rotation.x = Math.PI / 2;
  stumpSnow2.position.set(sx, sy + 0.004, sz);
  globe.add(stumpSnow2);

  // ---- 脚下踩实的积雪：靴底是圆弧，只靠对齐总会留一道缝，用雪盖住最自然 ----
  const snowMat2 = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0xe8f2fd, roughness: 1.0, metalness: 0 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  {
    // 以两只脚的真实世界位置为中心铺雪，而不是按座位往前推
    const feet = [bones.lFoot, bones.rFoot].map((b) => {
      const m = b.matrixWorld.elements;
      return { x: m[12], z: m[14] };
    });
    const spots = [
      [feet[0].x, feet[0].z, 0.020], [feet[1].x, feet[1].z, 0.020],
      [(feet[0].x + feet[1].x) / 2, (feet[0].z + feet[1].z) / 2, 0.022],
      [feet[0].x + fwd.x * 0.012, feet[0].z + fwd.z * 0.012, 0.014],
      [feet[1].x + fwd.x * 0.012, feet[1].z + fwd.z * 0.012, 0.014],
    ];
    spots.forEach(([px, pz, rr], i) => {
      const pile = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 7), snowMat2);
      pile.scale.set(rr, rr * 0.30, rr * 0.86);
      pile.position.set(px, surfY(Math.hypot(px, pz)) + pond.lift - rr * 0.10, pz);
      pile.rotation.y = i * 0.7;
      globe.add(pile);
    });
  }
  disposables.push(snowMat2);

  // ---- 接触影：坐姿下脚下与木墩底各一团，没有它看着就像浮在冰面上 ----
  const csMat = new THREE.MeshBasicMaterial({
    map: getShadowTex(), color: 0x08111c, transparent: true, opacity: 0.36, depthWrite: false,
  });
  const cs = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), csMat);
  cs.rotation.x = -Math.PI / 2;
  cs.scale.set(0.105, 0.080, 1);
  cs.position.set(sx + fwd.x * 0.052, sy - 0.0004, sz + fwd.z * 0.052);   // 压在两脚下方
  cs.renderOrder = 2;
  globe.add(cs);
  const cs2 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), csMat.clone());
  cs2.rotation.x = -Math.PI / 2;
  cs2.scale.set(0.055, 0.055, 1);
  cs2.position.set(sx, sy + 0.0009, sz);
  cs2.renderOrder = 2;
  globe.add(cs2);
  disposables.push(csMat, cs.geometry, cs2.material);

  /* ---- 竿先定（2026-11-04 重做）----
     原实现：竿的基座 = 右手位置再往右偏 15mm，导致
       右手离竿 15.0mm、左手离竿 8.9mm —— 两只手根本不在同一根竿上，
       竿像是"飘"在手边上。
     正确做法：竿身**穿过两只手**，握点取两手连线的中点，
     并且竿的朝向沿"两只手连线的延长线"走 —— 那才是真实握竿的姿态。
     这样无论手怎么动，竿都跟着手，不会脱开。 */
  const gripL = bones.lHand.getWorldPosition(new THREE.Vector3());
  const gripR = bones.rHand.getWorldPosition(new THREE.Vector3());
  const grip = gripR.clone().lerp(gripL, 0.42);
  const rodLen = 0.175;

  /* 2026-11-04 修正"竿穿身而过"：
     原来把 fwd 和 handAxis 混着用，handAxis（右手→左手）把方向带偏，
     导致竿朝身后斜伸、像抱着竿。
     正确做法：**竿只朝角色正前方**（fwd），因为鱼洞就在正前方。
     冰洞位置也不再从竿尖反推（那会形成循环依赖），
     而是直接定在角色正前方固定距离处，竿指向它。 */
  const pitch = 0.62;                                   // sin(38°)
  const horizK = Math.cos(Math.asin(pitch));
  const rodDir = new THREE.Vector3(fwd.x * horizK, pitch, fwd.z * horizK).normalize();

  // 冰洞：角色正前方 0.30m 处（用 fwd，跟着角色朝向走）
  const HOLE_DIST = 0.30;
  const holeP = new THREE.Vector3(
    sx + fwd.x * HOLE_DIST, 0, sz + fwd.z * HOLE_DIST
  );
  const holeY = surfY(Math.hypot(holeP.x, holeP.z)) + pond.lift + 0.0012;
  const holeMat = addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0x0c2233, roughness: 0.22, metalness: 0.2,
    emissive: 0x08131c, emissiveIntensity: 1.0,
  }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.0145, 28), holeMat);
  hole.rotation.x = -Math.PI / 2;
  hole.position.set(holeP.x, holeY, holeP.z);
  hole.renderOrder = 3;
  globe.add(hole);
  const rimMat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0xd6ebfa, roughness: 0.5, metalness: 0 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.0145, 0.0188, 28), rimMat);
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(holeP.x, holeY + 0.0004, holeP.z);
  rim.renderOrder = 3;
  globe.add(rim);
  disposables.push(holeMat, rimMat);

  // ---- 竿身：挂在右手上，沿固定仰角伸出 ----
  const rodG = new THREE.Group();
  rodG.position.copy(grip);
  const q0 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), rodDir);
  rodG.quaternion.copy(q0);
  globe.add(rodG);

  // 握把从手心向后再伸出一段，避免“杆子凭空浮在手上”
  const handleGeo = new THREE.CylinderGeometry(0.0019, 0.0023, 0.050, 10);
  handleGeo.translate(0, 0.001, 0);
  const handle = new THREE.Mesh(handleGeo, darkWoodMat);
  rodG.add(handle);
  /* 2026-11-04：竿改成可弯曲的。
     原来的竿是一整根直圆柱，看起来像根木棍。
     真实鱼竿在渔线拉力下会向"线的方向"轻微弯曲，咬钩时弯得更明显。
     做法：给竿的几何加一个 userData.bend，每帧在 updateFish 里
     按 (y/rodLen)² 的比例做侧向位移 —— 根部和握把不动，越靠竿尖弯得越多。 */
  const rodSegs = 12;
  const rodGeo = new THREE.CylinderGeometry(0.0005, 0.0013, rodLen - 0.026, 10, rodSegs);
  rodGeo.translate(0, 0.026 + (rodLen - 0.026) * 0.5, 0);
  // 记录原始顶点，供每帧弯曲使用
  rodGeo.userData.base = Float32Array.from(rodGeo.attributes.position.array);
  rodGeo.userData.rodLen = rodLen;
  rodGeo.userData.bend = 0;
  const rod = new THREE.Mesh(rodGeo, woodMat);
  rodG.add(rod);
  // 绕线轮
  const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0042, 0.006, 10), metalMat);
  reel.rotation.z = Math.PI / 2;
  reel.position.set(0, 0.030, -0.0048);
  rodG.add(reel);
  rodG.traverse((o) => { if (o.isMesh) o.castShadow = CFG.shadows; });
  disposables.push(handleGeo, rodGeo);

  /* ---- 把手对齐到竿（2026-11-04 最终方案）----
     前两轮失败原因：IK 把手挪走了，但竿的位置是建竿时用手的位置算的，
     竿没跟着动，所以"手贴竿"从根上就不成立。
     正确做法：**竿跟着手走** —— 每帧在 updateFish 里根据两只手的实际位置
     重新摆放竿（位置取两手中点、朝向取双手连线 + 仰角），
     这样竿永远穿过双手，不可能脱开。
     这里只记录"双手初始间距"等参考值，供动画使用。 */
  {
    const pL = bones.lHand.getWorldPosition(new THREE.Vector3());
    const pR = bones.rHand.getWorldPosition(new THREE.Vector3());
    hero.fishGrip = {
      span: pL.distanceTo(pR),            // 双手初始间距
      pitch: 0.62,                        // 竿的仰角（sin 值），约 38°
    };
  }

  // ---- 渔线 ----
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0),
  ]);
  const lineMat = new THREE.LineBasicMaterial({ color: 0xdcebf7, transparent: true, opacity: 0.5 });
  const line = new THREE.Line(lineGeo, lineMat);
  globe.add(line);
  disposables.push(lineGeo, lineMat);

  // ---- 浮漂 ----
  const bobMat = addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0xd23f33, roughness: 0.5, metalness: 0,
    emissive: 0x3a0a06, emissiveIntensity: 1.0,
  }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const bob = new THREE.Mesh(new THREE.SphereGeometry(0.0024, 10, 8), bobMat);
  bob.position.set(holeP.x, holeY + 0.0016, holeP.z);
  globe.add(bob);
  disposables.push(bobMat);

  // ---- 咬钩水花 ----
  const ripMat = new THREE.MeshBasicMaterial({
    color: 0xdff0ff, transparent: true, opacity: 0, depthWrite: false,
  });
  const ripple = new THREE.Mesh(new THREE.RingGeometry(0.6, 1.0, 24), ripMat);
  ripple.rotation.x = -Math.PI / 2;
  ripple.position.set(holeP.x, holeY + 0.0008, holeP.z);
  ripple.scale.setScalar(0.4);
  ripple.renderOrder = 4;
  globe.add(ripple);
  disposables.push(ripMat);

  // ---- 鱼桶：右手侧，桶里插着一条小鱼 ----
  const bucket = new THREE.Group();
  const bx = sx + side.x * 0.062 + fwd.x * -0.015;
  const bz = sz + side.z * 0.062 + fwd.z * -0.015;
  bucket.position.set(bx, surfY(Math.hypot(bx, bz)) + pond.lift, bz);
  const bucketMat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0x8fa7b8, roughness: 0.55, metalness: 0.45 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.0108, 0.0088, 0.0168, 14, 1, true), bucketMat);
  body.position.y = 0.0084;
  body.material.side = THREE.DoubleSide;
  bucket.add(body);
  const bottom = new THREE.Mesh(new THREE.CylinderGeometry(0.0088, 0.0088, 0.0018, 14), bucketMat);
  bottom.position.y = 0.001;
  bucket.add(bottom);
  const rimB = new THREE.Mesh(new THREE.TorusGeometry(0.0106, 0.0008, 6, 16), metalMat);
  rimB.rotation.x = Math.PI / 2;
  rimB.position.y = 0.0168;
  bucket.add(rimB);
  const fishMat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0xb9c8d4, roughness: 0.35, metalness: 0.35 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const fish = new THREE.Mesh(new THREE.SphereGeometry(0.0062, 10, 8), fishMat);
  fish.scale.set(0.55, 1.5, 0.35);
  fish.position.set(0.002, 0.016, 0);
  fish.rotation.z = 0.5;
  fish.userData.isFish = true;
  fish.visible = false;
  bucket.add(fish);
  bucket.traverse((o) => { if (o.isMesh) o.castShadow = CFG.shadows; });
  globe.add(bucket);
  disposables.push(bucketMat, fishMat);

  // ---- 冰钓小马灯：给主体一盏暖光，从深蓝冰面上"跳"出来 ----
  const lx = sx + side.x * 0.050 - fwd.x * 0.010;
  const lz = sz + side.z * 0.050 - fwd.z * 0.010;
  const ly = surfY(Math.hypot(lx, lz)) + pond.lift;
  const lampGlassMat = addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0xffe0b0, emissive: 0xffa94a, emissiveIntensity: 3.0, roughness: 0.5,
  }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const lampBaseMat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0x54636f, roughness: 0.55, metalness: 0.6 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const lantern = new THREE.Group();
  lantern.position.set(lx, ly, lz);
  const lGlass = new THREE.Mesh(new THREE.CylinderGeometry(0.0062, 0.0062, 0.011, 10), lampGlassMat);
  lGlass.position.y = 0.0125;
  lantern.add(lGlass);
  const lCap = new THREE.Mesh(new THREE.ConeGeometry(0.0082, 0.005, 10), lampBaseMat);
  lCap.position.y = 0.0205;
  lantern.add(lCap);
  const lBase = new THREE.Mesh(new THREE.CylinderGeometry(0.0082, 0.0088, 0.004, 10), lampBaseMat);
  lBase.position.y = 0.004;
  lantern.add(lBase);
  lantern.traverse((o) => { if (o.isMesh) o.castShadow = CFG.shadows; });
  globe.add(lantern);
  const lampGlow = new THREE.PointLight(0xffae62, 0.020, 0.34, 2);
  lampGlow.position.set(lx, ly + 0.030, lz);
  globe.add(lampGlow);

  // 冰面反光：马灯在湿冰上的倒影（加性贴片，比真反射便宜得多）
  const reflMat = new THREE.MeshBasicMaterial({
    map: getShadowTex(), color: 0xffa96a, transparent: true, opacity: 0.085,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const refl = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), reflMat);
  refl.rotation.x = -Math.PI / 2;
  refl.scale.set(0.050, 0.050, 1);        // 圆形晕开：原来 0.055×0.115 的长条被透视拉成竖直光柱
  refl.position.set(lx - fwd.x * 0.018, ly + 0.0016, lz - fwd.z * 0.018);
  refl.renderOrder = 3;
  globe.add(refl);
  disposables.push(reflMat, refl.geometry);
  // 主角光：暖主光（镜头侧上前方）+ 冷轮廓光（背后），两点都贴近人物
  const keyS = new THREE.PointLight(0xffe2bc, 0.180, 0.45, 2);
  keyS.position.set(sx - fwd.x * 0.115 + side.x * 0.075, ly + 0.135, sz - fwd.z * 0.115 + side.z * 0.075);
  globe.add(keyS);
  const rimS = new THREE.PointLight(0x9fc4ea, 0.115, 0.40, 2);
  rimS.position.set(sx + fwd.x * 0.135 - side.x * 0.045, ly + 0.155, sz + fwd.z * 0.135 - side.z * 0.045);
  globe.add(rimS);
  disposables.push(lampGlassMat, lampBaseMat);

  // 接触影
  const sh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.075, 0.075),
    new THREE.MeshBasicMaterial({ map: getShadowTex(), transparent: true, opacity: 0.28, depthWrite: false, color: 0x0b1220 })
  );
  sh.rotation.x = -Math.PI / 2;
  sh.position.set(sx + fwd.x * 0.01, sy + 0.004, sz + fwd.z * 0.01);
  globe.add(sh);
  hero.shadow = sh;
  disposables.push(sh.material);

  hero.fish = {
    rod: rodG, q0, rodLen, line, bob, bobY: holeY + 0.0016, ripple,
    rodTipMesh: rod,          // 供每帧弯曲用的竿身网格
    bite: 0, tip: new THREE.Vector3(),
    caught: 0, flying: null, bucket, holeP: holeP.clone(), holeY, wasBiting: false,
    dbg: { seatH, soleDrop, ankle0, ankle1, hipsY: hipsW.y, sy },
    /* 2026-11-04：保存坐姿定稿时各骨骼的四元数。
       updateFish 每帧都以这些为基准叠加动画（呼吸/咬钩/握竿手跟随），
       否则动画会在上一帧结果上累加，越动越歪。 */
    bones: {
      spine: bones.spine, spine1: bones.spine1,
      neck: bones.neck, head: bones.head,
      rArm: bones.rArm, rFore: bones.rFore, rHand: bones.rHand,
      lArm: bones.lArm, lFore: bones.lFore, lHand: bones.lHand,
    },
    spineQ0: bones.spine ? bones.spine.quaternion.clone() : null,
    spine1Q0: bones.spine1 ? bones.spine1.quaternion.clone() : null,
    neckQ0: bones.neck ? bones.neck.quaternion.clone() : null,
    headQ0: bones.head ? bones.head.quaternion.clone() : null,
    rForeQ0: bones.rFore ? bones.rFore.quaternion.clone() : null,
    rHandQ0: bones.rHand ? bones.rHand.quaternion.clone() : null,
    lForeQ0: bones.lFore ? bones.lFore.quaternion.clone() : null,
    lHandQ0: bones.lHand ? bones.lHand.quaternion.clone() : null,
  };
  hero.seat = { x: sx, y: sy, z: sz };
  window.__probeSubj = new THREE.Vector3(sx, sy + 0.085, sz);
}

function buildHero() {
  const wrap = loaded.hero;
  if (!wrap) return;

  const Q = new URLSearchParams(location.search);
  hero.mode = Q.has('walk') ? 'walk' : Q.has('skate') ? 'skate' : 'fish';

  const obj = wrap.children[0];
  wrap.position.set(0, 0, 0);
  wrap.rotation.y = 0;
  globe.add(wrap);
  hero.wrap = wrap;

  // 尺寸已在资源里烘好（hero_opt 里按世界高度缩放到 HERO_H），这里只量脚底偏移
  const measure = () => {
    const box = new THREE.Box3();
    wrap.updateMatrixWorld(true);
    wrap.traverse((o) => {
      if (o.isSkinnedMesh) {
        o.computeBoundingBox();
        box.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld));
      } else if (o.isMesh) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
      }
    });
    return box;
  };
  const bb = measure();
  hero.groundOffset = -bb.min.y;
  hero.spanOK = (bb.max.y - bb.min.y).toFixed(3);

  if (hero.mode === 'fish') {
    exprPrepare(obj, wrap);            // 必须在 sitPose 之前量眼位（bind 姿态）
    /* yaw 必须先算出来传给 sitPose：sitPose 里的手臂/腿方向需要按"角色朝向"
       在身体坐标系里给，否则会落在世界坐标系的错误方向（实测双手跑到身后 22mm）。 */
    const _seatA = -1.12;
    const _sx = pond.cx + Math.cos(_seatA) * pond.rx * 0.72;
    const _sz = pond.cz + Math.sin(_seatA) * pond.rz * 0.72;
    const sitYaw = Math.atan2(pond.cx - _sx, pond.cz - _sz) + Math.PI;
    const pose = sitPose(obj, sitYaw);
    if (pose) {
      hero.pose = pose;
      buildFishingGear(wrap, obj, pose);
      exprBuild();
      /* 2026-11-04 副本版本：重新启用"被注视"交互。
         需求：**连续被看 5 秒 → 害羞**。
         与旧版（1.1s 察觉 / 3.2s 害羞 / 6.4s 恼火 / 9.5s 躲避）的区别：
         简化成单一阈值，被看满 5 秒才进入害羞，中途移开就重置。
         其余旧机制（偷瞄/抓包/台词）保留但不主动触发。 */
      lookInit(obj);
      window.__st = 'hero-shy-ready';
      registerKind(wrap, 'hero', '钓鱼的小孩');
      return;
    }
    hero.mode = 'skate';   // 骨架对不上时退回滑冰
  }

  const clips = wrap.userData.clips || [];
  if (clips.length && !Q.has('nomix')) {
    hero.mixer = new THREE.AnimationMixer(obj);
    hero.action = hero.mixer.clipAction(clips[0]);
    hero.action.setLoop(THREE.LoopRepeat, Infinity);
    hero.action.play();
    hero.mixer.timeScale = hero.mode === 'skate' ? 0.68 : 1.15;
  }

  hero.curve = new THREE.CatmullRomCurve3(
    PATHS[0].pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'catmullrom', 0.5
  );
  hero.len = hero.curve.getLength();

  // 跟随的接触影
  const mat = new THREE.MeshBasicMaterial({
    map: getShadowTex(), transparent: true, opacity: 0.3,
    depthWrite: false, color: 0x0b1220,
  });
  const sh = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.05), mat);
  sh.rotation.x = -Math.PI / 2;
  globe.add(sh);
  hero.shadow = sh;
  disposables.push(mat);

  registerKind(wrap, 'hero', hero.mode === 'skate' ? '滑冰的小孩' : '雪镇小孩');
}

function updateFish(dt) {
  const F = hero.fish;
  if (!F) return;

  if (F.bite > 0) F.bite = Math.max(0, F.bite - dt * 0.62);
  const b = F.bite > 0 ? Math.sin((1 - F.bite) * Math.PI) : 0;
  const t = clock.elapsedTime;

  /* 2026-11-04 钓鱼动作优化：
     原来角色本体完全静止，只有竿和浮漂在动，所以看起来"僵在木墩上"。
     真实冰钓的人是持续微动的，这里补四层：
       1) 呼吸：胸/肩随呼吸缓慢起伏（周期约 4 秒）
       2) 握竿手：被竿的摆动带着走（手是放在竿上的，必须联动）
       3) 咬钩反应：身体前倾、抬头看漂（"来鱼了"的本能反应）
       4) 等待中的小动作：偶尔换重心 / 抖一下腿
  */

  // ---- 1) 呼吸：脊柱轻微起伏 ----
  if (F.bones.spine && F.spineQ0) {
    const br = Math.sin(t * 1.55) * 0.018 + Math.sin(t * 0.73) * 0.010;
    F.bones.spine.quaternion.copy(F.spineQ0);
    F.bones.spine.rotateX(br);
    // 肩部跟着呼吸抬一点（真人呼吸时肩膀会动）
    if (F.bones.spine1 && F.spine1Q0) {
      F.bones.spine1.quaternion.copy(F.spine1Q0);
      F.bones.spine1.rotateX(br * 0.6);
    }
  }

  // ---- 2) 咬钩时的身体反应：前倾 + 抬头 ----
  if (F.bones.neck && F.neckQ0) {
    F.bones.neck.quaternion.copy(F.neckQ0);
    // b 从 0→1→0 的一次脉冲，模拟"来鱼了"的抬头
    F.bones.neck.rotateX(-b * 0.22);
    F.bones.neck.rotateZ(Math.sin(t * 0.9) * 0.008);   // 极轻微的左右看
  }
  if (F.bones.head && F.headQ0) {
    F.bones.head.quaternion.copy(F.headQ0);
    F.bones.head.rotateX(b * 0.16);                    // 咬钩时低头看漂
    F.bones.head.rotateY(Math.sin(t * 0.42 + 1.1) * 0.045);  // 缓慢扫视水面
  }

  // ---- 鱼竿：待机轻摆 + 咬钩下顿 ----
  F.rod.quaternion.copy(F.q0);
  F.rod.rotateX(-0.012 + Math.sin(t * 0.62) * 0.010 - b * 0.28);
  F.rod.rotateZ(Math.sin(t * 0.47 + 0.9) * 0.012);

  /* ---- 竿的位置与朝向（2026-11-04 第二次修正）----
     实测：竿的朝向与脸朝向差 95.6°，几乎垂直 —— 竿是横着伸出去的。
     原因：方向原本取"右手位置 → 冰洞"，而右手在身体侧面，
     这个向量被手的横向偏移拉成了斜向。
     正确做法：方向直接取**角色正前方**（由 wrap.rotation.y 算出），
     因为冰洞本来就在正前方；竿的位置再让竿尾贴在右手上。 */
  if (F.bones.rHand && F.bones.lHand && F.rod && F.holeP) {
    hero.wrap.updateMatrixWorld(true);
    const pR = F.bones.rHand.getWorldPosition(new THREE.Vector3());
    const pL = F.bones.lHand.getWorldPosition(new THREE.Vector3());

    // 方向 = 角色正前方 + 38° 仰角
    /* 注意：不能用 hero.wrap.rotation.y —— 实测发现它在 updateFish 里读到的
       值虽然显示 2.597，但基于它算出的竿方向却偏了 96°。
       改用**冰洞相对角色的方位**（这个量由 sx/sz→holeP 直接决定，最可靠），
       它天然就是"角色正前方"。 */
    const wm = hero.wrap.matrixWorld.elements;
    const hx = wm[12], hz = wm[14];
    const fwdH = new THREE.Vector3(F.holeP.x - hx, 0, F.holeP.z - hz);
    if (fwdH.lengthSq() < 1e-10) fwdH.set(0, 0, -1);
    fwdH.normalize();
    const PITCH = 0.616;
    const horizK = Math.sqrt(1 - PITCH * PITCH);
    const dir = new THREE.Vector3(
      fwdH.x * horizK, PITCH, fwdH.z * horizK
    ).normalize();

    /* ══════ 竿与手（2026-11-04 定稿）══════
       前几轮反复失败的原因：
         · 把竿放在某处，再用 IK 把手搬过去 → 手被拉脱原位，看着"插兜"
         · 竿尾挪来挪去避脸 → 竿和手彻底分离（实测两手离竿 22-34mm）
       正确的物理关系：
         · **手的位置由姿势决定**（不能为了握竿把手搬到奇怪的地方）
         · **竿由两只手决定**：竿身就是穿过两手的直线
       所以：竿基座 = 两手中点偏右手一侧；方向 = 右手→左手再抬仰角。
       竿自然穿过双手，手一个像素都不用动。 */
    const midG = pR.clone().lerp(pL, 0.35);          // 握点偏右手（主握手）
    const handAxis = pL.clone().sub(pR);
    const handSpan = handAxis.length();
    if (handSpan > 1e-5) handAxis.normalize();

    /* 竿的方向：以"右手→左手"的水平分量为准，再抬到 38° 仰角。
       若两手几乎等高（手轴向水平），这个方向就基本等于两手臂的伸展方向，
       视觉上最像"握着同一根竿"。 */
    const axisH = new THREE.Vector3(handAxis.x, 0, handAxis.z);
    if (axisH.lengthSq() < 1e-8) axisH.copy(fwdH);
    axisH.normalize();
    // PITCH / horizK 已在上方声明，这里复用
    const dir2 = new THREE.Vector3(
      axisH.x * horizK, PITCH, axisH.z * horizK
    ).normalize();

    // 竿基座：沿竿方向从握点往回退，让握把落在两手之间
    F.rod.position.copy(midG).addScaledVector(dir2, -0.025);

    // 用正交基构造旋转（避免 setFromUnitVectors 在大角度下的奇异）
    const yAxis = dir2.clone().normalize();
    const refUp = Math.abs(yAxis.y) > 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
    const xAxis = new THREE.Vector3().crossVectors(refUp, yAxis).normalize();
    if (xAxis.lengthSq() < 1e-8) xAxis.set(1, 0, 0);
    const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
    const qWorld = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis)
    );
    window.__rodDbg = {
      dir2: [+dir2.x.toFixed(3), +dir2.y.toFixed(3), +dir2.z.toFixed(3)],
      handSpan: +(handSpan * 1000).toFixed(1),
    };
    const parentQ = new THREE.Quaternion();
    if (F.rod.parent) {
      F.rod.parent.getWorldQuaternion(parentQ);
      parentQ.invert();
    } else {
      parentQ.identity();
    }
    F.rod.quaternion.copy(parentQ).multiply(qWorld);

    // 待机摆动 + 咬钩下顿
    F.rod.rotateX(Math.sin(t * 0.62) * 0.006 - b * 0.10);
    F.rod.rotateZ(Math.sin(t * 0.47 + 0.9) * 0.006);
    F.rod.updateMatrixWorld(true);
    /* 注意：这里**不再**用 aimBone 去搬手臂。
       手的位置由 sitPose 定好的姿势决定，搬动会让手臂看起来脱臼。
       竿已经穿过双手，视觉上就是握住的。 */
  }

  /* ---- 竿身弯曲（2026-11-04）----
     越靠竿尖弯得越多：位移量 ∝ (y/rodLen)²。
     弯曲方向朝"渔线那一侧"（竿尖被线往下拽），咬钩时加大。
     根部不动，所以握把和手的位置不会受影响。 */
  if (F.rodTipMesh) {
    const g = F.rodTipMesh.geometry;
    const base = g.userData.base;
    if (base) {
      const pos = g.attributes.position;
      const rl = g.userData.rodLen || 0.175;
      // 咬钩时弯曲加倍；平时有轻微的待机弧度
      const bendAmt = (0.0028 + Math.sin(t * 0.5) * 0.0006) * (1 + b * 2.4);
      for (let i = 0; i < pos.count; i++) {
        const y = base[i * 3 + 1];
        const k = Math.max(0, y / rl);
        const s = k * k;                       // 平方 → 根部几乎不动
        pos.setX(i, base[i * 3] - s * bendAmt);
        pos.setZ(i, base[i * 3 + 2] + s * bendAmt * 0.55);
      }
      pos.needsUpdate = true;
      g.computeVertexNormals();
    }
  }

  // ---- 3) 握竿手跟随竿的摆动（手不能和竿脱开）----
  if (F.bones.rFore && F.rForeQ0) {
    // 摆幅要比竿本身更大一些，否则肉眼看不出来（竿 0.010，手给 0.035）
    const sw = Math.sin(t * 0.62) * 0.035 - b * 0.16;
    F.bones.rFore.quaternion.copy(F.rForeQ0);
    F.bones.rFore.rotateX(sw);
    if (F.bones.rHand && F.rHandQ0) {
      F.bones.rHand.quaternion.copy(F.rHandQ0);
      F.bones.rHand.rotateX(sw * 0.8);
      F.bones.rHand.rotateZ(Math.sin(t * 0.9) * 0.02);
    }
  }
  // 左手也搭在竿上，跟着轻微动（幅度小一半）
  if (F.bones.lFore && F.lForeQ0) {
    const sw2 = Math.sin(t * 0.62 + 0.3) * 0.018 - b * 0.08;
    F.bones.lFore.quaternion.copy(F.lForeQ0);
    F.bones.lFore.rotateX(sw2);
  }

  // ---- 浮漂：咬钩时被拖下水 ----
  F.bob.position.y = F.bobY - b * 0.0045 + Math.sin(t * 1.9) * 0.0006;

  // ---- 渔线：竿尖 → 浮漂 ----
  F.tip.set(0, F.rodLen, 0).applyQuaternion(F.rod.quaternion).add(F.rod.position);
  const arr = F.line.geometry.attributes.position;
  arr.setXYZ(0, F.tip.x, F.tip.y, F.tip.z);
  arr.setXYZ(1, F.bob.position.x, F.bob.position.y, F.bob.position.z);
  arr.needsUpdate = true;

  // ---- 咬钩水花 ----
  const rp = F.bite > 0 ? Math.min(1, (1 - F.bite) * 1.7) : 1;
  F.ripple.scale.setScalar(0.4 + rp * 1.15);
  F.ripple.material.opacity = F.bite > 0 ? Math.max(0, 0.5 * (1 - rp)) : 0;

  // 咬钩结束 → 上钩一条鱼，抛物线飞进鱼桶
  if (F.wasBiting && F.bite <= 0 && !F.flying) startCatch();
  F.wasBiting = F.bite > 0;

  if (F.flying) {
    const f = F.flying;
    f.t += dt * 1.5;
    const k = Math.min(1, f.t);
    const e = k * k * (3 - 2 * k);
    f.obj.position.lerpVectors(f.from, f.to, e);
    f.obj.position.y += Math.sin(k * Math.PI) * 0.075;      // 抛物线
    f.obj.rotation.z += dt * 9;
    f.obj.rotation.x = Math.sin(k * Math.PI) * 0.8;
    if (k >= 1) {
      globe.remove(f.obj);
      F.flying = null;
      F.caught++;
      if (F.bucket) {
        F.bucket.traverse(o => {
          if (o.userData.isFish) {
            o.visible = true;
            o.scale.setScalar(0.6 + Math.min(F.caught, 5) * 0.12);
          }
        });
      }
      if (F.caught >= 5) sparkleAt(F.holeP.x, F.holeY + 0.12, F.holeP.z, 0xffe3b0, 20);
    }
  }
}

function startCatch() {
  const F = hero.fish;
  if (!F || F.flying) return;
  const mat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0xb9cbd8, roughness: 0.32, metalness: 0.4 }), { kind: 'cloth', repeat: 10, scale: 0.8 });
  const obj = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), mat);
  obj.scale.set(0.5, 1.5, 0.32);
  obj.position.set(F.holeP.x, F.holeY + 0.004, F.holeP.z);
  globe.add(obj);
  const to = F.bucket ? F.bucket.position.clone().add(new THREE.Vector3(0, 0.022, 0)) : F.holeP.clone();
  F.flying = { obj, t: 0, from: obj.position.clone(), to };
  F.bite = 0;
  sparkleAt(F.holeP.x, F.holeY + 0.02, F.holeP.z, 0xdcefff, 10);
}

/* ============================================================================
   表情层（Sprite 符号）已按需求移除 —— 2026-11-02
   眼睛外观改由几何眼球模块负责（build/hero_final.glb 的 Lens_L/Lens_R 等节点）。
   仅保留眼位标定数据 EXPR（head / anchors / span / mid），
   擦眼贴图、眼窝、眼睛模块等代码仍依赖它，勿删。
   ========================================================================== */
const EXPR = {
  head: null, anchors: [], span: 0.01, mid: null,
  tex: {}, cur: 'neutral', age: 0, vis: 0,
  cycle: null, cycleT: 0, step: 1.5,
  skinL: null, skinR: null, symL: null, symR: null, blush: null, sweat: null, zzz: null,
};

function exprPrepare(obj, wrap) {
  if (!obj || !wrap) return;
  let mesh = null, head = null;
  obj.traverse((o) => { if (!mesh && o.isSkinnedMesh) mesh = o; });
  head = obj.getObjectByName('Head');
  if (!mesh || !head) return;
  wrap.updateMatrixWorld(true);
  head.updateMatrixWorld(true);
  EXPR.head = head;
  EXPR.anchors = [[-0.013852, 0.016924, -0.017588], [-0.019118, 0.018117, 0.009539]]
    .map((m) => new THREE.Vector3(m[0], m[1], m[2]));
  const w0 = head.localToWorld(EXPR.anchors[0].clone());
  const w1 = head.localToWorld(EXPR.anchors[1].clone());
  EXPR.span = w0.distanceTo(w1) || 0.01;
  EXPR.mid = w0.clone().add(w1).multiplyScalar(0.5);
}

function exprBuild() {}
function setExpr(name) { EXPR.cur = name; }
function updateExpr() {}
/* ============================================================================
   把贴图上烘焙的黑眼擦掉（一次性清除，不是用来画表情）
   做法：用眼锚点在网格上圈出眼区三角形 → 把它们的 UV 三角形填成眼周肤色。
   之后眼睛的"外观"完全由几何模块负责，不再有任何贴图残留露边。
   ========================================================================== */
function erasePaintedEyes() {
  const why = (r) => { window.__eraseInfo = { reason: r }; return r; };
  if (new URLSearchParams(location.search).has('noerase')) return why('noerase');
  const head = EXPR.head;
  if (!head) return why('no-head');
  if (!hero.wrap) return why('no-wrap');
  let mesh = null;
  hero.wrap.traverse((o) => { if (!mesh && o.isSkinnedMesh) mesh = o; });
  if (!mesh) return why('no-mesh');
  const map = mesh.material.map;
  if (!map) return why('no-map');
  if (!map.image) return why('no-image');
  if (mesh.userData.erased) return why('already');

  mesh.updateMatrixWorld(true);
  mesh.skeleton.update();
  head.updateWorldMatrix(true, false);

  const g = mesh.geometry;
  const pa = g.attributes.position, ua = g.attributes.uv, idx = g.index;
  if (!ua) return why('no-uv');
  if (!idx) return why('no-index');

  const A = [0, 1].map((i) => head.localToWorld(EXPR.anchors[i].clone()));
  const Rx = A[1].clone().sub(A[0]).normalize();
  const WU = new THREE.Vector3(0, 1, 0);
  const N = new THREE.Vector3().crossVectors(Rx, WU).normalize();
  const U = new THREE.Vector3().crossVectors(N, Rx).normalize();
  const sp = A[0].distanceTo(A[1]);
  const RR = sp * 0.130, RU = sp * 0.195, RN = sp * 0.16;

  // 世界坐标（蒙皮后）
  const WP = new Float32Array(pa.count * 3);
  const v = new THREE.Vector3(), d = new THREE.Vector3();
  for (let i = 0; i < pa.count; i++) {
    v.fromBufferAttribute(pa, i);
    mesh.applyBoneTransform(i, v);
    v.applyMatrix4(mesh.matrixWorld);
    WP[i * 3] = v.x; WP[i * 3 + 1] = v.y; WP[i * 3 + 2] = v.z;
  }
  const hit = new Uint8Array(idx.count / 3);
  for (let t = 0; t < idx.count / 3; t++) {
    const i0 = idx.getX(t * 3), i1 = idx.getX(t * 3 + 1), i2 = idx.getX(t * 3 + 2);
    const cx = (WP[i0 * 3] + WP[i1 * 3] + WP[i2 * 3]) / 3;
    const cy = (WP[i0 * 3 + 1] + WP[i1 * 3 + 1] + WP[i2 * 3 + 1]) / 3;
    const cz = (WP[i0 * 3 + 2] + WP[i1 * 3 + 2] + WP[i2 * 3 + 2]) / 3;
    let done = false;
    for (let e = 0; e < 2 && !done; e++) {
      d.set(cx - A[e].x, cy - A[e].y, cz - A[e].z);
      let a = d.dot(Rx) / RR, b = d.dot(U) / RU, c = d.dot(N) / RN;
      if (a * a + b * b + c * c <= 1) { hit[t] = 1; done = true; break; }
      /* 三角形很大时质心可能落在椭圆外，改用顶点判断 */
      for (const vi of [i0, i1, i2]) {
        d.set(WP[vi * 3] - A[e].x, WP[vi * 3 + 1] - A[e].y, WP[vi * 3 + 2] - A[e].z);
        a = d.dot(Rx) / RR; b = d.dot(U) / RU; c = d.dot(N) / RN;
        if (a * a + b * b + c * c <= 1) { hit[t] = 1; done = true; break; }
      }
    }
  }

  const img = map.image;
  const W = img.width, H = img.height;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const cx2 = cv.getContext('2d', { willReadFrequently: true });
  cx2.drawImage(img, 0, 0);
  const src = cx2.getImageData(0, 0, W, H).data;

  const px = (u, vv) => {
    const ix = Math.max(0, Math.min(W - 1, Math.floor(u * W)));
    const iy = Math.max(0, Math.min(H - 1, Math.floor(vv * H)));
    const o = (iy * W + ix) * 4;
    return [src[o], src[o + 1], src[o + 2]];
  };

  /* 肤色：取"眼睛外圈"顶点的颜色（比眼内更可靠，眼内基本全是黑） */
  const cand = [];
  for (let i = 0; i < pa.count; i++) {
    d.set(WP[i * 3] - A[0].x, WP[i * 3 + 1] - A[0].y, WP[i * 3 + 2] - A[0].z);
    let best = null;
    for (let e = 0; e < 2; e++) {
      d.set(WP[i * 3] - A[e].x, WP[i * 3 + 1] - A[e].y, WP[i * 3 + 2] - A[e].z);
      const a = d.dot(Rx) / RR, b = d.dot(U) / RU, c = d.dot(N) / RN;
      const rr = Math.sqrt(a * a + b * b + c * c);
      if (!best || rr < best.r) best = { r: rr, e };
    }
    if (!best) continue;
    if (best.r < 1.25 || best.r > 2.6) continue;
    const col = px(ua.getX(i), ua.getY(i));
    const lum = col[0] * 0.299 + col[1] * 0.587 + col[2] * 0.114;
    if (lum > 95) cand.push([lum, col]);
  }
  cand.sort((x, y) => y[0] - x[0]);
  const mid = cand.filter((c) => c[0] > 110 && c[0] < 235);
  const pool = mid.length > 8 ? mid : cand;
  let acc = [0, 0, 0];
  let n = pool.length;
  if (n) {
    pool.forEach(([lum, col]) => { acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; });
  } else {
    acc = [236, 191, 166]; n = 1;      // 兜底：之前实测的脸部肤色
  }
  const SK = [Math.round(acc[0] / n), Math.round(acc[1] / n), Math.round(acc[2] / n)];
  window.__eraseSK = SK;

  cx2.fillStyle = 'rgb(' + SK[0] + ',' + SK[1] + ',' + SK[2] + ')';
  cx2.strokeStyle = cx2.fillStyle;
  cx2.lineJoin = 'round';
  cx2.lineWidth = W * 0.004;

  const fillTri = (a, b, c, scale) => {
    const mx = (a[0] + b[0] + c[0]) / 3, my = (a[1] + b[1] + c[1]) / 3;
    const s = (P) => [mx + (P[0] - mx) * scale, my + (P[1] - my) * scale];
    const a1 = s(a), b1 = s(b), c1 = s(c);
    cx2.beginPath();
    cx2.moveTo(a1[0] * W, a1[1] * H);
    cx2.lineTo(b1[0] * W, b1[1] * H);
    cx2.lineTo(c1[0] * W, c1[1] * H);
    cx2.closePath(); cx2.fill(); cx2.stroke();
  };
  let painted = 0;
  const lumOf = (i) => {
    const c = px(ua.getX(i), ua.getY(i));
    return c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  };
  for (let t = 0; t < hit.length; t++) {
    if (!hit[t]) continue;
    const i0 = idx.getX(t * 3), i1 = idx.getX(t * 3 + 1), i2 = idx.getX(t * 3 + 2);
    /* 只抹贴图上真的是黑眼的那部分，避免误伤皮肤和头发 */
    if ((lumOf(i0) + lumOf(i1) + lumOf(i2)) / 3 > 118) continue;
    fillTri([ua.getX(i0), ua.getY(i0)], [ua.getX(i1), ua.getY(i1)], [ua.getX(i2), ua.getY(i2)], 0.94);
    painted++;
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = map.flipY;
  tex.colorSpace = map.colorSpace;
  tex.wrapS = map.wrapS; tex.wrapT = map.wrapT;
  tex.anisotropy = map.anisotropy;
  tex.needsUpdate = true;
  mesh.material = mesh.material.clone();
  mesh.material.map = tex;
  mesh.material.needsUpdate = true;
  mesh.userData.erased = true;
  window.__eraseInfo = { tris: painted, skin: SK, ring: cand.length };
}

/* ============================================================================
   挖眼窝：把眼区顶点沿法线向内压出一个碗状凹坑。
   眼球沉进坑里之后，边缘会被脸皮挡住一圈 —— 这是"眼睛长在脸上"的关键，
   光靠把眼球往外推是做不到的。
   ========================================================================== */
function carveEyeSockets() {
  const head = EXPR.head;
  if (!head || !hero.wrap) return;
  let mesh = null;
  hero.wrap.traverse((o) => { if (!mesh && o.isSkinnedMesh) mesh = o; });
  if (!mesh || mesh.userData.socket) return;
  mesh.updateMatrixWorld(true);
  mesh.skeleton.update();
  head.updateWorldMatrix(true, false);

  const g = mesh.geometry;
  const pa = g.attributes.position, na = g.attributes.normal;

  const A = [0, 1].map((i) => head.localToWorld(EXPR.anchors[i].clone()));
  const Rx = A[1].clone().sub(A[0]).normalize();
  const WU = new THREE.Vector3(0, 1, 0);
  const N = new THREE.Vector3().crossVectors(Rx, WU).normalize();
  const U = new THREE.Vector3().crossVectors(N, Rx).normalize();
  const sp = A[0].distanceTo(A[1]);
  const RR = sp * 0.235, RU = sp * 0.265;
  const depth = (window.__socketDepth !== undefined) ? window.__socketDepth : 0.00130;

  const v = new THREE.Vector3(), d = new THREE.Vector3(), nrm = new THREE.Vector3();
  let moved = 0, maxR = 0;
  const idxList = [];
  const rr = [];
  for (let i = 0; i < pa.count; i++) {
    v.fromBufferAttribute(pa, i);
    mesh.applyBoneTransform(i, v);
    v.applyMatrix4(mesh.matrixWorld);
    let best = 9;
    for (let e = 0; e < 2; e++) {
      d.copy(v).sub(A[e]);
      const a = d.dot(Rx) / RR, b = d.dot(U) / RU, c = d.dot(N) / (sp * 0.9);
      const r2 = a * a + b * b;
      if (c * c > 1) continue;
      if (r2 < best) best = r2;
    }
    if (best <= 1) { idxList.push(i); rr.push(Math.sqrt(best)); if (best > maxR) maxR = best; }
  }
  if (!idxList.length) return;

  for (let k = 0; k < idxList.length; k++) {
    const i = idxList[k];
    const r = rr[k];
    const f = 1 - r * r;                       // 中心最深，边缘为 0
    const cut = (r > 0.86) ? Math.max(0, (1 - r) / 0.14) : 1;   // 边缘再收一下，避免硬边
    nrm.set(na.getX(i), na.getY(i), na.getZ(i)).normalize();
    pa.setXYZ(i,
      pa.getX(i) - nrm.x * depth * f * cut,
      pa.getY(i) - nrm.y * depth * f * cut,
      pa.getZ(i) - nrm.z * depth * f * cut);
    moved++;
  }
  pa.needsUpdate = true;
  g.computeVertexNormals();
  mesh.userData.socket = true;
  window.__socketInfo = { verts: moved, depth: depth, RR: +RR.toFixed(5), RU: +RU.toFixed(5) };
}

window.__setExpr = setExpr;
window.__EXPRDBG = EXPR;
window.__exprReady = () => !!EXPR.head;

/* ============================================================================
   眼睛模块（独立 3D 眼球）
   几何来自用户提供的拆分件 part_2 / part_5（原始就是独立眼球），
   已减面并归一化到眼心为原点，存为 assets/opt/eyes.json。
   挂载方式：按已验证的眼锚点定位，并按 Head 骨骼的世界矩阵每帧跟随。
   ========================================================================== */
const EYEMOD = {
  ready: false, hidden: false,
  parts: {}, sockets: [], matEye: null, matFlat: null, DATA: null, frames: [],
  cfg: { K: [0.175, 0.175, 0.175], out: 0.62, basic: true, thin: 1.0 },
  kinds: ['neutral', 'half', 'line', 'x', 'ring', 'doze'],
};

function eyeMat() {
  if (EYEMOD.cfg.basic) {
    if (!EYEMOD.matFlat) {
      /* 平涂黑：原画的眼睛就是一块纯黑，受光材质会把镜片的弧度照成一个鼓包 */
      EYEMOD.matFlat = new THREE.MeshBasicMaterial({
        color: 0x0a0908, toneMapped: false, side: THREE.DoubleSide,
      });
      disposables.push(EYEMOD.matFlat);
    }
    return EYEMOD.matFlat;
  }
  if (!EYEMOD.matEye) {
    EYEMOD.matEye = addSurfaceDetail(new THREE.MeshStandardMaterial({
      color: 0x0c0b0b, roughness: 0.78, metalness: 0.0, side: THREE.DoubleSide,
    }), { kind: 'fine', repeat: 7, scale: 0.75 });
    disposables.push(EYEMOD.matEye);
  }
  return EYEMOD.matEye;
}

/* 沿 Z 压缩（形变），alignTop=true 时保持上缘不动（眼皮往下压） */
function squashZ(src, s, alignTop) {
  const g = src.clone();
  g.computeBoundingBox();
  const b = g.boundingBox;
  g.scale(1, 1, s);
  g.computeBoundingBox();
  const nb = g.boundingBox;
  const dz = alignTop
    ? (b.max.z - nb.max.z)
    : ((b.min.z + b.max.z) / 2 - (nb.min.z + nb.max.z) / 2);
  g.translate(0, 0, dz);
  return g;
}

/* 所有表情都由原眼片本身生成，不引入球/方块/胶囊这类图元 */
function buildEyeGeo(kind, lens, W, mat) {
  const grp = new THREE.Group();
  const add = (g) => { const m = new THREE.Mesh(g, mat); grp.add(m); return m; };
  if (kind === 'neutral') {
    add(lens.clone());
  } else if (kind === 'half') {
    add(squashZ(lens, 0.52, true));
  } else if (kind === 'line') {
    add(squashZ(lens, 0.14, false));
  } else if (kind === 'doze') {
    add(squashZ(lens, 0.24, true));
  } else if (kind === 'x') {
    for (const sg of [-1, 1]) {
      const g = lens.clone();
      g.scale(0.34, 1, 0.92);
      g.rotateY(sg * Math.PI / 4);
      add(g);
    }
  } else if (kind === 'ring') {
    const g = new THREE.TorusGeometry(W * 0.26, W * 0.062, 12, 32);
    g.rotateX(Math.PI / 2);
    add(g);
    add(new THREE.SphereGeometry(W * 0.085, 12, 8));
  }
  grp.visible = false;
  return grp;
}

/* 从"头心 -> 眼位"的外向射线打到脸皮上：既把锚点吸附到表面，又拿到真实面法线。
   这比"取最近顶点"稳，因为眼锚点可能在皮下，最近顶点法线会指错方向。 */
function snapToFace(mesh, p, headPos) {
  const dir = new THREE.Vector3().copy(p).sub(headPos);
  if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1);
  dir.normalize();
  const ray = new THREE.Raycaster();
  ray.set(p.clone().addScaledVector(dir, 0.35), dir.clone().negate());
  ray.far = 0.7;
  const hits = ray.intersectObject(mesh, false);
  for (const h of hits) {
    if (!h.face) continue;
    const n = h.face.normal.clone()
      .applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize();
    return { point: h.point.clone(), normal: n };
  }
  return null;
}

/* 取 p 附近一圈顶点法线的平均值 —— 这才是脸皮真正朝外的方向。
   不要用"头心->眼心"：Head 骨骼的位置并不可靠，方向可能整个反掉。 */
function avgNormalNear(mesh, p, radius) {
  const g = mesh.geometry, pa = g.attributes.position, na = g.attributes.normal;
  const v = new THREE.Vector3(), n = new THREE.Vector3(), acc = new THREE.Vector3();
  const nm3 = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const r2 = radius * radius;
  let cnt = 0;
  const step = Math.max(1, Math.floor(pa.count / 30000));
  for (let i = 0; i < pa.count; i += step) {
    v.fromBufferAttribute(pa, i);
    mesh.applyBoneTransform(i, v);
    v.applyMatrix4(mesh.matrixWorld);
    if (v.distanceToSquared(p) > r2) continue;
    n.set(na.getX(i), na.getY(i), na.getZ(i)).applyMatrix3(nm3).normalize();
    acc.add(n); cnt++;
  }
  if (!cnt) return null;
  acc.divideScalar(cnt);
  if (acc.lengthSq() < 1e-12) return null;
  return acc.normalize();
}

function surfaceNormalAt(mesh, p) {
  const g = mesh.geometry, pa = g.attributes.position, na = g.attributes.normal;
  const v = new THREE.Vector3(), best = { d: Infinity, n: new THREE.Vector3() };
  const step = Math.max(1, Math.floor(pa.count / 20000));
  for (let i = 0; i < pa.count; i += step) {
    v.fromBufferAttribute(pa, i);
    mesh.applyBoneTransform(i, v);
    v.applyMatrix4(mesh.matrixWorld);
    const dd = v.distanceToSquared(p);
    if (dd < best.d) {
      best.d = dd;
      best.n.set(na.getX(i), na.getY(i), na.getZ(i))
        .transformDirection(mesh.matrixWorld).normalize();
    }
  }
  return best.n;
}


/* ============ 眼模块：把眼睛从网格上真正切下来 ============
   眼位已由"贴图逐像素渲染"量准（模型空间）：
     L(-0.00804,-0.00930,0.12250)  R(0.00820,-0.00930,0.12250)  眼宽0.0040 眼高0.0064
   做法：按三角形重心落在椭圆内，把眼区三角形从身体网格切出 → 独立 SkinnedMesh，
   和身体共用同一套骨骼；表情 = 对这几块小网格做压扁/旋转，而不是盖符号。
   切走留下的洞用一个"皮肤贴片"垫在后面（UV 外扩，采样眼周的皮肤），
   所以眼睛变小/消失时看到的是皮肤，不是破洞。
*/
const EYESPLIT = {
  ready: false, mat: null, C: [[-0.00092, -0.00930, 0.11713], [0.01515, -0.00930, 0.11520]],
  RX: 0.00225, RZ: 0.00315,
  groups: {}, base: [null, null], uvC: [null, null],
  kinds: ['neutral', 'half', 'line', 'x', 'doze', 'ring'],
};

function _subGeo(geo, tris) {
  const idx = geo.index, at = geo.attributes;
  const map = new Map();
  const pos = [], nor = [], uv = [], si = [], sw = [];
  const ni = [];
  for (let q = 0; q < tris.length; q++) {
    const t = tris[q];
    for (let k = 0; k < 3; k++) {
      const o = idx.getX(t * 3 + k);
      let n = map.get(o);
      if (n === undefined) {
        n = pos.length / 3;
        map.set(o, n);
        pos.push(at.position.getX(o), at.position.getY(o), at.position.getZ(o));
        nor.push(at.normal.getX(o), at.normal.getY(o), at.normal.getZ(o));
        uv.push(at.uv.getX(o), at.uv.getY(o));
        si.push(at.skinIndex.getX(o), at.skinIndex.getY(o), at.skinIndex.getZ(o), at.skinIndex.getW(o));
        sw.push(at.skinWeight.getX(o), at.skinWeight.getY(o), at.skinWeight.getZ(o), at.skinWeight.getW(o));
      }
      ni.push(n);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(ni);
  return g;
}

/* 以眼心为中心做形变：squashAlongZ 压扁、rotY 在脸平面内旋转、scaleX 变窄 */
function _deform(geo, c, opt) {
  const pa = geo.attributes.position;
  const sx = opt.sx || 1, sz = opt.sz || 1, rz = opt.rz || 0, alignTop = !!opt.alignTop;
  let zTop = -1e9;
  if (alignTop) for (let i = 0; i < pa.count; i++) zTop = Math.max(zTop, pa.getZ(i));
  const cs = Math.cos(rz), sn = Math.sin(rz);
  for (let i = 0; i < pa.count; i++) {
    let x = (pa.getX(i) - c[0]) * sx;
    let z = (pa.getZ(i) - c[2]) * sz;
    if (alignTop) z += (zTop - c[2]) * (1 - sz);
    const x2 = x * cs - z * sn;
    const z2 = x * sn + z * cs;
    pa.setXYZ(i, c[0] + x2, pa.getY(i), c[2] + z2);
  }
  pa.needsUpdate = true;
  geo.computeVertexNormals();
}

function splitEyes() {
  if (!new URLSearchParams(location.search).has('eyes')) return;
  if (EYESPLIT.ready) return;
  let mesh = null;
  hero.wrap.traverse((o) => { if (!mesh && o.isSkinnedMesh) mesh = o; });
  if (!mesh || !mesh.geometry.index || !mesh.geometry.attributes.uv) return;
  const geo = mesh.geometry, pa = geo.attributes.position, idx = geo.index;
  /* 判定"是不是眼睛"，不看椭圆，直接看贴图：眼区附近、且贴图上是黑的三角形才是眼睛。
     这样切出来的范围就等于原画那只黑眼，不会偏、不会大。 */
  const map = mesh.material.map;
  const img = map && map.image;
  if (!img) return;
  const cw = img.width, ch = img.height;
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const c2d = cv.getContext('2d', { willReadFrequently: true });
  c2d.drawImage(img, 0, 0);
  const pix = c2d.getImageData(0, 0, cw, ch).data;
  const ua0 = geo.attributes.uv;
  const lumAt = (i) => {
    const u = ua0.getX(i) % 1, v = ua0.getY(i) % 1;
    const px2 = Math.min(cw - 1, Math.max(0, Math.floor(u * cw)));
    const py2 = Math.min(ch - 1, Math.max(0, Math.floor(v * ch)));
    const o = (py2 * cw + px2) * 4;
    return pix[o] * 0.299 + pix[o + 1] * 0.587 + pix[o + 2] * 0.114;
  };

  const TC = idx.count / 3;
  const eyeOf = new Int8Array(TC).fill(-1);
  for (let t = 0; t < TC; t++) {
    const a = idx.getX(t * 3), b = idx.getX(t * 3 + 1), cc = idx.getX(t * 3 + 2);
    const cx = (pa.getX(a) + pa.getX(b) + pa.getX(cc)) / 3;
    const cy = (pa.getY(a) + pa.getY(b) + pa.getY(cc)) / 3;
    const cz = (pa.getZ(a) + pa.getZ(b) + pa.getZ(cc)) / 3;
    for (let e = 0; e < 2; e++) {
      /* 位置放宽到眼睛的 1.8 倍范围（只用来圈定候选），真正判定靠贴图黑度 */
      const dx = (cx - EYESPLIT.C[e][0]) / (EYESPLIT.RX * 1.8);
      const dz = (cz - EYESPLIT.C[e][2]) / (EYESPLIT.RZ * 1.8);
      if (dx * dx + dz * dz > 1) continue;
      if (Math.abs(cy - EYESPLIT.C[e][1]) > 0.0020) continue;   /* 只取脸皮这一层 */
      const La = lumAt(a), Lb = lumAt(b), Lc = lumAt(cc);
      const Lavg = (La + Lb + Lc) / 3;
      const Lmin = Math.min(La, Lb, Lc);
      /* 只要这个三角形贴着黑眼（平均黑，或至少一个角是黑的）就算眼睛，
         这样切出来正好是整只眼睛，不会缺一块把垫片露出来 */
      if (Lavg > 110 && Lmin > 62) continue;
      eyeOf[t] = e; break;
    }
  }
  const eyeTris = [[], []], bodyTris = [];
  for (let t = 0; t < TC; t++) (eyeOf[t] < 0 ? bodyTris : eyeTris[eyeOf[t]]).push(t);
  window.__splitInfo = { eyeL: eyeTris[0].length, eyeR: eyeTris[1].length, body: bodyTris.length };
  if (eyeTris[0].length < 6 || eyeTris[1].length < 6) return;

  /* 黑色眼片材质：平涂，不受光（原画就是一块纯黑） */
  EYESPLIT.mat = new THREE.MeshBasicMaterial({ color: 0x140f0d, toneMapped: false, side: THREE.DoubleSide });
  disposables.push(EYESPLIT.mat);

  mesh.updateMatrixWorld(true);
  const mk = (g, mat) => {
    const sm = new THREE.SkinnedMesh(g, mat);
    sm.bind(mesh.skeleton, mesh.bindMatrix);
    sm.frustumCulled = false;
    sm.matrixAutoUpdate = false;
    sm.matrix.copy(mesh.matrix);
    sm.visible = false;
    mesh.parent.add(sm);
    return sm;
  };

  for (let e = 0; e < 2; e++) {
    const eg = _subGeo(geo, eyeTris[e]);
    /* 眼片的 UV 中心（用于把皮肤贴片的 UV 往外扩） */
    const ua = eg.attributes.uv;
    let ucx = 0, ucy = 0;
    for (let i = 0; i < ua.count; i++) { ucx += ua.getX(i); ucy += ua.getY(i); }
    ucx /= ua.count; ucy /= ua.count;
    EYESPLIT.uvC[e] = [ucx, ucy];

    /* 皮肤贴片：与眼睛同尺寸，平涂肤色，只垫在眼睛正后方。
       改动范围严格限定在眼睛椭圆内，不再外扩、不再借 UV（借 UV 会采到杂色）。 */
    const capG = eg.clone();
    const cp = capG.attributes.position;
    const c = EYESPLIT.C[e];
    for (let i = 0; i < cp.count; i++) {
      cp.setXYZ(i, cp.getX(i), cp.getY(i) + 0.00028, cp.getZ(i));
    }
    cp.needsUpdate = true;
    if (!EYESPLIT.capMat) {
      EYESPLIT.capMat = new THREE.MeshBasicMaterial({ color: 0xd6d9de, toneMapped: false, side: THREE.DoubleSide });
      disposables.push(EYESPLIT.capMat);
    }
    capG.computeBoundingSphere();
    const cap = mk(capG, EYESPLIT.capMat);
    cap.name = 'eyeCap_' + (e ? 'R' : 'L');
    cap.visible = true;
    EYESPLIT.groups['cap' + e] = cap;

    /* 六种形状 */
    EYESPLIT.base[e] = eg;
    EYESPLIT.groups['eye' + e] = {};
    for (const kind of EYESPLIT.kinds) {
      if (kind === 'x') {
        for (const sgn of [-1, 1]) {
          const g2 = eg.clone();
          _deform(g2, c, { sx: 0.30, sz: 0.94, rz: sgn * Math.PI / 4 });
          g2.computeBoundingSphere();
      const m = mk(g2, EYESPLIT.mat);
          m.name = 'eye_x' + (sgn < 0 ? 'a' : 'b') + (e ? 'R' : 'L');
          (EYESPLIT.groups['eye' + e]['x'] = EYESPLIT.groups['eye' + e]['x'] || []).push(m);
        }
        continue;
      }
      let g2;
      if (kind === 'neutral') g2 = eg.clone();
      else if (kind === 'half') { g2 = eg.clone(); _deform(g2, c, { sz: 0.52, alignTop: true }); }
      else if (kind === 'line') { g2 = eg.clone(); _deform(g2, c, { sz: 0.16 }); }
      else if (kind === 'doze') { g2 = eg.clone(); _deform(g2, c, { sz: 0.26, alignTop: true }); }
      else if (kind === 'ring') {
        g2 = new THREE.TorusGeometry(0.00155, 0.00042, 8, 26);
        g2.rotateX(Math.PI / 2);
        g2.translate(c[0], c[1] - 0.0004, c[2]);
      }
      const m = mk(g2, EYESPLIT.mat);
      m.name = 'eye_' + kind + (e ? 'R' : 'L');
      EYESPLIT.groups['eye' + e][kind] = m;
    }
  }

  /* 身体网格去掉眼区三角形 */
  const bodyG = _subGeo(geo, bodyTris);
  bodyG.computeBoundingSphere();
  mesh.geometry = bodyG;
  EYESPLIT.mesh = mesh;
  EYESPLIT.ready = true;
  applyEyeSplit();
}

function applyEyeSplit() {
  if (!EYESPLIT.ready) return;
  let k = EXPR.cur;
  if (k === 'shy') k = 'half';
  if (k === 'caught') k = 'line';
  for (let e = 0; e < 2; e++) {
    const g = EYESPLIT.groups['eye' + e];
    if (!g) continue;
    for (const kind of Object.keys(g)) {
      const arr = Array.isArray(g[kind]) ? g[kind] : [g[kind]];
      arr.forEach((m) => { m.visible = (kind === k); });
    }
  }
}

function buildEyeModules() {
  if (!new URLSearchParams(location.search).has('eyes')) return;
  if (!EXPR.head || !hero.wrap) return;
  fetch('./assets/opt/eyes.json').then((r) => r.json()).then((DATA) => {
    EYEMOD.DATA = DATA;
    rebuildEyes();
  }).catch(() => {});
}

/* 按该处脸的实际起伏算外推量：让镜片的边缘整圈都越过脸皮，那样看到的是镜片自己的椭圆轮廓，
   而不是"脸和镜片相交"出来的月牙。两只眼各算各的，因为脸是曲面。 */
function autoEyeOffset(lens, A, F, R, U, K, facePts) {
  const pa = lens.attributes.position;
  const n = pa.count;
  const r = new Float32Array(n);
  let rmax = 0;
  for (let i = 0; i < n; i++) {
    const rr = Math.hypot(pa.getX(i) * K[0], pa.getZ(i) * K[2]);
    r[i] = rr;
    if (rr > rmax) rmax = rr;
  }
  const rim = rmax * 0.88;
  let need = 0;
  const w = new THREE.Vector3();
  const stepRim = Math.max(1, Math.floor(n / 260));
  for (let i = 0; i < n; i += stepRim) {
    if (r[i] < rim) continue;
    w.set(0, 0, 0)
      .addScaledVector(R, pa.getX(i) * K[0])
      .addScaledVector(F, pa.getY(i) * K[1])
      .addScaledVector(U, pa.getZ(i) * K[2])
      .add(A);
    let best = Infinity, bi = -1;
    for (let j = 0; j < facePts.length; j++) {
      const d = w.distanceToSquared(facePts[j]);
      if (d < best) { best = d; bi = j; }
    }
    if (bi < 0) continue;
    const clear = w.sub(facePts[bi]).dot(F);   // 正=在脸前方
    if (-clear > need) need = -clear;
  }
  return need;
}

/* 用户给的拆分件已是"同角色同空间"，眼片几何直接搬过来；只做一次相似变换 */
function rebuildEyes() {
  const DATA = EYEMOD.DATA;
  const head = EXPR.head;
  if (!DATA || !head || !hero.wrap) return;
  hero.wrap.updateMatrixWorld(true);
  head.updateWorldMatrix(true, false);
  let skin = null;
  hero.wrap.traverse((o) => { if (!skin && o.isSkinnedMesh) skin = o; });
  if (!skin) return;

  Object.keys(EYEMOD.parts).forEach((k) => {
    EYEMOD.parts[k].forEach((g) => { if (g.parent) g.parent.remove(g); });
  });
  EYEMOD.parts = {};
  EYEMOD.kinds.forEach((k) => { EYEMOD.parts[k] = []; });

  const cfg = EYEMOD.cfg;
  const mat = eyeMat();
  const A = [0, 1].map((i) => head.localToWorld(EXPR.anchors[i].clone()));
  const invHead = new THREE.Matrix4().copy(head.matrixWorld).invert();
  const wrapInv = new THREE.Matrix4().copy(hero.wrap.matrixWorld).invert();
  const wup = new THREE.Vector3(0, 1, 0);
  const K = cfg.K;

  ['L', 'R'].forEach((key, i) => {
    const d = DATA[key];
    if (!d) return;
    const lens = new THREE.BufferGeometry();
    lens.setAttribute('position', new THREE.Float32BufferAttribute(d.p, 3));
    lens.setIndex(d.f);
    lens.computeBoundingBox();
    const bc = new THREE.Vector3();
    lens.boundingBox.getCenter(bc);
    lens.translate(-bc.x, -bc.y, -bc.z);
    lens.computeVertexNormals();
    const sz = new THREE.Vector3();
    lens.boundingBox.getSize(sz);

    /* 朝外方向 = 附近顶点法线的平均（脸皮真实朝向），并用网格中心做同向校验 */
    const hw = head.getWorldPosition(new THREE.Vector3());
    const F = avgNormalNear(skin, A[i], A[0].distanceTo(A[1]) * 0.5)
      || A[i].clone().sub(hw).normalize();
    const meshC = new THREE.Vector3();
    skin.geometry.computeBoundingSphere();
    meshC.copy(skin.geometry.boundingSphere.center).applyMatrix4(skin.matrixWorld);
    if (F.dot(A[i].clone().sub(meshC)) < 0) F.negate();
    const R = new THREE.Vector3().crossVectors(wup, F);
    if (R.lengthSq() < 1e-8) R.set(1, 0, 0);
    R.normalize();
    const U = new THREE.Vector3().crossVectors(F, R).normalize();
    const basis = new THREE.Matrix4().makeBasis(R, F, U);

    /* 该眼附近的脸皮顶点（用于判断镜片边缘是否越过脸面） */
    const facePts = [];
    {
      const pa2 = skin.geometry.attributes.position;
      const vv = new THREE.Vector3();
      const lim = 1.6 * A[i].distanceTo(A[1 - i]);
      for (let q = 0; q < pa2.count; q++) {
        vv.fromBufferAttribute(pa2, q);
        skin.applyBoneTransform(q, vv);
        vv.applyMatrix4(skin.matrixWorld);
        if (vv.distanceToSquared(A[i]) < lim * lim) facePts.push(vv.clone());
      }
    }
    const thick = (lens.boundingBox.max.y - lens.boundingBox.min.y) * K[1] * cfg.thin;
    const offFinal = thick * cfg.out;
    EYEMOD.lastOff = EYEMOD.lastOff || [];
    EYEMOD.lastOff[i] = +offFinal.toFixed(5);
    EYEMOD.lastOff = EYEMOD.lastOff || [];
    EYEMOD.lastOff[i] = +offFinal.toFixed(5);
    const pos = A[i].clone().addScaledVector(F, offFinal);
    const M = new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z)
      .multiply(basis)
      .multiply(new THREE.Matrix4().makeScale(K[0], K[1] * cfg.thin, K[2]));
    const localM = new THREE.Matrix4().multiplyMatrices(invHead, M);
    EYEMOD.frames[i] = { A: A[i].clone(), F: F.clone(), R: R.clone(), U: U.clone(), span: sz.clone() };

    EYEMOD.kinds.forEach((k) => {
      const grp = buildEyeGeo(k, lens, sz.x, mat);
      grp.matrixAutoUpdate = false;
      grp.matrix.copy(new THREE.Matrix4().multiplyMatrices(wrapInv, M));
      grp.userData.local = localM;
      grp.name = 'eye_' + k + '_' + key;
      hero.wrap.add(grp);
      EYEMOD.parts[k].push(grp);
    });
  });

  EYEMOD.ready = true;
  window.__eyeModsReady = () => true;
  applyEyeVisibility();
}

/* 评估视图：相机位置/朝向全部由几何算出，不再人工量屏幕像素。?eyelab=1 */
const EYELAB_ON = new URLSearchParams(location.search).has('eyelab');
function eyeLabApply() {
  if (!EYEMOD.ready || !EYEMOD.frames.length || !EYEMOD.frames[1]) return;
  const f0 = EYEMOD.frames[0], f1 = EYEMOD.frames[1];
  const mid = f0.A.clone().add(f1.A).multiplyScalar(0.5);
  const span = f0.A.distanceTo(f1.A);
  const F = f0.F.clone().add(f1.F).normalize();
  const up0 = new THREE.Vector3(0, 1, 0);
  const R = new THREE.Vector3().crossVectors(up0, F).normalize();
  const U = new THREE.Vector3().crossVectors(F, R).normalize();
  camera.up.copy(U);
  const dist = span * (window.__labDist || 3.2);
  camera.position.copy(mid).addScaledVector(F, dist);
  camera.lookAt(mid);
  camera.near = Math.max(span * 0.03, 1e-4);
  camera.far = dist * 30;
  camera.updateProjectionMatrix();
  window.__labSpan = span;
  window.__labMid = mid.toArray().map((v) => +v.toFixed(5));
}

window.__eyeNoDepth = (b) => {
  const m = EYEMOD.matFlat;
  if (!m) return 'no mat';
  m.depthTest = !b;
  m.needsUpdate = true;
  return b ? 'overlay' : 'normal';
};

window.__eyeColor = (hex) => {
  if (EYEMOD.matFlat) EYEMOD.matFlat.color.setHex(hex);
  return hex;
};

/* 用"屏幕像素"微调锚点，并用当前相机焦距换算成头部局部单位（一次性标定用） */
window.__nudgeAnchor = (i, dxPx, dyPx) => {
  const f0 = EYEMOD.frames[0], f1 = EYEMOD.frames[1];
  if (!f0 || !f1) return '{}';
  const head = EXPR.head;
  head.updateWorldMatrix(true, false);
  const f = EYEMOD.frames[i];
  const span = f0.A.distanceTo(f1.A);
  const dist = span * (window.__labDist || 3.2);
  const upx = (2 * dist * Math.tan((camera.fov * Math.PI / 180) / 2)) / innerHeight;
  const d = f.R.clone().multiplyScalar(dxPx * upx).addScaledVector(f.U, -dyPx * upx);
  const inv = new THREE.Matrix4().copy(head.matrixWorld).invert();
  const l0 = f.A.clone().applyMatrix4(inv);
  const l1 = f.A.clone().add(d).applyMatrix4(inv);
  EXPR.anchors[i].add(l1.sub(l0));
  rebuildEyes();
  return JSON.stringify({ i, upx: +upx.toExponential(3), anchor: EXPR.anchors[i].toArray().map((v) => +v.toFixed(6)) });
};

window.__anchorPx = () => {
  const out = [];
  for (let i = 0; i < 2; i++) {
    const f = EYEMOD.frames[i];
    if (!f) { out.push(null); continue; }
    const q = f.A.clone().project(camera);
    out.push([Math.round((q.x * 0.5 + 0.5) * innerWidth), Math.round((-q.y * 0.5 + 0.5) * innerHeight)]);
  }
  return JSON.stringify(out);
};

window.__EYEMOD_W = EYEMOD;

window.__eyeShow = (b) => {
  EYEMOD.hidden = !b;
  applyEyeVisibility();
  return b ? 'on' : 'off';
};

window.__eyeTune = (o) => {
  Object.assign(EYEMOD.cfg, o || {});
  rebuildEyes();
  return JSON.stringify(EYEMOD.cfg);
};

/* 眼窝：用高密度头部挖出来的凹坑补片，UV 从主角迁移而来，所以肤色与脸完全一致 */
function buildEyeSockets() {
  fetch('./assets/opt/socket.json').then((r) => r.json()).then((DATA) => {
    const head = EXPR.head;
    if (!head) return;
    head.updateWorldMatrix(true, false);
    hero.wrap.updateMatrixWorld(true);
    let skin = null;
    hero.wrap.traverse((o) => { if (!skin && o.isSkinnedMesh) skin = o; });
    if (!skin) return;

    const A = [0, 1].map((i) => head.localToWorld(EXPR.anchors[i].clone()));
    const Rx = A[1].clone().sub(A[0]).normalize();
    const WU = new THREE.Vector3(0, 1, 0);
    const N = new THREE.Vector3().crossVectors(Rx, WU).normalize();
    const U = new THREE.Vector3().crossVectors(N, Rx).normalize();
    const Yax = new THREE.Vector3().crossVectors(U, Rx).normalize();
    const basis = new THREE.Matrix4().makeBasis(Rx, Yax, U);
    const invHead = new THREE.Matrix4().copy(head.matrixWorld).invert();
    const wrapInv = new THREE.Matrix4().copy(hero.wrap.matrixWorld).invert();
    const S = 0.1438;
    let n = 0;

    ['L', 'R'].forEach((key, i) => {
      const d = DATA[key];
      if (!d) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(d.p, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv, 2));
      g.setIndex(d.f);
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, skin.material);
      const M = new THREE.Matrix4().makeTranslation(A[i].x, A[i].y, A[i].z)
        .multiply(basis)
        .multiply(new THREE.Matrix4().makeScale(
          S * (window.__sockK || 0.92), S * (window.__sockK || 0.92), S * (window.__sockK || 0.92)));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(new THREE.Matrix4().multiplyMatrices(wrapInv, M));
      mesh.userData.local = new THREE.Matrix4().multiplyMatrices(invHead, M);
      mesh.name = 'socket_' + key;
      hero.wrap.add(mesh);
      EYEMOD.sockets.push(mesh);
      n++;
    });
    window.__socketBuilt = n;
  }).catch(() => {});
}

const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();

function updateEyeModules() {
  if (!EYEMOD.ready || !EXPR.head || !hero.wrap) return;
  const head = EXPR.head;
  head.updateWorldMatrix(true, false);
  hero.wrap.updateMatrixWorld(true);
  _m1.copy(hero.wrap.matrixWorld).invert();
  let k = EXPR.cur;
  if (k === 'shy') k = 'half';
  if (k === 'caught') k = 'line';
  const list = EYEMOD.parts[k];
  if (list) {
    for (let i = 0; i < list.length; i++) {
      _m2.multiplyMatrices(head.matrixWorld, list[i].userData.local);
      list[i].matrix.multiplyMatrices(_m1, _m2);
    }
  }
  for (let i = 0; i < EYEMOD.sockets.length; i++) {
    _m2.multiplyMatrices(head.matrixWorld, EYEMOD.sockets[i].userData.local);
    EYEMOD.sockets[i].matrix.multiplyMatrices(_m1, _m2);
  }
}

function applyEyeVisibility() {
  if (!EYEMOD.ready) return;
  let k = EXPR.cur;
  if (k === 'shy') k = 'half';
  if (k === 'caught') k = 'line';
  Object.keys(EYEMOD.parts).forEach((kind) => {
    const on = (kind === k) && !EYEMOD.hidden;
    EYEMOD.parts[kind].forEach((g) => { g.visible = on; });
  });
}


/* 调试用：按“屏幕像素”微调眼锚点（正 dx 向右、正 dy 向下），收敛后把结果固化进 anchors */
window.__nudgeEye = (i, dxPx, dyPx) => {
  const h = EXPR.head;
  if (!h) return null;
  h.updateWorldMatrix(true, false);
  const p = h.localToWorld(EXPR.anchors[i].clone());
  const dist = p.distanceTo(camera.position);
  const perPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / innerHeight;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  p.addScaledVector(right, dxPx * perPx).addScaledVector(up, -dyPx * perPx);
  EXPR.anchors[i].copy(h.worldToLocal(p));
  return EXPR.anchors[i].toArray().map((v) => +v.toFixed(6));
};
window.__eyeScreen = () => {
  const h = EXPR.head;
  if (!h) return null;
  h.updateWorldMatrix(true, false);
  return EXPR.anchors.map((a) => {
    const v = h.localToWorld(a.clone()).project(camera);
    return [Math.round((v.x * 0.5 + 0.5) * innerWidth), Math.round((-v.y * 0.5 + 0.5) * innerHeight)];
  });
};

/* ============================================================================
   主角交互 P0：被注视反应
   设计（已定稿）：视线判定 → 单向升温（察觉→害羞→恼火→躲开）→ 博弈（偷瞄/抓包）
   优先级：咬钩 > 恼火 > 害羞 > 察觉 > 钓鱼中
   ========================================================================== */
const LOOK = {
  on: false, head: null, q0: null,
  state: 'fish', prev: 'fish', stare: 0, away: 0, annoy: 0,
  peek: 0, peekCd: 0, snap: 0, wasSeen: false,
  bubble: null, bubbleCv: null, tex: null, bubT: 0,
  lastExpr: '', tgt: new THREE.Quaternion(),
};
const _lk = {
  hp: new THREE.Vector3(), camF: new THREE.Vector3(), toH: new THREE.Vector3(),
  face: new THREE.Vector3(), want: new THREE.Vector3(), awayV: new THREE.Vector3(),
  pQ: new THREE.Quaternion(), bQ: new THREE.Quaternion(), dq: new THREE.Quaternion(),
  e: new THREE.Euler(), up: new THREE.Vector3(0, 1, 0), q: new THREE.Quaternion(),
  inv: new THREE.Quaternion(),
};
const LOOK_YAW = 1.05, LOOK_PDN = -0.52, LOOK_PUP = 0.58;

function lookInit(obj) {
  const head = obj.getObjectByName('Head');
  if (!head || !head.parent) return;
  LOOK.head = head;
  LOOK.q0 = head.quaternion.clone();
  LOOK.on = hero.mode === 'fish';
  window.__look = LOOK;
  const Q = new URLSearchParams(location.search);
  if (Q.has('lookset')) { LOOK.state = Q.get('lookset'); LOOK.prev = LOOK.state; }
}

function lookBubble() {
  if (LOOK.bubble) return LOOK.bubble;
  const c = document.createElement('canvas');
  c.width = 512; c.height = 160;
  LOOK.bubbleCv = c;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  LOOK.tex = tex;
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0, fog: false,
  });
  const s = new THREE.Sprite(mat);
  s.renderOrder = 70; s.visible = false;
  globe.add(s);
  LOOK.bubble = s;
  disposables.push(mat);
  return s;
}

function say(text) {
  lookBubble();
  const c = LOOK.bubbleCv, g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  g.font = '600 52px "Microsoft YaHei", system-ui, sans-serif';
  const tw = Math.min(W - 40, g.measureText(text).width + 60);
  const bh = 96, x0 = (W - tw) / 2, y0 = 16, r = 22;
  g.fillStyle = 'rgba(16,20,30,0.92)';
  g.beginPath();
  g.moveTo(x0 + r, y0);
  g.arcTo(x0 + tw, y0, x0 + tw, y0 + bh, r);
  g.arcTo(x0 + tw, y0 + bh, x0, y0 + bh, r);
  g.arcTo(x0, y0 + bh, x0, y0, r);
  g.arcTo(x0, y0, x0 + tw, y0, r);
  g.closePath(); g.fill();
  g.beginPath();
  g.moveTo(W / 2 - 13, y0 + bh - 3);
  g.lineTo(W / 2, y0 + bh + 20);
  g.lineTo(W / 2 + 13, y0 + bh - 3);
  g.closePath(); g.fill();
  g.fillStyle = '#eef3fb';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, W / 2, y0 + bh / 2 + 3);
  LOOK.tex.needsUpdate = true;
  LOOK.bubble.scale.set(0.108, 0.0338, 1);
  LOOK.bubT = 2.8;
}

function updateLook(dt) {
  const L = LOOK;
  if (!L.on || !L.head) return;
  const head = L.head;
  head.updateWorldMatrix(true, false);

  const hp = head.getWorldPosition(_lk.hp);
  const camF = camera.getWorldDirection(_lk.camF);
  const toH = _lk.toH.copy(hp).sub(camera.position);
  const dist = toH.length();
  if (dist > 1e-5) toH.normalize();
  const seen = camF.dot(toH) > 0.90 && dist < 0.95;
  const biting = hero.fish && hero.fish.bite > 0;

  /* ===== 2026-11-04 副本：被看 5 秒 → 害羞 =====
     与旧版的差别：旧版有 4 级递进（察觉1.1s/害羞3.2s/恼火6.4s/躲避9.5s），
     这里简化成单一阈值 —— **连续被看满 5 秒才害羞**，中途移开立即重置。
     这样做的好处：玩家必须真的"盯着看"，而不是扫一眼就触发；
     害羞之后如果继续看，会进入"躲避"（转头/低头），
     移开视线 2 秒后恢复钓鱼。

     状态机：
       fish  --连续被看5s-->  shy  --继续被看2s-->  avoid
         ^                                          |
         +----------- 移开视线 2s 后恢复 -------------+ */
  const SHY_AFTER = 5.0;     // 连续被看多久进入害羞
  const AVOID_AFTER = 2.0;   // 害羞后继续被看多久开始躲避
  const RECOVER_AFTER = 2.0; // 移开视线多久恢复

  if (biting) {
    // 咬钩优先，打断所有社交状态
    L.stare = 0; L.away = 0; L.state = 'fish';
  } else if (L.state === 'fish') {
    if (seen) { L.stare += dt; L.away = 0; }
    else { L.stare = Math.max(0, L.stare - dt * 1.6); L.away += dt; }  // 移开时回退得更快
    if (L.stare >= SHY_AFTER) {
      L.state = 'shy';
      L.stare = 0;
      L.shyT = 0;
      say('……别一直看');       // 第一次害羞的台词
    }
  } else if (L.state === 'shy') {
    if (seen) { L.shyT += dt; L.away = 0; }
    else { L.away += dt; }
    if (L.shyT >= AVOID_AFTER) { L.state = 'avoid'; L.avoidT = 0; }
    if (L.away >= RECOVER_AFTER) { L.state = 'fish'; L.stare = 0; }
  } else if (L.state === 'avoid') {
    if (seen) { L.avoidT += dt; L.away = 0; }
    else { L.away += dt; }
    if (L.away >= RECOVER_AFTER) { L.state = 'fish'; L.stare = 0; }
  }

  /* 偷瞄：玩家移开 0.6s 后回看一眼 */
  if (L.state !== 'fish' && !seen && L.away > 0.6 && L.peek <= 0 && L.peekCd <= 0) {
    L.peek = 0.42; L.peekCd = 3.4;
  }
  /* 抓包：他偷瞄时玩家猛地看回来 → 0.12s 内转回鱼竿 */
  if (seen && !L.wasSeen && L.state !== 'fish' && (L.peek > 0 || L.peekCd > 2.7)) {
    L.snap = 0.5;
  }
  L.wasSeen = seen;
  if (L.peek > 0) L.peek = Math.max(0, L.peek - dt);
  if (L.peekCd > 0) L.peekCd = Math.max(0, L.peekCd - dt);
  if (L.snap > 0) L.snap = Math.max(0, L.snap - dt);

  /* ---- 目标朝向 ---- */
  const pQ = head.parent.getWorldQuaternion(_lk.pQ);
  const bQ = _lk.bQ.copy(pQ).multiply(L.q0).multiply(_lk.q.setFromAxisAngle(_lk.up, -Math.PI / 4));
  const face = _lk.face.set(0, 0, 1).applyQuaternion(bQ);
  const toCam = _lk.want.copy(camera.position).sub(hp).normalize();

  /* ---- 头部朝向（副本版：只保留 fish / shy / avoid 三态）---- */
  let want = null, speed = 2.4;
  if (L.snap > 0) { want = null; speed = 20; }
  else if (L.peek > 0) { want = toCam; speed = 5.5; }
  else if (L.state === 'shy') {
    /* 害羞：不敢直视，视线偏开 40°、头微微低下
       —— 这是"被看害羞"最典型的小动作 */
    want = _lk.awayV.copy(toCam).applyAxisAngle(_lk.up, 0.70);
    want.y -= 0.30; want.normalize(); speed = 2.2;
  } else if (L.state === 'avoid') {
    /* 躲开：彻底转向另一侧、低头看鱼竿 */
    want = _lk.awayV.copy(toCam).multiplyScalar(-1);
    want.y = -0.55; want.normalize(); speed = 2.6;
  }
  /* fish 状态：want = null → 头回到 q0（原来的钓鱼姿态） */

  if (want) {
    _lk.dq.setFromUnitVectors(face, want);
    const e = _lk.e.setFromQuaternion(_lk.dq, 'YXZ');
    e.y = THREE.MathUtils.clamp(e.y, -LOOK_YAW, LOOK_YAW);
    e.x = THREE.MathUtils.clamp(e.x, LOOK_PDN, LOOK_PUP);
    e.z = 0;
    _lk.dq.setFromEuler(e);
    const local = _lk.dq.premultiply(_lk.inv.copy(pQ).invert()).multiply(pQ);
    L.tgt.copy(L.q0).premultiply(local);
  } else {
    L.tgt.copy(L.q0);
  }
  const k = 1 - Math.exp(-speed * dt);
  head.quaternion.slerp(L.tgt, k);

  /* ---- 表情（副本版：neutral / shy / half 三态）----
     注意：新角色 boy.glb 是无脸模型，setExpr 目前只记录状态、
     真正的表情要靠几何眼球/嘴巴实现（尚未做）。
     这里仍然驱动它，方便以后接上时不用改状态机。 */
  let we = 'neutral';
  if (L.state === 'shy') we = 'shy';
  else if (L.state === 'avoid') we = 'half';
  if (we !== L.lastExpr) { L.lastExpr = we; if (typeof setExpr === 'function') setExpr(we); }

  /* ---- 台词（只在状态转变时说一次）---- */
  if (L.state !== L.prev) {
    if (L.state === 'shy') say('……你别一直看');
    else if (L.state === 'avoid') say('……');
    L.prev = L.state;
  }

  /* ---- 气泡跟随 ---- */
  if (L.bubT > 0) {
    L.bubT = Math.max(0, L.bubT - dt);
    const s = L.bubble;
    const o = Math.min(1, L.bubT / 0.35) * 0.95;
    s.material.opacity = o;
    s.visible = o > 0.02;
    s.position.copy(hp).addScaledVector(_lk.up, EXPR.span * 1.45);
  } else if (L.bubble) {
    L.bubble.visible = false;
  }
}

function updateHero(dt) {
  if (!hero.wrap) return;

  if (hero.mode === 'fish') { updateFish(dt); return; }

  if (hero.hop > 0) hero.hop = Math.max(0, hero.hop - dt * 1.6);
  const hopY = Math.sin((1 - hero.hop) * Math.PI) * 0.022 * (hero.hop > 0 ? 1 : 0);

  let px, pz, tx, tz, gy, lean = 0;
  const skating = hero.mode === 'skate';

  if (skating) {
    // 冰湖绕圈：椭圆轨道 + 轻微蛇形，速度随「加速」事件提升
    hero.ang += dt * hero.omega * (1 + skaterBoost * 1.9);
    const a = hero.ang;
    const orbit = (ang) => {
      const w = 1 + Math.sin(ang * 3 + 0.7) * 0.09;   // 半径蛇形
      return [
        pond.cx + Math.cos(ang) * pond.rx * 0.52 * w,
        pond.cz + Math.sin(ang) * pond.rz * 0.52 * w,
      ];
    };
    const p0 = orbit(a), p1 = orbit(a + 0.02);
    px = p0[0]; pz = p0[1];
    tx = p1[0] - p0[0]; tz = p1[1] - p0[1];
    gy = surfY(Math.hypot(px, pz)) + pond.lift;
    // 过弯内倾 + 交替蹬冰的轻微起伏
    lean = 0.13 + Math.sin(a * 2) * 0.025;
  } else {
    if (hero.wait > 0) {
      hero.wait -= dt;
    } else {
      hero.t += (hero.speed * dt / hero.len) * hero.dir;
      if (hero.t >= 0.93) { hero.t = 0.93; hero.dir = -1; hero.wait = 1.4; }
      if (hero.t <= 0.07) { hero.t = 0.07; hero.dir = 1; hero.wait = 1.4; }
    }
    const u = THREE.MathUtils.clamp(hero.t, 0, 1);
    const p = hero.curve.getPointAt(u);
    const tg = hero.curve.getTangentAt(u);
    px = p.x; pz = p.z;
    tx = tg.x; tz = tg.z;
    gy = groundY(px, pz);
  }

  hero.wrap.position.set(px, gy + hero.groundOffset + 0.001 + hopY, pz);

  // 朝向：行进方向 + 平滑转身
  const yaw = Math.atan2(tx, tz) + (!skating && hero.dir < 0 ? Math.PI : 0);
  let d = yaw - hero.wrap.rotation.y;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  hero.wrap.rotation.y += d * Math.min(1, dt * 7);
  hero.wrap.rotation.z += (lean - hero.wrap.rotation.z) * Math.min(1, dt * 4);

  if (hero.mixer) {
    if (skating) {
      hero.mixer.timeScale = 0.68 * (1 + skaterBoost * 0.85);
      hero.mixer.update(dt);
    } else {
      hero.mixer.update(hero.wait > 0 ? 0 : dt);
    }
  }
  if (hero.shadow) {
    hero.shadow.position.set(px, gy + 0.004, pz);
    hero.shadow.material.opacity = (skating ? 0.24 : 0.3) - hopY * 6;
  }
}

/* ---------------- 摩天轮售票亭与排队护栏 ---------------- */

let stripeMat = null;
function getStripeMat() {
  if (stripeMat) return stripeMat;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 16;
  const x = c.getContext('2d');
  for (let i = 0; i < 8; i++) {
    x.fillStyle = i % 2 ? '#e8dcc4' : '#a63a2e';
    x.fillRect(i * 8, 0, 8, 16);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  stripeMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 });
  disposables.push(tex, stripeMat);
  return stripeMat;
}

function buildFerrisLot() {
  const B = LAYOUT.booth;
  const woodMat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0x8a5f3c, roughness: 0.85, metalness: 0 }), { kind: 'wood', repeat: 4, scale: 1.15 });
  const creamMat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0xe6dcc6, roughness: 0.88, metalness: 0 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const glassMat = addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0x141c26, roughness: 0.34, metalness: 0.1,
    emissive: 0xffb14d, emissiveIntensity: 0.6,
  }), { kind: 'fine', repeat: 7, scale: 0.75 });
  disposables.push(woodMat, creamMat, glassMat);

  const g = new THREE.Group();
  g.position.set(B.x, groundY(B.x, B.z) - B.sink, B.z);
  g.rotation.y = B.rot;
  g.scale.setScalar(1.28);

  // 柜台主体
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.032, 0.038), woodMat);
  body.position.y = 0.026;
  body.castShadow = CFG.shadows;
  body.receiveShadow = CFG.shadows;
  g.add(body);

  // 台面
  const counter = new THREE.Mesh(new THREE.BoxGeometry(0.066, 0.005, 0.044), creamMat);
  counter.position.y = 0.045;
  counter.castShadow = CFG.shadows;
  g.add(counter);

  // 售票窗口（暖光）
  const win = new THREE.Mesh(new THREE.PlaneGeometry(0.034, 0.014), glassMat);
  win.position.set(0, 0.0555, 0.0195);
  g.add(win);

  // 四角立柱
  const postGeo = new THREE.BoxGeometry(0.006, 0.060, 0.006);
  for (const [px, pz] of [[-0.028, 0.017], [0.028, 0.017], [-0.028, -0.017], [0.028, -0.017]]) {
    const p = new THREE.Mesh(postGeo, woodMat);
    p.position.set(px, 0.030, pz);
    g.add(p);
  }

  // 条纹雨棚
  const awning = new THREE.Mesh(new THREE.BoxGeometry(0.080, 0.004, 0.052), getStripeMat());
  awning.position.set(0, 0.070, 0.004);
  awning.rotation.x = -0.14;
  awning.castShadow = CFG.shadows;
  g.add(awning);

  // 顶部小尖顶
  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.036, 0.020, 4), creamMat);
  roof.position.y = 0.082;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = CFG.shadows;
  g.add(roof);

  // 价目牌
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.030, 0.010), addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0x1a2028, roughness: 0.9, emissive: 0x3a2a10, emissiveIntensity: 0.5,
  }), { kind: 'fine', repeat: 7, scale: 0.75 }));
  sign.position.set(0.032, 0.056, 0.0195);
  g.add(sign);

  // 暖光：售票口
  const lamp = new THREE.PointLight(0xffb066, 0.006, 0.30, 2);
  lamp.position.set(0, 0.058, 0.030);
  g.add(lamp);

  globe.add(g);
  registerKind(g, 'ferris', '售票亭');

  // 排队护栏：入口左侧一段，右侧由售票亭本身充当边界
  place(loaded.fence, LAYOUT.railA.x, LAYOUT.railA.z, LAYOUT.railA.rot, 0, LAYOUT.railA.sink);
  addContact(LAYOUT.railA.x, LAYOUT.railA.z, 0.070, 0.16);

  return g;
}

function buildProps() {
  const L = LAYOUT;

  // ---- 主屋 ----
  const cabin = place(loaded.cabin, L.cabin.x, L.cabin.z, L.cabin.rot, 0, L.cabin.sink);
  buildCabinDecor(cabin);
  addContact(L.cabin.x, L.cabin.z, 0.115, 0.30);
  addDrift(L.cabin.x + 0.10, L.cabin.z + 0.14, 0.105, 0.030, 0.050);
  addDrift(L.cabin.x + 0.10, L.cabin.z - 0.04, 0.075, 0.022, 0.05);
  if (cabin) {
    addChimneySmoke(cabin);
    registerKind(cabin, 'cabin', '木屋');
    cabinTopPos = new THREE.Vector3(L.cabin.x, groundY(L.cabin.x, L.cabin.z) + 0.26, L.cabin.z);
  }
  const warmA = new THREE.PointLight(0xffa855, 0.150, 0.34, 2);
  warmCabin = warmA;
  warmA.position.set(L.cabin.x, groundY(L.cabin.x, L.cabin.z) + 0.15, L.cabin.z + 0.08);
  globe.add(warmA);

  // ---- 后景小屋 ----
  if (loaded.cabin) {
    const far = loaded.cabin.clone(true);
    far.scale.multiplyScalar(L.cabinFar.scale);
    far.position.set(L.cabinFar.x, groundY(L.cabinFar.x, L.cabinFar.z) - L.cabinFar.sink, L.cabinFar.z);
    far.rotation.y = L.cabinFar.rot;
    globe.add(far);
    addContact(L.cabinFar.x, L.cabinFar.z, 0.085, 0.22);
    addDrift(L.cabinFar.x, L.cabinFar.z + 0.09, 0.10, 0.026, 0.05);
    registerKind(far, 'cabin', '小屋');
  }

  // ---- 路灯 / 邮筒 / 雪人 / 礼物 ----
  buildLampChain();
  addContact(L.lamp.x, L.lamp.z, 0.030, 0.26);
  addDrift(L.lamp.x + 0.01, L.lamp.z + 0.015, 0.045, 0.016, 0.04);

  /* 2026-11-03 按需求：移除雪橇（sled）与原木堆（buildYard），保留长椅。 */

  place(loaded.bench, L.bench.x, L.bench.z, L.bench.rot, 0, L.bench.sink);
  addContact(L.bench.x, L.bench.z, 0.042, 0.24);

  place(loaded.postbox, L.postbox.x, L.postbox.z, L.postbox.rot, 0, L.postbox.sink);
  addContact(L.postbox.x, L.postbox.z, 0.028, 0.24);

  fx.snowman = place(loaded.snowman, L.snowman.x, L.snowman.z, L.snowman.rot, 0, L.snowman.sink);
  fx.snowmanBase = { rot: L.snowman.rot, y: fx.snowman ? fx.snowman.position.y : 0 };
  addContact(L.snowman.x, L.snowman.z, 0.038, 0.26);
  addDrift(L.snowman.x, L.snowman.z + 0.015, 0.055, 0.018, 0.045);

  place(loaded.giftbox, L.giftA.x, L.giftA.z, L.giftA.rot, 0, L.giftA.sink);
  place(loaded.giftbox, L.giftB.x, L.giftB.z, L.giftB.rot, 0, L.giftB.sink);

  // ---- 摩天轮售票亭 + 排队护栏 ----
  buildFerrisLot();

  // ---- 中央小广场 ----
  buildPlaza();

  // ---- 背景树 ----
  place(loaded.tree, L.tree.x, L.tree.z, L.tree.rot, 0, L.tree.sink);
  addContact(L.tree.x, L.tree.z, 0.062, 0.30);
  addDrift(L.tree.x, L.tree.z + 0.015, 0.082, 0.03, 0.068);

  // ---- 地面痕迹 ----
  /* 2026-11-03：主街是第一人称的实际走动路线，原来只在角落有零星脚印，
     走到街上时地面几乎空白。这里沿主街中心线铺一整条往返脚印链。 */
  addFootprints([-0.31, 0.045], [0.08, 0.182], 26);
  addFootprints([0.08, 0.182], [0.44, 0.080], 26);
  addFootprints([-0.02, 0.170], [-0.19, 0.300], 14);
  addFootprints([0.445, 0.055], [0.396, -0.090], 12);
  addFootprints([-0.22, 0.28], [-0.27, 0.26], 6);
  addFootprints([-0.02, 0.20], [-0.13, 0.285], 10);
  addFootprints([0.44, 0.05], [0.41, -0.06], 6);
  addFootprints([0.31, 0.19], [0.33, 0.245], 5);
  // 冰湖边缘的凌乱脚印：有人在这里站过、蹲下过
  addFootprints([-0.16, 0.30], [-0.02, 0.34], 9);
  addFootprints([0.10, 0.36], [0.24, 0.30], 8);
  addDrift(0.17, 0.10, 0.10, 0.022, 0.08);
  addDrift(-0.02, -0.15, 0.13, 0.026, 0.10);
  addDrift(0.60, 0.28, 0.10, 0.020, 0.08);
  addDrift(-0.30, 0.44, 0.085, 0.019, 0.07);
  addDrift(0.24, 0.55, 0.075, 0.017, 0.06);
  addDrift(0.02, 0.24, 0.065, 0.014, 0.055);

  addPines();
  buildPointerLantern();
  buildSnowCover();
  buildDriftSnow();
  buildBreath();
  buildBrazier();
  buildPond();
  buildPaths();
  buildHero();

  // ---- 热气球：球内空间分层 ----
  const balloons = [
    { x: -0.62, z: 0.12, y: 0.34, s: 1.00, ph: 0 },
    { x: -0.36, z: -0.30, y: 0.62, s: 0.62, ph: 1.7 },
    { x: 0.46, z: -0.18, y: 0.76, s: 0.52, ph: 3.2 },
  ];
  balloons.forEach((b, i) => {
    if (!loaded.balloon) return;
    const o = loaded.balloon.clone(true);
    o.position.set(b.x, groundY(b.x, b.z) + b.y, b.z);
    o.scale.setScalar(b.s);
    o.rotation.y = i * 1.3;
    registerKind(o, 'balloon', '热气球');
    globe.add(o);
    animated.push({ type: 'balloon', obj: o, base: o.position.y, phase: b.ph, amp: 0.016 + i * 0.004, kick: 0 });
  });

}

/* ---------------- 布局校验：只在 ?debug=1 下输出 ---------------- */

let layoutReport = '';

function validateLayout() {
  if (!DBG) return;
  const pts = track.curve ? track.curve.getSpacedPoints(400) : [];
  const items = Object.entries(LAYOUT).map(([name, v]) => ({ name, ...v }));
  const issues = [];

  if (pts.length) {
    for (const it of items) {
      let minD = Infinity;
      for (const q of pts) minD = Math.min(minD, Math.hypot(q.x - it.x, q.z - it.z));
      const need = it.r + 0.045;
      if (minD < need) issues.push(`${it.name} 压轨 ${minD.toFixed(3)}<${need.toFixed(3)}`);
    }
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < (a.r + b.r) * 0.95) issues.push(`${a.name}×${b.name} ${d.toFixed(3)}`);
    }
  }
  layoutReport = issues.length ? issues.join(' | ') : `ok (${items.length})`;
  if (issues.length) console.warn('[layout]', layoutReport);
  else console.log('[layout]', layoutReport);
}

/* ---------------- 铁轨与小火车 ---------------- */

const track = { curve: null, cars: [], u: 0, lapSec: 46, len: 1, dwell: 0, stationU: 0.14, stationCD: 0 };

function buildTrack() {
  const pts = [];
  const N = 14;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = Math.cos(a) * 0.755;
    const z = Math.sin(a) * 0.665 + 0.05;
    pts.push(new THREE.Vector3(x, groundY(x, z) + 0.009, z));
  }
  track.curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
  track.len = track.curve.getLength();

  const railMat = addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0x8d9db0, metalness: 0.7, roughness: 0.52, envMapIntensity: 0.8,
  }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const tieMat = addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0x6a5342, metalness: 0.0, roughness: 0.9,
  }), { kind: 'fine', repeat: 7, scale: 0.75 });

  // 两条钢轨
  const offsetCurve = (off) => {
    const arr = [];
    const n = 200;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const p = track.curve.getPointAt(u);
      const t = track.curve.getTangentAt(u);
      const sx = -t.z, sz = t.x;
      const l = Math.hypot(sx, sz) || 1;
      arr.push(new THREE.Vector3(p.x + (sx / l) * off, p.y + 0.004, p.z + (sz / l) * off));
    }
    return new THREE.CatmullRomCurve3(arr, true);
  };
  [-0.024, 0.024].forEach(off => {
    const g = new THREE.TubeGeometry(offsetCurve(off), 260, 0.0038, 5, true);
    const m = new THREE.Mesh(g, railMat);
    m.castShadow = CFG.shadows;
    globe.add(m);
  });

  // 枕木
  const tieCount = 150;
  const tieGeo = new THREE.BoxGeometry(0.062, 0.006, 0.015);
  const ties = new THREE.InstancedMesh(tieGeo, tieMat, tieCount);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < tieCount; i++) {
    const u = i / tieCount;
    const p = track.curve.getPointAt(u);
    const t = track.curve.getTangentAt(u);
    dummy.position.set(p.x, p.y + 0.001, p.z);
    dummy.rotation.y = Math.atan2(t.x, t.z);
    dummy.updateMatrix();
    ties.setMatrixAt(i, dummy.matrix);
  }
  ties.castShadow = CFG.shadows;
  ties.receiveShadow = CFG.shadows;
  globe.add(ties);
}

function buildTrain() {
  const defs = [
    { key: 'train-loco', off: 0 },
    { key: 'train-car', off: 0.050 },
    { key: 'train-car', off: 0.102 },
  ];
  defs.forEach(d => {
    if (!loaded[d.key]) return;
    const o = loaded[d.key].clone(true);
    globe.add(o);
    track.cars.push({ obj: o, off: d.off });
  });
  track.u = 0;
}

function updateTrain(dt) {
  if (!track.cars.length) return;
  // 到站停靠：靠近月台时减速停顿
  if (track.dwell > 0) {
    track.dwell -= dt;
  } else {
    track.u = (track.u + dt / track.lapSec * S.train) % 1;
    const du = Math.abs(((track.u - track.stationU + 0.5) % 1) - 0.5);
    if (du < 0.006 && track.stationCD <= 0) {
      track.dwell = 2.6;
      track.stationCD = 30;
    }
    if (track.stationCD > 0) track.stationCD -= dt;
  }
  track.cars.forEach(c => {
    const u = (track.u - c.off + 1) % 1;
    const p = track.curve.getPointAt(u);
    const t = track.curve.getTangentAt(u);
    c.obj.position.set(p.x, p.y + 0.004, p.z);
    c.obj.rotation.y = Math.atan2(t.x, t.z);
  });
}


/* ---------------- 极光 ---------------- */

let auroraMat = null;
let auroraMat2 = null;      // 第二层：更远、更慢，制造纵深
function buildAurora() {
  /* 2026-11-03 重做极光：
     原来是一张静态 Canvas 贴图贴在球壳内壁，不透明度只有 0.16~0.22，
     而且"每三天才出现一次"——实际上基本看不见。
     真实极光的关键特征是：
       · 垂直的光幕（顶部淡、底部亮，有竖直条纹感）
       · 缓慢流动 + 呼吸式明暗
       · 多层叠加才有纵深
     现在改成两层、更强的垂直光幕贴图，并用 shader 时间做流动。 */
  const makeAuroraTex = (seed, hueA, hueB, bands) => {
    const W = 512, H = 512;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#000';
    cx.fillRect(0, 0, W, H);

    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);

    // 垂直光帘：每根都是一条从顶部渐隐、中部最亮、底部再渐隐的竖条
    // 主光帘：alpha 压低，极光是淡的
    cx.filter = 'blur(3px)';
    for (let i = 0; i < bands; i++) {
      const x = rnd() * W;
      const w = 6 + rnd() * 34;
      // 帘子高度与垂直位置随机，形成起伏的天际线
      const top = 20 + rnd() * 90;
      const bot = 300 + rnd() * 190;
      const useB = rnd() > 0.55;
      const c = useB ? hueB : hueA;
      const g = cx.createLinearGradient(0, top, 0, bot);
      g.addColorStop(0.00, `rgba(${c},0)`);
      g.addColorStop(0.18, `rgba(${c},${0.10 + rnd() * 0.14})`);
      g.addColorStop(0.45, `rgba(${c},${0.16 + rnd() * 0.18})`);
      g.addColorStop(0.72, `rgba(${c},${0.08 + rnd() * 0.12})`);
      g.addColorStop(1.00, `rgba(${c},0)`);
      cx.fillStyle = g;
      cx.fillRect(x - w / 2, top, w, bot - top);
    }
    // 细密的竖丝：极光的"帘幕褶皱"（这是锐度的主要来源）
    cx.filter = 'blur(0.4px)';
    for (let i = 0; i < bands * 9; i++) {
      const x = rnd() * W;
      const w = 0.6 + rnd() * 1.8;
      const top = 40 + rnd() * 120;
      const bot = 240 + rnd() * 220;
      const c = rnd() > 0.5 ? hueA : hueB;
      const g = cx.createLinearGradient(0, top, 0, bot);
      g.addColorStop(0, `rgba(${c},0)`);
      g.addColorStop(0.35, `rgba(${c},${0.14 + rnd() * 0.16})`);
      g.addColorStop(0.65, `rgba(${c},${0.10 + rnd() * 0.12})`);
      g.addColorStop(1, `rgba(${c},0)`);
      cx.fillStyle = g;
      cx.fillRect(x, top, w, bot - top);
    }
    cx.filter = 'none';

    /* 竖向遮罩：极光只在天空中段出现，靠近地平线和天顶都要淡出，
       否则球内壁会像贴了一圈绿纸。 */
    cx.globalCompositeOperation = 'multiply';
    const vm = cx.createLinearGradient(0, 0, 0, H);
    vm.addColorStop(0.00, '#000');
    vm.addColorStop(0.14, '#333');
    vm.addColorStop(0.30, '#ddd');
    vm.addColorStop(0.52, '#fff');
    vm.addColorStop(0.74, '#888');
    vm.addColorStop(0.90, '#111');
    vm.addColorStop(1.00, '#000');
    cx.fillStyle = vm;
    cx.fillRect(0, 0, W, H);
    // 横向遮罩：左右两侧淡出，避免球壳接缝
    const hm = cx.createLinearGradient(0, 0, W, 0);
    hm.addColorStop(0.00, '#000');
    hm.addColorStop(0.20, '#999');
    hm.addColorStop(0.50, '#fff');
    hm.addColorStop(0.80, '#999');
    hm.addColorStop(1.00, '#000');
    cx.fillStyle = hm;
    cx.fillRect(0, 0, W, H);
    cx.globalCompositeOperation = 'source-over';

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  };

  const addLayer = (tex, radius, phiStart, phiLen, thetaStart, thetaLen, opacity) => {
    /* 贴图横向重复：一张 512 宽的图铺满整圈 2π 会被拉伸，
       条纹糊成一片雾。重复后条纹密度更高，才有"光帘"的锐度。
       注意 vertical 方向不要重复，否则会出现地平线接缝。 */
    tex.repeat.set(3, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, opacity, side: THREE.DoubleSide, toneMapped: false,
      fog: false,
    });
    const geo = new THREE.SphereGeometry(radius, 64, 32, phiStart, phiLen, thetaStart, thetaLen);
    const m = new THREE.Mesh(geo, mat);
    m.raycast = () => {};
    m.renderOrder = -1;
    globe.add(m);
    mat._tex = tex;
    return mat;
  };

  /* 几何覆盖范围（2026-11-03 三次修正）：
     第一次整圈覆盖 → 边缘像瀑布。
     极光应该是"远处天边的一条淡光带"，只占天空的一小部分，
     大部分夜空仍然是深的星空。所以：
       · theta 只在 0.26π ~ 0.56π 之间（避开天顶，也避开地平线）
       · 透明度大幅降低（近层 0.55→0.30，远层 0.30→0.16）
     这样它是"点缀"，不是"主角"。 */
  // 近层：青绿为主
  auroraMat = addLayer(
    makeAuroraTex(20261103, '70,235,190', '120,200,255', 46),
    0.92, 0, Math.PI * 2, Math.PI * 0.26, Math.PI * 0.30,
    0.30
  );
  // 远层：紫蓝为主，更淡
  auroraMat2 = addLayer(
    makeAuroraTex(77712, '140,120,255', '90,170,240', 34),
    0.955, 0, Math.PI * 2, Math.PI * 0.22, Math.PI * 0.34,
    0.16
  );
}


/* ============================== 流星 ============================== */

const RAIN = new URLSearchParams(location.search).get('rain') === '1';
const meteors = { pool: [], timer: 2.6, alive: 0 };

function makeMeteorTex() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 32;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 256, 32);
  const g = x.createLinearGradient(0, 0, 256, 0);
  g.addColorStop(0.00, 'rgba(255,255,255,0)');
  g.addColorStop(0.55, 'rgba(190,220,255,0.30)');
  g.addColorStop(0.88, 'rgba(235,245,255,0.95)');
  g.addColorStop(1.00, 'rgba(255,255,255,1)');
  x.fillStyle = g;
  x.beginPath();
  x.moveTo(0, 16);
  x.quadraticCurveTo(200, 2, 256, 16);
  x.quadraticCurveTo(200, 30, 0, 16);
  x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildMeteors() {
  const tex = makeMeteorTex();
  for (let i = 0; i < 4; i++) {
    const m = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, opacity: 0, toneMapped: false,
    });
    m.blending = THREE.AdditiveBlending;
    const sp = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
    sp.visible = false;
    sp.frustumCulled = false;
    globe.add(sp);
    meteors.pool.push({
      sp, life: 0, ttl: 0, head: new THREE.Vector3(),
      dir: new THREE.Vector3(), speed: 1, len: 0.3, width: 0.02,
    });
  }
  disposables.push(tex);
}

function spawnMeteor() {
  const m = meteors.pool.find(x => x.life <= 0);
  if (!m) return;
  // 起点：球内上部随机一点
  const a = Math.random() * Math.PI * 2;
  const rr = 0.35 + Math.random() * 0.45;
  const y = 0.15 + Math.random() * 0.55;
  m.head.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
  // 方向：斜向下划过
  const d = new THREE.Vector3(
    -Math.sin(a) + (Math.random() - 0.5) * 0.8,
    -0.55 - Math.random() * 0.5,
    Math.cos(a) + (Math.random() - 0.5) * 0.8
  ).normalize();
  m.dir.copy(d);
  m.speed = 0.85 + Math.random() * 0.7;
  m.len = 0.26 + Math.random() * 0.22;
  m.width = 0.014 + Math.random() * 0.012;
  m.ttl = 0.85 + Math.random() * 0.75;
  m.life = m.ttl;
  m.sp.visible = true;
}

function updateMeteors(dt) {
  if (dayMix > 0.5) {
    meteors.pool.forEach(m => { m.life = 0; m.sp.visible = false; });
    return;
  }
  meteors.timer -= dt;
  if (meteors.timer <= 0) {
    meteors.timer = RAIN ? 0.35 : (1.6 + Math.random() * 3.4);
    const n = Math.random() < 0.25 ? 2 : 1;
    for (let i = 0; i < n; i++) setTimeout(spawnMeteor, i * 180);
  }
  const w = window.innerWidth, h = window.innerHeight;
  const pa = new THREE.Vector3(), pb = new THREE.Vector3();
  meteors.pool.forEach(m => {
    if (m.life <= 0) return;
    m.life -= dt;
    if (m.life <= 0) { m.sp.visible = false; return; }
    m.head.addScaledVector(m.dir, m.speed * dt);
    const k = m.life / m.ttl;
    // 头尾投影，换算屏幕角度
    pa.copy(m.head).project(camera);
    pb.copy(m.head).addScaledVector(m.dir, -m.len).project(camera);
    const dx = (pa.x - pb.x) * w * 0.5;
    const dy = (pa.y - pb.y) * h * 0.5;
    m.sp.quaternion.copy(camera.quaternion);
    m.sp.rotateZ(Math.atan2(dy, dx));
    m.sp.position.copy(m.head).addScaledVector(m.dir, -m.len * 0.5);
    m.sp.scale.set(m.len * 2.0, m.width * 2.0, 1);
    const fade = Math.sin(Math.PI * (1 - k)) * 0.9;
    m.sp.material.opacity = Math.max(0, Math.min(0.95, fade));
  });
}


/* ============================== 随机事件 ============================== */

const director = { next: 9, last: '', fast: new URLSearchParams(location.search).get('events') === '1' };

function evGust() {
  gustHold = 4.5;
  gustTarget = 1;
}

function evRoofSnow() {
  if (!cabinTopPos) return;
  for (let i = 0; i < 3; i++) {
    const p = cabinTopPos.clone();
    p.x += (Math.random() - 0.5) * 0.08;
    p.z += (Math.random() - 0.5) * 0.06;
    p.y += Math.random() * 0.02;
    setTimeout(() => sparkle(p, 0xeaf4ff, 7), i * 130);
  }
}

function evFerrisLights() {
  ferrisBoost = 0.55;
  if (ferris.wheel) sparkle(ferris.wheel.position.clone().add(new THREE.Vector3(0, 0, 0.02)), 0xffd9a0, 8);
}

function evLampFlicker() {
  flickT = 1.1;
}

function evFishBite() {
  if (hero.mode === 'fish' && hero.fish) hero.fish.bite = 1;
  else skaterBoost = 1;
}

const EVENTS = [
  { id: 'gust',    w: 3, run: evGust,        night: true, day: true },
  { id: 'roof',    w: 2, run: evRoofSnow,    night: true, day: true },
  { id: 'meteor',  w: 2, run: () => { spawnMeteor(); setTimeout(spawnMeteor, 240); }, night: true, day: false },
  { id: 'ferris',  w: 1, run: evFerrisLights, night: true, day: true },
  { id: 'lamp',    w: 1, run: evLampFlicker,  night: true, day: false },
  { id: 'bite',    w: 2, run: evFishBite,     night: true, day: true },
];

function updateDirector(dt) {
  // 阵风包络
  if (gustHold > 0) {
    gustHold -= dt;
    if (gustHold <= 0) gustTarget = 0;
  }
  gust += (gustTarget - gust) * (1 - Math.exp(-2.2 * dt));
  if (snowMat) snowMat.uniforms.uGust.value = gust;

  // 路灯闪烁
  if (lampLight) {
    if (flickT > 0) {
      flickT -= dt;
      const f = Math.sin(flickT * 38) * 0.5 + 0.5;
      lampLight.intensity = (0.9 + f * 2.4) * S.glow;
    } else {
      lampLight.intensity += (2.8 * S.glow - lampLight.intensity) * Math.min(1, dt * 6);
    }
  }

  if (skaterBoost > 0) skaterBoost = Math.max(0, skaterBoost - dt * 0.4);

  // 调度
  director.next -= dt;
  if (director.next > 0) return;
  director.next = director.fast ? 1.6 : 9 + Math.random() * 9;

  const night = dayMix < 0.5;
  const pool = EVENTS.filter(e => (night ? e.night : e.day) && e.id !== director.last);
  if (!pool.length) return;
  let total = pool.reduce((a, e) => a + e.w, 0);
  let r = Math.random() * total;
  let pick = pool[0];
  for (const e of pool) { r -= e.w; if (r <= 0) { pick = e; break; } }
  director.last = pick.id;
  try { pick.run(); } catch (_) {}
}

/* ============================== 雪 ============================== */

let snowMat;
function buildSnow() {
  const ND = CFG.snowDrift;
  const N = CFG.snowCount + ND;
  const pos = new Float32Array(N * 3);
  const seed = new Float32Array(N);
  const size = new Float32Array(N);
  const layer = new Float32Array(N);
  // 落雪
  for (let i = 0; i < CFG.snowCount; i++) {
    const r = Math.pow(Math.random(), 0.6) * 0.93;
    const a = Math.random() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = (Math.random() * 1.8) - 0.85;
    pos[i * 3 + 2] = Math.sin(a) * r;
    seed[i] = Math.random();
    size[i] = 1.4 + Math.random() * 2.6;
    layer[i] = 0;
  }
  // 贴地风雪（雪面被风带起的细雪）
  for (let i = CFG.snowCount; i < N; i++) {
    const r = 0.18 + Math.pow(Math.random(), 0.5) * 0.58;
    const a = Math.random() * Math.PI * 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    pos[i * 3] = x;
    pos[i * 3 + 1] = surfY(r) + 0.004 + Math.random() * 0.045;
    pos[i * 3 + 2] = z;
    seed[i] = Math.random();
    size[i] = 1.0 + Math.random() * 1.6;
    layer[i] = 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aLayer', new THREE.BufferAttribute(layer, 1));

  snowMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: CFG.dpr },
      uOpacity: { value: 0.72 },
      uSwirl: { value: 0 },
      uGust: { value: 0 },
      uDensity: { value: S.snow },
      uWind: { value: S.wind },
    },
    vertexShader: `
      attribute float aSeed;
      attribute float aSize;
      attribute float aLayer;
      uniform float uTime;
      uniform float uPixelRatio;
      uniform float uSwirl;
      uniform float uGust;
      uniform float uDensity;
      uniform float uWind;
      varying float vA;
      void main(){
        vec3 p = position;
        float s = aSeed;
        // 密度：按种子裁掉多余粒子（不重建几何）
        if (aSeed > uDensity) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          gl_PointSize = 0.0;
          vA = 0.0;
          return;
        }
        float wind = sin(uTime * 0.13 + s * 6.0) * (0.012 + 0.018 * s) * uWind;
        float a;
        if (aLayer > 0.5) {
          float ang = uTime * (0.028 + 0.030 * s);
          float ca = cos(ang), sa = sin(ang);
          p.xz = mat2(ca, -sa, sa, ca) * p.xz;
          float k = 1.0 + 0.05 * sin(uTime * 0.35 + s * 22.0) + uSwirl * 0.10 + uGust * 0.16;
          p.xz *= k;
          p.y += sin(uTime * 0.8 + s * 18.0) * 0.006 + uSwirl * 0.02;
          a = 0.55 + 0.45 * sin(uTime * 0.5 + s * 40.0);
        } else {
          float speed = 0.012 + 0.020 * s;
          float t = fract(s + uTime * speed);
          p.y = 0.95 - t * 1.75;
          float amp = 0.045 + uSwirl * 0.16;
          p.x += sin(uTime * 0.6 + s * 24.0) * amp + wind + uGust * (0.055 + 0.05 * s);
          p.z += cos(uTime * 0.5 + s * 19.0) * amp + wind * 0.4 + uGust * 0.028;
          p.y += sin(uTime * 1.1 + s * 40.0) * uSwirl * 0.06;
          float maxR = sqrt(max(0.02, 0.93 * 0.93 - p.y * p.y));
          float rr = length(p.xz);
          if (rr > maxR) p.xz *= maxR / max(rr, 0.001);
          a = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.88, 1.0, t));
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float sz = aSize * (aLayer > 0.5 ? 0.8 : 1.0);
        gl_PointSize = min(sz * uPixelRatio * (1.7 / -mv.z) * 2.0, 7.0 * uPixelRatio);
        a *= smoothstep(0.35, 0.95, -mv.z);
        gl_Position = projectionMatrix * mv;
        vA = a;
      }`,
    fragmentShader: `
      uniform float uOpacity;
      varying float vA;
      void main(){
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.12, length(d));
        gl_FragColor = vec4(vec3(0.93, 0.97, 1.0), a * vA * uOpacity);
      }`,
  });
  const pts = new THREE.Points(geo, snowMat);
  pts.frustumCulled = false;
  globe.add(pts);
  snowPts = pts;
  disposables.push(geo);
}

/* ============================== 控制 ============================== */

const ctrl = {
  yaw: Number(new URLSearchParams(location.search).get('yaw') || 0),
  pitch: Number(new URLSearchParams(location.search).get('pitch') || 0.10), dist: 3.20,
  targetYaw: Number(new URLSearchParams(location.search).get('yaw') || 0),
  targetPitch: Number(new URLSearchParams(location.search).get('pitch') || 0.10),
  targetDist: 3.20,
  dragging: false, lastX: 0, lastY: 0, vx: 0, vy: 0, idle: 0,
};
const target = new THREE.Vector3(0, -0.24, 0);

// 调试：?dist= 固定相机距离，?tx/?ty/?tz= 固定注视点（用于局部检视截图）
const DBG_DIST = Number(new URLSearchParams(location.search).get('dist') || NaN);
const DBG_TY = Number(new URLSearchParams(location.search).get('ty') || NaN);
const DBG_TX = Number(new URLSearchParams(location.search).get('tx') || NaN);
const DBG_TZ = Number(new URLSearchParams(location.search).get('tz') || NaN);

const pointers = new Map();
let pinchLast = 0;

function setupControls() {
  const el = canvas;
  document.body.classList.toggle('touch', IS_MOBILE);
  // 桌面端：宽窗口且有精确指针 → 显示左侧标题与快捷键栏
  const isDesktop = () => !IS_MOBILE && window.innerWidth >= 820 && window.matchMedia('(pointer:fine)').matches;
  const forcePC = new URLSearchParams(location.search).get('pc');   // 调试：?pc=1 / ?pc=0 强制
  const syncDesk = () => document.body.classList.toggle(
    'pc', forcePC === '1' ? true : forcePC === '0' ? false : isDesktop()
  );
  syncDesk();
  window.addEventListener('resize', syncDesk, { passive: true });
  window.addEventListener('contextmenu', (e) => {
    if (e.target === canvas) e.preventDefault();
  });
  bindFpBar();
  const btnShake = document.getElementById('btnShake');
  const btnDay = document.getElementById('btnDay');
  if (btnShake) btnShake.addEventListener('click', () => shake());
  if (btnDay) {
    btnDay.textContent = dayTarget > 0.5 ? '夜' : '昼';
    btnDay.addEventListener('click', () => {
      dayTarget = dayTarget > 0.5 ? 0 : 1;
      store.set('day', dayTarget);
      btnDay.textContent = dayTarget > 0.5 ? '夜' : '昼';
    });
  }

  const hintEl = document.getElementById('hint');
  if (hintEl) {
    hintEl.textContent = IS_MOBILE
      ? '拖动旋转 · 双指缩放 · 点按物件'
      : '拖动旋转 · 滚轮缩放 · 点击物件 · 双击复位 · 空格摇一摇';
  }
  el.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinchLast = 0;
    downX = e.clientX; downY = e.clientY; downT = performance.now();
    ctrl.dragging = true; ctrl.lastX = e.clientX; ctrl.lastY = e.clientY;
    ctrl.vx = ctrl.vy = 0;
    el.setPointerCapture(e.pointerId);
    hideHint();
  });
  el.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // 双指捏合缩放（触摸设备唯一的缩放通道）
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchLast > 0 && dist > 0) {
        ctrl.targetDist = THREE.MathUtils.clamp(ctrl.targetDist * (pinchLast / dist), 2.35, 4.9);
      }
      pinchLast = dist;
      ctrl.idle = 0;
      return;
    }
    if (!ctrl.dragging) {
      movePointerLantern(e.clientX, e.clientY);
      // 桌面端悬停识别（节流 70ms）
      const now = performance.now();
      if (e.pointerType !== 'touch' && now - hover.last > 70) {
        hover.last = now;
        pointerNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
        pointerNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(pointerNDC, camera);
        const hits = raycaster.intersectObjects(pickables, false);
        let found = '';
        for (const h of hits) {
          const k = kindOf(h.object);
          if (k) { found = labelOf(h.object) || '可点击'; break; }
        }
        setHover(found, e.clientX, e.clientY);
      }
      return;
    }
    el.style.cursor = 'grabbing';
    const dx = e.clientX - ctrl.lastX;
    const dy = e.clientY - ctrl.lastY;
    ctrl.lastX = e.clientX; ctrl.lastY = e.clientY;
    if (fpMode.on) {
      fpMode.yaw -= dx * 0.0026;
      fpMode.pitch = THREE.MathUtils.clamp(fpMode.pitch - dy * 0.0020, -0.72, 0.72);
      return;
    }
    ctrl.targetYaw += dx * 0.0055;
    ctrl.targetPitch = THREE.MathUtils.clamp(ctrl.targetPitch + dy * 0.004, -0.28, 0.62);
    ctrl.vx = dx * 0.0055; ctrl.vy = dy * 0.004;
    ctrl.idle = 0;
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    pinchLast = 0;
    ctrl.dragging = false;
    el.style.cursor = hover.on ? 'pointer' : 'grab';
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  el.addEventListener('pointerup', (e) => { end(e); onClick(e); });
  el.addEventListener('pointercancel', () => { ctrl.dragging = false; });
  el.style.cursor = 'grab';
  el.addEventListener('pointerleave', () => setHover('', 0, 0));
  el.addEventListener('dblclick', () => resetView());

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    ctrl.targetDist = THREE.MathUtils.clamp(ctrl.targetDist + e.deltaY * 0.0016, 2.35, 4.6);
    ctrl.idle = 0;
  }, { passive: false });
}

window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.code === 'KeyV') { e.preventDefault(); setFP(!fpMode.on); return; }
  if (fpMode.on && ['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight'].includes(e.code)) {
    fpMode.keys[e.code] = true;
    e.preventDefault();
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); shake(); return; }
  if (e.code === 'KeyF' || e.code === 'F11') {
    e.preventDefault();
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    return;
  }
  if (e.code === 'KeyH') { document.body.classList.toggle('clean'); return; }
  if (e.code === 'Escape') {
    document.body.classList.remove('clean');
    if (window.__togglePanel) window.__togglePanel(false);
    return;
  }
  if (e.code === 'KeyN') {
    S.day = S.day > 0.5 ? 0 : 1;
    dayTarget = S.day;
    saveCfg();
    if (window.__syncPanel) window.__syncPanel();
    return;
  }
  if (e.code === 'KeyC') { if (window.__togglePanel) window.__togglePanel(); return; }
  if (e.code === 'KeyR') { resetView(); return; }
  if (e.code === 'KeyM') { spawnMeteor(); return; }
  if (e.code === 'Equal' || e.code === 'NumpadAdd') {
    ctrl.targetDist = THREE.MathUtils.clamp(ctrl.targetDist - 0.22, 2.35, 4.6);
    ctrl.idle = 0; return;
  }
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
    ctrl.targetDist = THREE.MathUtils.clamp(ctrl.targetDist + 0.22, 2.35, 4.6);
    ctrl.idle = 0; return;
  }
  if (e.code === 'ArrowLeft') { ctrl.targetYaw -= 0.16; ctrl.idle = 0; }
  if (e.code === 'ArrowRight') { ctrl.targetYaw += 0.16; ctrl.idle = 0; }
  if (e.code === 'ArrowUp') { ctrl.targetPitch = THREE.MathUtils.clamp(ctrl.targetPitch - 0.08, -0.28, 0.62); ctrl.idle = 0; }
  if (e.code === 'ArrowDown') { ctrl.targetPitch = THREE.MathUtils.clamp(ctrl.targetPitch + 0.08, -0.28, 0.62); ctrl.idle = 0; }
});

window.addEventListener('keyup', (e) => { fpMode.keys[e.code] = false; });
window.addEventListener('blur', () => { fpMode.keys = {}; });

const tipEl = document.getElementById('tip');
function setHover(label, x, y) {
  const on = !!label;
  if (on !== hover.on || label !== hover.label) {
    hover.on = on;
    hover.label = label;
    canvas.style.cursor = on ? 'pointer' : (ctrl.dragging ? 'grabbing' : 'grab');
    if (tipEl) {
      tipEl.textContent = label;
      tipEl.classList.toggle('show', on);
    }
  }
  if (on && tipEl) {
    tipEl.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
  }
}

function resetView() {
  ctrl.targetYaw = 0;
  ctrl.targetPitch = 0.10;
  ctrl.targetDist = 3.72;
  ctrl.vx = ctrl.vy = 0;
  ctrl.idle = 0;
}

function updateBaseKey() {
  if (!baseKey) return;
  const a = Math.atan2(camera.position.x, camera.position.z);
  baseKey.position.set(Math.sin(a) * 1.5, -1.02, Math.cos(a) * 1.5);
}

function updateCamera(dt) {
  if (fpMode.on) { updateFP(dt); return; }
  if (!ctrl.dragging) {
    ctrl.targetYaw += ctrl.vx;
    ctrl.targetPitch = THREE.MathUtils.clamp(ctrl.targetPitch + ctrl.vy, -0.28, 0.62);
    ctrl.vx *= Math.pow(0.06, dt);
    ctrl.vy *= Math.pow(0.06, dt);
    ctrl.idle += dt;
    if (S.orbit && ctrl.idle > 14) ctrl.targetYaw += dt * 0.018;
  }
  const k = 1 - Math.exp(-9 * dt);
  ctrl.yaw += (ctrl.targetYaw - ctrl.yaw) * k;
  ctrl.pitch += (ctrl.targetPitch - ctrl.pitch) * k;
  ctrl.dist += (ctrl.targetDist - ctrl.dist) * k;

  const cp = Math.cos(ctrl.pitch), sp = Math.sin(ctrl.pitch);
  // 竖屏 / 窄窗口时按真实视锥算出「整球刚好入画」的距离
  const asp = camera.aspect;
  let d = ctrl.dist;
  target.y = Number.isFinite(DBG_TY) ? DBG_TY : (asp < 1.05 ? -0.02 : -0.165);
  if (Number.isFinite(DBG_TX)) target.x = DBG_TX;
  if (Number.isFinite(DBG_TZ)) target.z = DBG_TZ;
  if (asp < 1.05) {
    const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const halfW = halfH * asp;
    d = Math.max(d, 1.16 / halfH, 1.12 / halfW);
  }
  if (Number.isFinite(DBG_DIST)) d = DBG_DIST;
  camera.position.set(
    Math.sin(ctrl.yaw) * d * cp,
    target.y + sp * d,
    Math.cos(ctrl.yaw) * d * cp
  );
  camera.lookAt(target);
}


/* ---------------- 交互 ---------------- */

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
let downX = 0, downY = 0, downT = 0;
let shakeAmp = 0;
let lastClickAt = 0;
const hover = { on: false, label: '', last: 0 };
let ferrisBoost = 0;

const shot = { list: [] };

const pickables = [];

function registerKind(root, kind, label) {
  root.traverse(o => { if (o.isMesh) { o.userData.kind = kind; o.userData.label = label || ''; } });
  // 拾取代理：用包围盒代替几十万面的模型求交
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  if (size.x > 1e-4 && size.y > 1e-4) {
    const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat);
    proxy.position.copy(center);
    proxy.userData.kind = kind;
    proxy.userData.label = label || '';
    globe.add(proxy);
    pickables.push(proxy);
  }
  return root;
}

function labelOf(obj) {
  let o = obj;
  while (o) {
    if (o.userData && o.userData.label) return o.userData.label;
    o = o.parent;
  }
  return '';
}

function kindOf(obj) {
  let o = obj;
  while (o) {
    if (o.userData && o.userData.kind) return o.userData.kind;
    o = o.parent;
  }
  return null;
}

function sparkle(pos, color = 0xffd9a0, n = 14) {
  const geo = new THREE.SphereGeometry(0.006, 4, 4);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(pos);
    const a = Math.random() * Math.PI * 2;
    const b = Math.random() * Math.PI;
    const s = 0.10 + Math.random() * 0.10;
    m.userData.v = new THREE.Vector3(
      Math.cos(a) * Math.sin(b) * s, Math.abs(Math.cos(b)) * s * 0.9, Math.sin(a) * Math.sin(b) * s
    );
    m.userData.life = 0.9 + Math.random() * 0.4;
    globe.add(m);
    shot.list.push(m);
  }
}

function shake(light) {
  shakeAmp = light ? 0.35 : 0.9;
  snowSwirl = light ? 0.55 : 1.0;
  fx.cover = Math.min(1, fx.cover + (light ? 0.10 : 0.26));   // 摇得越久，球里积雪越厚
  snowDir = Math.random() > 0.5 ? 1 : -1;
  document.body.animate(
    [{ transform: 'translate(0,0)' }, { transform: 'translate(-2px,1px)' },
     { transform: 'translate(2px,-1px)' }, { transform: 'translate(0,0)' }],
    { duration: 260, easing: 'ease-out' }
  );
}

function onClick(ev) {
  const dx = ev.clientX - downX, dy = ev.clientY - downY;
  if (Math.hypot(dx, dy) > 10 || performance.now() - downT > 420) return;

  pointerNDC.x = (ev.clientX / window.innerWidth) * 2 - 1;
  pointerNDC.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointerNDC, camera);
  const hits = raycaster.intersectObjects(pickables, false);
  const now = performance.now();
  const isDouble = now - lastClickAt < 320;
  lastClickAt = now;
  let acted = false;
  let actedKind = null;
  for (const h of hits) {
    const kind = kindOf(h.object);
    if (!kind) continue;
    acted = true;
    actedKind = kind;
    if (kind === 'balloon') {
      const a = animated.find(x => x.type === 'balloon' && (x.obj === h.object.parent || x.obj === h.object));
      if (a) { a.kick = 1.0; sparkle(h.point, 0xffe3b0, 16); }
    } else if (kind === 'ferris') {
      ferrisBoost = 1;
      sparkle(h.point, 0xffc98a, 10);
    } else if (kind === 'hero') {
      /* 2026-11-02：男孩交互已取消，点击不再触发咬钩/跳跃/闪光 */
    } else if (kind === 'lamp') {
      // 射线命中的是 pickable 的包围盒代理，父级链上没有 lampIdx，按落点就近匹配
      let idx = -1, best = 0.16;
      fx.lamps.forEach((L, i) => {
        const d = Math.hypot(
          L.group.position.x - h.point.x + globe.position.x,
          L.group.position.z - h.point.z + globe.position.z
        );
        if (d < best) { best = d; idx = i; }
      });
      if (idx >= 0) lightLamp(idx);
      sparkle(h.point, 0xffcf9a, 8);
    } else if (kind === 'snowman') {
      fx.snowmanTilt = 1;
      sparkle(h.point, 0xdcefff, 8);
    } else if (kind === 'cabin') {
      sparkle(h.point, 0xffc27a, 12);
      if (warmCabin) warmCabin.userData.flash = 1;
    }
    break;
  }
  if (actedKind) collect(actedKind);
  // 点到空玻璃 = 轻摇一次；双击时不再重复触发
  if (!acted && !isDouble) shake(true);
}

/* ============================== 噪声 ============================== */

function noise3(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  const s2 = Math.sin(x * 39.346 + y * 11.135 + z * 83.155) * 24634.6345;
  return ((s - Math.floor(s)) + (s2 - Math.floor(s2))) - 1.0;
}


/* ============================== 交互层：提灯 / 呼吸 / 白气 / 火盆 ============================== */

const fpMode = { on: false, pos: new THREE.Vector3(-0.02, 0, 0.62), yaw: Math.PI, pitch: 0.02, keys: {}, vel: { x: 0, z: 0 } };

const fx = {
  lantern: { light: null, bulb: null, on: true },
  breath: { sprites: [], t: 2.4 },
  brazier: { light: null, embers: [], t: 0, flame: null },
  cover: 0,          // 摇一摇累积的积雪 0..1
  lamps: [],         // 路灯链
  snowmanTilt: 0,
  collected: new Set(),
  piles: null,
  drifts: null,
  snowman: null,
};

/* ---------------- 提灯：指针即光源 ---------------- */
function buildPointerLantern() {
  fx.lantern.light = new THREE.PointLight(0xffd0a0, 0.020, 0.44, 2);
  fx.lantern.light.position.set(0, -3, 0);
  globe.add(fx.lantern.light);

  const g = new THREE.SphereGeometry(0.0052, 8, 6);
  const m = new THREE.MeshBasicMaterial({ color: 0xffdcae, transparent: true, opacity: 0.85 });
  fx.lantern.bulb = new THREE.Mesh(g, m);
  fx.lantern.bulb.position.set(0, -3, 0);
  fx.lantern.bulb.visible = false;
  globe.add(fx.lantern.bulb);
  disposables.push(g, m);
}

function movePointerLantern(cx, cy) {
  const L = fx.lantern;
  if (!L.light || !L.on || fpMode.on) return;
  pointerNDC.x = (cx / window.innerWidth) * 2 - 1;
  pointerNDC.y = -(cy / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointerNDC, camera);
  if (!_groundMesh) globe.traverse(o => { if (o.isMesh && o.userData.isGround) _groundMesh = o; });
  if (!_groundMesh) return;
  const hit = raycaster.intersectObject(_groundMesh, false)[0];
  if (!hit) {
    L.bulb.visible = false;
    L.light.position.set(0, -3, 0);
    return;
  }
  const p = hit.point;
  L.light.position.set(p.x, p.y + 0.055, p.z);
  L.bulb.position.set(p.x, p.y + 0.055, p.z);
  L.bulb.visible = true;
}

/* ---------------- 白气：坐在冰上的呼吸 ---------------- */
function buildBreath() {
  const tex = getShadowTex();
  for (let i = 0; i < 6; i++) {
    const m = new THREE.SpriteMaterial({
      map: tex, color: 0xdbe9fb, transparent: true, opacity: 0, depthWrite: false,
    });
    const sp = new THREE.Sprite(m);
    sp.scale.setScalar(0.012);
    sp.visible = false;
    globe.add(sp);
    fx.breath.sprites.push({ sp, t: 0, vx: 0, vy: 0, vz: 0 });
  }
}

function updateBreath(dt, t) {
  const B = fx.breath;
  const seat = hero.seat;
  if (!seat) return;
  B.t -= dt;
  if (B.t <= 0) {
    B.t = 3.4 + Math.random() * 1.6;
    const fwd = new THREE.Vector3(Math.sin(hero.wrap ? hero.wrap.rotation.y : 0), 0, Math.cos(hero.wrap ? hero.wrap.rotation.y : 0));
    let started = 0;
    for (const p of B.sprites) {
      if (p.t > 0) continue;
      p.t = 1;
      p.sp.position.set(
        seat.x + fwd.x * 0.022 + (Math.random() - 0.5) * 0.004,
        seat.y + 0.098 + (Math.random() - 0.5) * 0.003,
        seat.z + fwd.z * 0.022 + (Math.random() - 0.5) * 0.004
      );
      p.vx = fwd.x * 0.006 + (Math.random() - 0.5) * 0.004;
      p.vy = 0.008 + Math.random() * 0.004;
      p.vz = fwd.z * 0.006 + (Math.random() - 0.5) * 0.004;
      p.sp.visible = true;
      if (++started >= 3) break;
    }
  }
  for (const p of B.sprites) {
    if (p.t <= 0) continue;
    p.t -= dt * 0.85;
    if (p.t <= 0) { p.t = 0; p.sp.visible = false; p.sp.material.opacity = 0; continue; }
    p.sp.position.x += p.vx * dt;
    p.sp.position.y += p.vy * dt;
    p.sp.position.z += p.vz * dt;
    const k = 1 - p.t;                       // 0 → 1
    p.sp.scale.setScalar(0.008 + k * 0.030);
    p.sp.material.opacity = Math.sin(Math.min(1, k * 1.6) * Math.PI * 0.5) * (1 - k) * 0.34;
  }
}

/* ---------------- 火盆：冰岸的暖色落点 ---------------- */
function makeFlameTex() {
  const cv = document.createElement('canvas');
  cv.width = 96; cv.height = 128;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(48, 92, 6, 48, 74, 62);
  g.addColorStop(0.00, 'rgba(255,246,214,1.00)');
  g.addColorStop(0.28, 'rgba(255,196,96,0.95)');
  g.addColorStop(0.60, 'rgba(255,132,38,0.58)');
  g.addColorStop(1.00, 'rgba(255,96,16,0)');
  c.fillStyle = g;
  // 水滴状火苗：底部圆、顶端收尖
  c.beginPath();
  c.moveTo(48, 8);
  c.bezierCurveTo(66, 42, 76, 70, 68, 96);
  c.bezierCurveTo(62, 116, 34, 116, 28, 96);
  c.bezierCurveTo(20, 70, 30, 42, 48, 8);
  c.closePath();
  c.fill();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildBrazier() {
  const bx = -0.305, bz = 0.352;
  const gy = groundY(bx, bz);
  const iron = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0x3c4652, roughness: 0.62, metalness: 0.6 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const g = new THREE.Group();
  g.position.set(bx, gy, bz);

  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.020, 0.016, 12, 1, true), iron);
  bowl.position.y = 0.036;
  bowl.material.side = THREE.DoubleSide;
  bowl.castShadow = CFG.shadows;
  g.add(bowl);
  const bottom = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.020, 0.003, 12), iron);
  bottom.position.y = 0.029;
  g.add(bottom);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0028, 0.032, 6), iron);
    leg.position.set(Math.cos(a) * 0.016, 0.016, Math.sin(a) * 0.016);
    leg.rotation.z = Math.cos(a) * 0.28;
    leg.rotation.x = -Math.sin(a) * 0.28;
    g.add(leg);
  }
  // 火焰：两层加性锥体
  // 火焰用 Sprite：锥体的直边在近景一眼假，Sprite 配不规则火苗轮廓才像火
  const flameTex = makeFlameTex();
  const mkFlame = (w, h, color, opacity) => {
    const m = new THREE.SpriteMaterial({
      map: flameTex, color, transparent: true, opacity,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const sp = new THREE.Sprite(m);
    sp.scale.set(w, h, 1);
    return sp;
  };
  const flame = mkFlame(0.038, 0.044, 0xffd9a0, 0.92);
  flame.position.set(0, 0.062, 0);
  g.add(flame);
  const flame2 = mkFlame(0.021, 0.024, 0xffffff, 0.80);
  flame2.position.set(0, 0.052, 0);
  g.add(flame2);
  fx.brazier.flame = flame;
  fx.brazier.flame2 = flame2;

  const light = new THREE.PointLight(0xff9b4a, 0.055, 0.5, 2);
  light.position.set(0, 0.07, 0);
  g.add(light);
  fx.brazier.light = light;

  // 炭火星
  for (let i = 0; i < 7; i++) {
    const m = new THREE.SpriteMaterial({
      map: getShadowTex(), color: 0xffb469, transparent: true,
      opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const sp = new THREE.Sprite(m);
    sp.position.set((Math.random() - 0.5) * 0.02, 0.05, (Math.random() - 0.5) * 0.02);
    sp.scale.setScalar(0.0035);
    sp.visible = false;
    g.add(sp);
    fx.brazier.embers.push({ sp, t: Math.random(), vy: 0.012 + Math.random() * 0.012, ph: Math.random() * 6.28 });
  }

  globe.add(g);
  disposables.push(iron, flame.material, flame2.material, flameTex);
}

function updateBrazier(dt, t) {
  const B = fx.brazier;
  if (!B.light) return;
  const f = 0.85 + Math.sin(t * 11.3) * 0.06 + Math.sin(t * 23.7 + 1.2) * 0.04;
  B.light.intensity = 0.055 * f;
  if (B.flame) {
    const k = 0.92 + Math.sin(t * 9.1) * 0.10 + Math.sin(t * 21.7) * 0.05;
    B.flame.scale.set(0.038 * (2 - k) * 0.80, 0.044 * k, 1);
    B.flame.position.x = Math.sin(t * 5.3) * 0.0016;
    B.flame.position.y = 0.062 + Math.sin(t * 7.7) * 0.0014;
  }
  if (B.flame2) {
    const k2 = 0.94 + Math.sin(t * 13.7 + 2.0) * 0.10;
    B.flame2.scale.set(0.021 * (2 - k2) * 0.85, 0.024 * k2, 1);
    B.flame2.position.y = 0.052 + Math.sin(t * 11.1 + 1.2) * 0.001;
  }
  for (const e of B.embers) {
    e.t += dt * 0.42;
    if (e.t > 1) { e.t = 0; e.sp.visible = true; }
    const tt = e.t;
    e.sp.position.y = 0.05 + tt * 0.075;
    e.sp.position.x = Math.sin(e.ph + tt * 5) * 0.008 * (1 + tt);
    e.sp.position.z = Math.cos(e.ph + tt * 4) * 0.008 * (1 + tt);
    e.sp.material.opacity = Math.sin(Math.min(1, tt * 3) * Math.PI * 0.5) * (1 - tt) * 0.9;
    e.sp.visible = tt < 0.99;
  }
}


/* ---------------- 路灯链：点一盏，相邻依次亮起 ---------------- */
const LAMP_SPOTS = [
  { x: -0.135, z: 0.192, rot: 0.20 },
  { x: 0.165, z: 0.204, rot: -0.55 },
  { x: 0.405, z: 0.118, rot: 1.05 },
];

function buildLampChain() {
  const bulbGeo = new THREE.SphereGeometry(0.0075, 10, 8);
  LAMP_SPOTS.forEach((sp, i) => {
    const gy = groundY(sp.x, sp.z);
    const g = new THREE.Group();
    if (loaded.lamp) {
      const o = loaded.lamp.clone(true);
      o.position.set(0, -0.006, 0);
      o.rotation.y = sp.rot;
      g.add(o);
    } else {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.005, 0.12, 8),
        addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0x3b4450, metalness: 0.5, roughness: 0.6 }), { kind: 'fine', repeat: 7, scale: 0.75 }));
      post.position.y = 0.06;
      g.add(post);
    }
    const bulbMat = addSurfaceDetail(new THREE.MeshStandardMaterial({
      color: 0xffe6bd, emissive: 0xffb15e, emissiveIntensity: 0,
      roughness: 0.4, metalness: 0,
    }), { kind: 'fine', repeat: 7, scale: 0.75 });
    const bulb = new THREE.Mesh(bulbGeo, bulbMat);
    bulb.position.set(0, 0.126, 0);
    g.add(bulb);

    const light = new THREE.PointLight(0xffb46a, 0, 0.34, 2);
    light.position.set(0, 0.126, 0);
    g.add(light);
    const cone = attachLightCone(g);

    g.position.set(sp.x, gy, sp.z);
    globe.add(g);
    registerKind(g, 'lamp', '路灯');
    g.traverse(o => { o.userData.lampIdx = i; });
    fx.lamps.push({ group: g, bulb: bulbMat, light, cone, on: false, glow: 0, idx: i });
  });
  disposables.push(bulbGeo);
}

function lightLamp(i) {
  const L = fx.lamps[i];
  if (!L || L.on) return;
  L.on = true;
  // 点亮下一盏
  const next = fx.lamps.findIndex((l, k) => k > i && !l.on);
  if (next >= 0) setTimeout(() => lightLamp(next), 240);
  else if (fx.lamps.every(l => l.on)) setTimeout(() => sparkleAt(0.02, -0.34, 0.10, 0xffd9a0, 26), 320);
}

function updateLamps(dt, t) {
  for (const L of fx.lamps) {
    const target = L.on ? 1 : 0;
    L.glow += (target - L.glow) * Math.min(1, dt * 3.4);
    const flick = L.on ? (0.92 + Math.sin(t * 12.3 + L.idx) * 0.05) : 0;
    L.bulb.emissiveIntensity = L.glow * 2.6 * flick;
    L.light.intensity = L.glow * 0.024 * flick;
    if (L.cone) L.cone.opacity = L.glow * 0.20 * flick;
  }
}

/* ---------------- 摇一摇：积雪慢慢堆起来 ---------------- */
function buildSnowCover() {
  fx.piles = [];
  const mat = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0xf3f8ff, roughness: 1.0, metalness: 0 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const geo = new THREE.SphereGeometry(1, 12, 8);
  const spots = [
    [-0.24, 0.24, 0.030], [-0.40, 0.06, 0.026], [0.10, 0.24, 0.028],
    [0.28, 0.20, 0.024], [0.34, 0.40, 0.022], [-0.02, 0.34, 0.026],
    [0.18, 0.08, 0.030], [-0.14, 0.05, 0.024], [0.46, 0.02, 0.024],
  ];
  for (const [x, z, r] of spots) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, groundY(x, z) - r * 0.45, z);
    m.scale.set(r, r * 0.42, r * 0.86);
    m.rotation.y = Math.random() * 3;
    m.visible = false;
    globe.add(m);
    fx.piles.push({ m, r });
  }
  disposables.push(mat, geo);
}

function updateSnowCover(dt) {
  if (!fx.piles) return;
  fx.cover = Math.max(0, fx.cover - dt * 0.012);          // 缓慢消融
  const c = fx.cover;
  const n = Math.round(c * fx.piles.length);
  fx.piles.forEach((p, i) => {
    const on = i < n;
    p.m.visible = on;
    if (on) {
      const k = Math.min(1, 0.4 + c);
      p.m.scale.set(p.r * k, p.r * 0.42 * k, p.r * 0.86 * k);
    }
  });
  if (snowMat) snowMat.uniforms.uOpacity.value = (0.62 - perf.tier * 0.12) * (0.72 + c * 0.5);
}

/* ---------------- 隐藏收集：点亮铭牌星标 ---------------- */
const COLLECT = ['snowman', 'giftbox', 'balloon', 'postbox', 'tree', 'lamp', 'cabin'];
function collect(kind) {
  if (!COLLECT.includes(kind)) return false;
  if (fx.collected.has(kind)) return false;
  fx.collected.add(kind);
  drawPlaque(S.plaque);
  return fx.collected.size;
}

function sparkleAt(x, y, z, color, n) {
  const geo = new THREE.SphereGeometry(0.004, 6, 5);
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 1, depthWrite: false,
    }));
    m.position.set(x + (Math.random() - 0.5) * 0.05, y + (Math.random() - 0.5) * 0.04, z + (Math.random() - 0.5) * 0.05);
    m.userData.v = new THREE.Vector3((Math.random() - 0.5) * 0.09, 0.04 + Math.random() * 0.07, (Math.random() - 0.5) * 0.09);
    m.userData.life = 1;
    globe.add(m);
    shot.list.push(m);
  }
  disposables.push(geo);
}


/* ---------------- 小站台：让环形轨道有个"目的地" ---------------- */
function buildStation() {
  if (!track.curve) return;
  const u = track.stationU;
  const p = track.curve.getPointAt(u);
  const t = track.curve.getTangentAt(u);
  const n = new THREE.Vector3(-t.z, 0, t.x).normalize();     // 轨道法线（向外）
  const yaw = Math.atan2(t.x, t.z);

  const wood = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0x7a5636, roughness: 0.88, metalness: 0 }), { kind: 'wood', repeat: 4, scale: 1.15 });
  const snow = addSurfaceDetail(new THREE.MeshStandardMaterial({ color: 0xd6dfe9, roughness: 1.0, metalness: 0 }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const g = new THREE.Group();
  g.position.copy(p).addScaledVector(n, 0.052);
  g.position.y -= 0.004;
  g.rotation.y = yaw;

  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.012, 0.040), wood);
  deck.position.y = 0.006;
  deck.castShadow = CFG.shadows;
  g.add(deck);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.004, 0.040), snow);
  cap.position.y = 0.014;
  g.add(cap);
  // 站牌
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0026, 0.055, 6), wood);
  post.position.set(-0.042, 0.028, 0.014);
  g.add(post);
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.016, 0.002), snow);
  sign.position.set(-0.042, 0.058, 0.014);
  g.add(sign);
  // 小灯
  const lampMat = addSurfaceDetail(new THREE.MeshStandardMaterial({
    color: 0xffe3b8, emissive: 0xffab48, emissiveIntensity: 1.4, roughness: 0.45,
  }), { kind: 'fine', repeat: 7, scale: 0.75 });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.0045, 8, 6), lampMat);
  bulb.position.set(0.044, 0.040, 0.012);
  g.add(bulb);
  const pl = new THREE.PointLight(0xffb46a, 0.010, 0.30, 2);
  pl.position.set(0.044, 0.042, 0.012);
  g.add(pl);

  globe.add(g);
  registerKind(g, 'station', '小站台');
  disposables.push(wood, snow, lampMat);
}


/* ---------------- 雪人：会慢慢转头，被点会歪一下 ---------------- */
function updateSnowman(dt, t) {
  const o = fx.snowman;
  if (!o) return;
  if (fx.snowmanTilt > 0) fx.snowmanTilt = Math.max(0, fx.snowmanTilt - dt * 0.9);
  const k = Math.sin(t * 0.35) * 0.12;                     // 缓慢转头
  const tilt = Math.sin((1 - fx.snowmanTilt) * Math.PI) * 0.25 * (fx.snowmanTilt > 0 ? 1 : 0);
  o.rotation.y = fx.snowmanBase.rot + k;
  o.rotation.z = tilt;
  o.position.y = fx.snowmanBase.y + Math.sin(t * 0.9) * 0.0008;
}


/* ============================== 每日变体 / 体积光 / 风吹雪 ============================== */

const daily = { key: '', warm: 1, snowMul: 1, aurora: 1 };

function setupDaily() {
  const d = new Date();
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 131 + key.charCodeAt(i)) >>> 0;
  daily.key = key;
  daily.warm = [0.72, 1.0, 1.28][h % 3];            // 冷调 / 中性 / 暖调
  daily.snowMul = [0.55, 0.85, 1.15][(h >> 3) % 3];
  daily.aurora = ((h >> 6) % 3 === 0) ? 1 : 0;      // 每三天一次极光
}

function applyDaily() {
  S.snow = THREE.MathUtils.clamp(0.6 * daily.snowMul, 0.15, 1);
  applySnowUniforms();
  if (hemiLight) hemiLight.color.lerpColors(
    new THREE.Color(0x9db8da), new THREE.Color(0xc3d6f2), (daily.warm - 0.72) / 0.56
  );
  if (keyLight) keyLight.color.lerpColors(
    new THREE.Color(0xccd9ee), new THREE.Color(0xffe6c8), (daily.warm - 0.72) / 0.56
  );
}

/* ---------------- 体积光锥：路灯发出的可见光 ---------------- */
function makeLightCone() {
  const cv = document.createElement('canvas');
  cv.width = 32; cv.height = 128;
  const cx = cv.getContext('2d');
  const grd = cx.createLinearGradient(0, 0, 0, 128);
  grd.addColorStop(0, 'rgba(255,206,150,0.55)');
  grd.addColorStop(0.55, 'rgba(255,190,128,0.18)');
  grd.addColorStop(1, 'rgba(255,180,110,0)');
  cx.fillStyle = grd;
  cx.fillRect(0, 0, 32, 128);
  // 横向羽化
  cx.globalCompositeOperation = 'destination-in';
  const hg = cx.createLinearGradient(0, 0, 32, 0);
  hg.addColorStop(0, 'rgba(0,0,0,0)');
  hg.addColorStop(0.5, 'rgba(0,0,0,1)');
  hg.addColorStop(1, 'rgba(0,0,0,0)');
  cx.fillStyle = hg;
  cx.fillRect(0, 0, 32, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
}

function attachLightCone(lampGroup) {
  const geo = new THREE.ConeGeometry(0.055, 0.135, 16, 1, true);
  const mat = makeLightCone();
  const cone = new THREE.Mesh(geo, mat);
  cone.position.y = 0.060;
  cone.raycast = () => {};
  cone.renderOrder = 3;
  lampGroup.add(cone);
  disposables.push(geo, mat, mat.map);
  return mat;
}

/* ---------------- 风吹雪：贴地流动的雪丝 ---------------- */
function buildDriftSnow() {
  const N = 46;
  const tex = getShadowTex();
  fx.drifts = [];
  for (let i = 0; i < N; i++) {
    const m = new THREE.SpriteMaterial({
      map: tex, color: 0xdbe9fb, transparent: true, opacity: 0.10 + Math.random() * 0.12,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const sp = new THREE.Sprite(m);
    const a = Math.random() * Math.PI * 2;
    const r = 0.12 + Math.random() * 0.62;
    sp.position.set(Math.cos(a) * r, -0.44 + Math.random() * 0.05, Math.sin(a) * r);
    sp.scale.set(0.020 + Math.random() * 0.02, 0.004 + Math.random() * 0.003, 1);
    globe.add(sp);
    fx.drifts.push({ sp, t: Math.random(), sp2: 0.02 + Math.random() * 0.05 });
  }
}

function updateDriftSnow(dt, t) {
  if (!fx.drifts) return;
  const wind = S.wind;
  for (const d of fx.drifts) {
    d.sp.position.x += dt * 0.05 * wind * (0.6 + gust);
    d.sp.position.z += dt * 0.012 * wind;
    const r = Math.hypot(d.sp.position.x, d.sp.position.z);
    if (r > 0.82) {
      const a = Math.random() * Math.PI * 2;
      d.sp.position.x = Math.cos(a) * 0.16;
      d.sp.position.z = Math.sin(a) * 0.16;
      d.sp.position.y = -0.44 + Math.random() * 0.05;
    }
    d.sp.position.y = -0.44 + 0.012 + Math.sin(t * 0.8 + d.sp2 * 90) * 0.008;
    d.sp.material.opacity = (0.08 + Math.sin(t * 0.6 + d.sp2 * 40) * 0.05) * Math.min(1, S.snow * 1.6);
  }
}


/* ============================== 第一人称：走进水晶球 ============================== */

// 第一人称碰撞体：取 LAYOUT 的占位半径，冰湖与雪橇忽略（可以站上去）
const FP_SKIP = new Set(['pond', 'giftA', 'giftB']);
const FP_BLOCK = Object.entries(LAYOUT)
  .filter(([k]) => !FP_SKIP.has(k))
  .map(([k, v]) => ({ k, x: v.x, z: v.z, r: (v.r || 0.04) + 0.052 }));

function fpCollide(nx, nz) {
  // 球壁
  const r = Math.hypot(nx, nz);
  if (r > 0.80) { nx *= 0.80 / r; nz *= 0.80 / r; }
  // 物件：推到半径外（沿法线滑动，不会卡死）
  for (const b of FP_BLOCK) {
    const dx = nx - b.x, dz = nz - b.z;
    const d = Math.hypot(dx, dz);
    if (d < b.r && d > 1e-5) {
      nx = b.x + (dx / d) * b.r;
      nz = b.z + (dz / d) * b.r;
    }
  }
  return [nx, nz];
}

function setFP(on) {
  if (on === fpMode.on) return;
  fpMode.on = on;
  document.body.classList.toggle('fp', on);
  if (on) {
    // 固定从球的"门口"进入：左前岸，斜看冰湖与村庄（一进来就能看到全景）
    const Q = new URLSearchParams(location.search);
    const fx0 = Number(Q.get('fx') || NaN), fz0 = Number(Q.get('fz') || NaN), fy0 = Number(Q.get('fyaw') || NaN);
    const [ex, ez] = fpCollide(
      Number.isFinite(fx0) ? fx0 : 0.400,
      Number.isFinite(fz0) ? fz0 : 0.112
    );
    fpMode.pos.set(ex, 0, ez);
    fpMode.yaw = Number.isFinite(fy0) ? fy0 : 1.57;   // 正在街道中心线，沿着石板路看向木屋
    fpMode.pitch = Number(Q.get('fpitch') || -0.02);
    if (glassMesh) glassMesh.visible = false;
    fpMode.vel.x = 0; fpMode.vel.z = 0;
    ctrl.idle = 0;
    // 第一人称用更高渲染倍率，必须立即 resize 才生效
    if (typeof resize === 'function') resize();
  } else {
    if (glassMesh) glassMesh.visible = true;
    fpLight.intensity = 0;      // 离开第一人称关掉随身补光
    if (Math.abs(camera.fov - 38) > 0.01) { camera.fov = 38; camera.updateProjectionMatrix(); }
    if (typeof resize === 'function') resize();   // 恢复全景的渲染倍率
    ctrl.targetDist = 3.20;
    ctrl.targetYaw = 0;
    ctrl.targetPitch = 0.10;
  }
  if (window.__syncPanel) window.__syncPanel();
  if (window.__syncView) window.__syncView();
}

function bindFpBar() {
  const b = document.getElementById('fpExit');
  if (b) b.addEventListener('click', () => setFP(false));
}

// 第一人称的随身补光：只照亮相机脚下一小圈，环绕视角下无效
const fpLight = new THREE.PointLight(0xd6e6fb, 0.0, 0.85, 2);
if (typeof globe !== 'undefined' && globe) globe.add(fpLight);

function updateFP(dt) {
  const K = fpMode.keys;
  const fwd = (K.KeyW || K.ArrowUp ? 1 : 0) - (K.KeyS || K.ArrowDown ? 1 : 0);
  const strafe = (K.KeyD || K.ArrowRight ? 1 : 0) - (K.KeyA || K.ArrowLeft ? 1 : 0);
  const speed = (K.ShiftLeft || K.ShiftRight ? 0.42 : 0.20);
  const sy = Math.sin(fpMode.yaw), cy = Math.cos(fpMode.yaw);
  const tvx = (-sy * fwd + cy * strafe) * speed;
  const tvz = (-cy * fwd - sy * strafe) * speed;
  // 加减速阻尼：瞬起瞬停会让画面"一顿一顿"，是眩晕感的主要来源之一
  const k = Math.min(1, dt * 9);
  fpMode.vel.x += (tvx - fpMode.vel.x) * k;
  fpMode.vel.z += (tvz - fpMode.vel.z) * k;
  if (Math.abs(fpMode.vel.x) + Math.abs(fpMode.vel.z) > 1e-4) {
    const [cx2, cz2] = fpCollide(
      fpMode.pos.x + fpMode.vel.x * dt,
      fpMode.pos.z + fpMode.vel.z * dt
    );
    fpMode.pos.x = cx2;
    fpMode.pos.z = cz2;
  }
  const gy = groundY(fpMode.pos.x, fpMode.pos.z);
  // 视高：0.104 相当于贴地蹲着看微缩模型，地面占满下半屏、透视极度拉伸 → 晕。
  // 抬到 0.19（约角色肩高）后视线越过地面看向村庄，构图正常。
  const eyeH = (window.__fpEyeH !== undefined) ? window.__fpEyeH : 0.190;
  // 头部起伏几乎取消：原来 ±1.6mm 在整个画面里是持续的上下位移
  const bobAmp = 0.00022;
  const bob = Math.sin(clock.elapsedTime * 4.4) * bobAmp;
  camera.position.set(fpMode.pos.x, gy + eyeH + bob, fpMode.pos.z);
  camera.rotation.set(fpMode.pitch, fpMode.yaw, 0, 'YXZ');
  // 视场收窄到 38°：44° 在近景走动时边缘桶形拉伸明显，是眩晕的放大器
  if (Math.abs(camera.fov - 38) > 0.01) { camera.fov = 38; camera.updateProjectionMatrix(); }
  fpLight.intensity = 0.052;
  fpLight.position.set(fpMode.pos.x, gy + 0.26, fpMode.pos.z);
}

/* ============================== 主循环 ============================== */

let frames = 0, fpsT = 0, fps = 0;

// 画质：渲染倍率 + 雪量。手机/低端卡自动降档，手动选过就不再自动改
const perf = { tier: 0, acc: 0, n: 0, low: 0, high: 0, auto: true, warmup: 8 };

/* 渲染倍率分档（2026-11-03 重做）
   上一版把高档拉到 2.4×、第一人称再乘 1.35 = 3.24×，缓冲区 4536×2916，
   直接把帧率打到个位数 —— 画质提升了但游戏不能玩了。
   现在每档同时控制「超采样倍率 / 阴影分辨率 / 雪量」，让用户自己权衡：
     高：1.75× （第一人称 1.75×1.2=2.1×）  阴影 4096  —— 看得清，中等显卡够用
     中：1.35× （第一人称 1.35×1.15=1.55×）阴影 2048  —— 默认，稳 60
     低：1.00× （第一人称 1.00×）          阴影 1024  —— 老机器兜底
   第一人称仍然给一点加成（细节更密），但幅度从 1.35 降到 1.2/1.15，
   不再出现"一进第一人称就卡死"的情况。 */
const TIER_WANT   = [1.75, 1.35, 1.00];
const TIER_CAP    = [2.00, 1.50, 1.00];
const FP_SCALE_BOOST = [1.20, 1.15, 1.00];   // 第一人称额外超采样，按档位递减
const TIER_SHADOW = [4096, 2048, 1024];      // 各档阴影贴图尺寸

const FORCE_SCALE = Number(new URLSearchParams(location.search).get('scale') || NaN);
function renderScale() {
  if (Number.isFinite(FORCE_SCALE) && FORCE_SCALE > 0) return FORCE_SCALE;   // ?scale=1 固定倍率
  const dpr = window.devicePixelRatio || 1;
  const i = THREE.MathUtils.clamp(perf.tier, 0, 2);
  let s = Math.min(Math.max(dpr, TIER_WANT[i]), TIER_CAP[i]);
  // 第一人称走超采样：细碎几何需要更多像素才不平
  if (typeof fpMode !== 'undefined' && fpMode && fpMode.on) s *= FP_SCALE_BOOST[i];
  return s;
}

function applyTier(t, manual) {
  perf.tier = THREE.MathUtils.clamp(t, 0, 2);
  if (manual) {
    perf.auto = false;
    S.tier = perf.tier;
    S.tierAuto = 0;
    saveCfg();
  }
  if (snowMat) snowMat.uniforms.uOpacity.value = 0.62 - perf.tier * 0.12;
  // 阴影分辨率跟随档位：这一步对帧率的影响比超采样还大
  if (keyLight && keyLight.shadow) {
    const want = TIER_SHADOW[perf.tier];
    if (keyLight.shadow.mapSize.x !== want) {
      keyLight.shadow.mapSize.set(want, want);
      // 换 mapSize 必须丢弃旧的 shadow map，否则不会重建
      if (keyLight.shadow.map) {
        keyLight.shadow.map.dispose();
        keyLight.shadow.map = null;
      }
    }
  }
  resize();
}

function updateQuality(dt) {
  if (!perf.auto) return;
  // 前 8 秒是资源加载与着色器编译期，帧率必然抖，不能拿来判性能
  if (perf.warmup > 0) { perf.warmup -= dt; return; }
  perf.acc += dt; perf.n++;
  if (perf.acc < 1.2) return;
  const f = perf.n / perf.acc;
  perf.acc = 0; perf.n = 0;
  if (f < 40 && perf.tier < 2) { perf.low++; perf.high = 0; }
  else if (f > 57 && perf.tier > 0) { perf.high++; perf.low = 0; }
  else { perf.low = 0; perf.high = 0; }
  if (perf.low >= 3) { applyTier(perf.tier + 1); perf.low = 0; }
  else if (perf.high >= 6) { applyTier(perf.tier - 1); perf.high = 0; }
}
const METER = new URLSearchParams(location.search).has('meter');
let meterAcc = 0;
const meterCanvas = METER ? document.createElement('canvas') : null;
if (meterCanvas) { meterCanvas.width = 192; meterCanvas.height = 108; }
const meterCtx = meterCanvas ? meterCanvas.getContext('2d', { willReadFrequently: true }) : null;


/* ?meter=1：把画面亮度直方图写进标题（无头环境下当测光表用）
   背景标签页会节流 rAF，所以这里用定时器采样，而不是挂在渲染循环里 */
function probeAt(d, w, h, world, half) {
  if (!world) return null;
  const v = world.clone().project(camera);
  if (!isFinite(v.x) || v.z > 1) return null;
  const cx = Math.round((v.x * 0.5 + 0.5) * w);
  const cy = Math.round((-v.y * 0.5 + 0.5) * h);
  let sum = 0, n = 0;
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      n++;
    }
  }
  return n ? sum / n : null;
}

function sampleExposure() {
  if (!meterCtx) return;
  try {
    const W = 192, H = 108;
    meterCtx.drawImage(canvas, 0, 0, W, H);
    const d = meterCtx.getImageData(0, 0, W, H).data;
    let sum = 0, clip = 0, hot = 0;
    const n = W * H;
    for (let i = 0; i < d.length; i += 4) {
      const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      sum += l;
      if (l > 0.985) clip++;
      else if (l > 0.90) hot++;
    }
    const sp = probeAt(d, W, H, window.__probeSubj, 3);
    const pp = probeAt(d, W, H, window.__probePlaza, 4);
    document.title = `L${(sum / n).toFixed(3)} clip${(clip / n * 100).toFixed(1)} hot${(hot / n * 100).toFixed(1)}`
      + (sp != null ? ` subj${sp.toFixed(2)}` : '')
      + (pp != null ? ` plaza${pp.toFixed(2)}` : '')
      + ` @${camera.position.x.toFixed(2)},${camera.position.y.toFixed(2)},${camera.position.z.toFixed(2)}`
      + (fpMode.on ? ` fp${fpMode.pos.x.toFixed(2)},${fpMode.pos.z.toFixed(2)} y${fpMode.yaw.toFixed(2)}` : '');
  } catch (e) {
    document.title = 'E:' + String((e && e.message) || e).slice(0, 50) + ' c' + (canvas && canvas.width) + 'x' + (canvas && canvas.height);
  }
}
if (METER) setInterval(sampleExposure, 800);

const hud = document.getElementById('hud');
const showHud = new URLSearchParams(location.search).get('debug') === '1';
{
  const q = new URLSearchParams(location.search).get('day');
  if (q === '1' || q === '0') S.day = q === '1' ? 1 : 0;
  dayTarget = S.day;
  dayMix = dayTarget;
}
if (showHud) hud.classList.add('show');

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 1 / 30);
  const t = clock.elapsedTime;

  updateCamera(dt);

  // 昼夜
  dayMix += (dayTarget - dayMix) * (1 - Math.exp(-3 * dt));
  if (!DBG_PAUSE) {
    updateEnv();
    if (keyLight) {
      keyLight.intensity = (1.62 + 0.62 * dayMix) * S.glow;
      keyLight.color.setRGB(0.83 + 0.17 * dayMix, 0.89 + 0.09 * dayMix, 0.96 - 0.02 * dayMix);
    }
    if (hemiLight) hemiLight.intensity = (0.30 + 0.44 * dayMix) * (0.55 + 0.45 * S.glow);
    scene.backgroundIntensity = 0.55 + 0.30 * dayMix;
    renderer.toneMappingExposure = (0.95 + 0.05 * dayMix) * S.exp;   // R3：整体压一档，ACES 高光不再成片死白
    if (warmCabin) warmCabin.intensity = (0.85 * (1 - dayMix) + 0.38 * dayMix) * S.glow;
  }

  // 摩天轮
  ferrisBoost = Math.max(0, ferrisBoost - dt * 0.4);
  ferris.wheel.rotation.z -= dt * (Math.PI * 2 / 62) * (1 + ferrisBoost * 2.2) * S.ferris;
  const wob = Math.sin(t * 0.9) * 0.022;
  ferris.cabins.forEach(({ pivot, clone }) => {
    pivot.rotation.z = -ferris.wheel.rotation.z + wob;
  });
  if (ferris.warmMat) {
    ferris.warmMat.emissiveIntensity = 1.05 + Math.sin(t * 0.45) * 0.14;
  }

  // 气球
  // 点击产生的光点
  for (let i = shot.list.length - 1; i >= 0; i--) {
    const m = shot.list[i];
    m.position.addScaledVector(m.userData.v, dt);
    m.userData.v.y -= 0.35 * dt;
    m.userData.life -= dt;
    m.material.opacity = Math.max(0, m.userData.life);
    if (m.userData.life <= 0) { globe.remove(m); shot.list.splice(i, 1); }
  }

  animated.forEach(a => {
    if (a.type === 'smoke') {
      a.list.forEach(({ mesh, t }) => {
        const tt = (t + clock.elapsedTime * 0.10) % 1;
        mesh.position.y = 0.30 + tt * 0.20;
        mesh.position.x = 0.10 + Math.sin(tt * 4 + t * 6) * 0.022 + tt * 0.02 + gust * 0.05 * tt;
        const sc = 0.018 + tt * 0.055;
        mesh.scale.set(sc, sc, sc);
        mesh.material.opacity = Math.sin(Math.PI * Math.min(1, tt * 1.15)) * 0.30;
      });
    }
    if (a.type === 'balloon') {
      if (a.kick > 0) a.kick = Math.max(0, a.kick - dt * 0.85);
      a.obj.position.y = a.base + Math.sin(t * 0.33 + a.phase) * a.amp
        + Math.sin((1 - a.kick) * Math.PI) * 0.055 * (a.kick > 0 ? 1 : 0);
      a.obj.rotation.y += dt * 0.05;
      a.obj.rotation.z = Math.sin(t * 0.4 + a.phase) * 0.02;
    }
  });

  updateBaseKey();
  updateHero(dt);
  updateExpr(dt);
    updateLook(dt);   // 2026-11-04 副本：被看 5 秒 → 害羞
  updateEyeModules();
  updateBreath(dt, t);
  updateBrazier(dt, t);
  updateLamps(dt, t);
  updateSnowCover(dt);
  updateSnowman(dt, t);
  updateDriftSnow(dt, t);
  // 球体呼吸：第一人称时相机在球内，整球缩放等于场景围着人缩放 → 必晕，直接停掉
  globe.scale.setScalar(fpMode.on ? 1 : 1 + Math.sin(t * 0.62) * 0.0012);
  updateTrain(dt);
  updateMeteors(dt);
  updateDirector(dt);
  /* 极光：常驻（不再"每三天一次"），两层反向流动 + 呼吸式明暗。
     白天淡出到接近 0，夜里保持可见。 */
  if (auroraMat && auroraMat._tex) {
    const night = 1 - dayMix;
    // 近层：缓慢流动，明暗呼吸周期约 14 秒（透明度压到很低，只做点缀）
    auroraMat._tex.offset.x = (t * 0.008) % 1;
    const breathe = 0.5 + 0.5 * Math.sin(t * 0.45);
    const base = (window.__auroraBoost !== undefined ? window.__auroraBoost : 1.0);
    const want = night * base * (0.20 + 0.08 * breathe);
    auroraMat.opacity += (want - auroraMat.opacity) * Math.min(1, dt * 1.2);
  }
  if (auroraMat2 && auroraMat2._tex) {
    // 远层：反向、更慢，制造视差纵深
    auroraMat2._tex.offset.x = (-t * 0.004) % 1;
    const breathe2 = 0.5 + 0.5 * Math.sin(t * 0.28 + 1.7);
    const base2 = (window.__auroraBoost !== undefined ? window.__auroraBoost : 1.0);
    const want2 = (1 - dayMix) * base2 * (0.10 + 0.05 * breathe2);
    auroraMat2.opacity += (want2 - auroraMat2.opacity) * Math.min(1, dt * 1.0);
  }
  updateQuality(dt);
  if (snowMat) snowMat.uniforms.uTime.value = t;
  snowSwirl *= Math.pow(0.30, dt);
  if (snowSwirl < 0.001) snowSwirl = 0;
  if (snowMat) snowMat.uniforms.uSwirl.value = snowSwirl;
  if (snowPts) snowPts.rotation.y = snowSwirl * 1.15 * snowDir;


  if (shakeAmp > 0.001) {
    camera.position.x += (Math.random() - 0.5) * 0.016 * shakeAmp;
    camera.position.y += (Math.random() - 0.5) * 0.016 * shakeAmp;
    shakeAmp *= Math.pow(0.02, dt);
  }

  if (EYELAB_ON) eyeLabApply();
  renderer.render(scene, camera);

  if (shotPend && t >= shotPend) { shotPend = 0; shotDone = true; exportShot(); }

  frames++; fpsT += dt;
  if (fpsT > 0.5) { fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; }
  if (showHud) {
    const info = renderer.info;
    hud.textContent =
      `fps      ${fps}\n` +
      `draw     ${info.render.calls}\n` +
      `tris     ${(info.render.triangles / 1000).toFixed(1)}k\n` +
      `geo      ${info.memory.geometries}  tex ${info.memory.textures}\n` +
      `glass    ${CFG.transmission ? 'transmission' : 'fake'}
` +
      `tier     ${perf.tier}  day ${dayMix.toFixed(2)}\n` +
      `bgInt    ${scene.backgroundIntensity.toFixed(2)}  exp ${renderer.toneMappingExposure.toFixed(2)}\n` +
      `meteor   ${meteors.pool.filter(m => m.life > 0).length}  t ${meteors.timer.toFixed(2)}\n` +
      `snow     ${S.snow.toFixed(2)}  wind ${S.wind.toFixed(2)}  glow ${S.glow.toFixed(2)}\n` +
      `layout   ${layoutReport}\n` +
      `vp       ${innerWidth}x${innerHeight} dpr ${(devicePixelRatio||1).toFixed(2)} scale ${renderer.getPixelRatio().toFixed(2)}\n` +
      `hero     h=${hero.spanOK || '-'} scale=${hero.wrap ? hero.wrap.scale.x.toFixed(4) : '-'} off=${hero.groundOffset.toFixed(3)}` +
      (hero.fish ? `\nfish     seatH=${hero.fish.dbg.seatH.toFixed(3)} sole=${hero.fish.dbg.soleDrop.toFixed(3)} ank0=${hero.fish.dbg.ankle0.toFixed(3)} ank1=${hero.fish.dbg.ankle1.toFixed(3)} hips=${hero.fish.dbg.hipsY.toFixed(3)} sy=${hero.fish.dbg.sy.toFixed(3)}` : '');
  }
}

/* ============================== 尺寸 ============================== */

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(renderScale());   // 顺序要紧：先定倍率再定尺寸
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

/* ============================== 启动 ============================== */

let hintShown = false;
function hideHint() {
  const el = document.getElementById('hint');
  el.classList.remove('show');
  hintShown = true;
}

const DBG = new URLSearchParams(location.search).has('dbg') || new URLSearchParams(location.search).has('debug');
function stage(m) { if (!DBG) return; const l = document.querySelector('.ltitle'); if (l) l.textContent = m; }


/* ---------------- 自定义面板 ---------------- */

function applySnowUniforms() {
  if (!snowMat) return;
  snowMat.uniforms.uDensity.value = S.snow;
  snowMat.uniforms.uWind.value = S.wind;
}

function applySettings() {
  dayTarget = S.day;
  applySnowUniforms();
  perf.auto = S.tierAuto !== 0;
  applyTier(S.tier);
  drawPlaque(S.plaque);
  // 极光强度（默认 1.0，面板可调 0~2）
  window.__auroraBoost = (S.aurora !== undefined ? S.aurora : 1);
}

function setupPanel() {
  const btn = document.getElementById('cfgBtn');
  const panel = document.getElementById('panel');
  if (!btn || !panel) return;

  const $ = id => document.getElementById(id);
  const open = v => panel.classList.toggle('open', v);
  btn.addEventListener('click', () => open(!panel.classList.contains('open')));
  $('cfgClose').addEventListener('click', () => open(false));

  const sliders = [
    { id: 's-day',    out: 'v-day',    get: () => S.day * 100,   set: v => { S.day = v / 100; dayTarget = S.day; },
      fmt: v => (v < 12 ? '夜' : v > 88 ? '昼' : '过渡') },
    { id: 's-snow',   out: 'v-snow',   get: () => S.snow * 100,  set: v => { S.snow = v / 100; applySnowUniforms(); },
      fmt: v => Math.round(v) + '%' },
    { id: 's-wind',   out: 'v-wind',   get: () => S.wind * 100,  set: v => { S.wind = v / 100; applySnowUniforms(); },
      fmt: v => Math.round(v) + '%' },
    { id: 's-ferris', out: 'v-ferris', get: () => S.ferris * 100, set: v => { S.ferris = v / 100; },
      fmt: v => Math.round(v) + '%' },
    { id: 's-train',  out: 'v-train',  get: () => S.train * 100, set: v => { S.train = v / 100; },
      fmt: v => Math.round(v) + '%' },
    { id: 's-glow',   out: 'v-glow',   get: () => S.glow * 100,  set: v => { S.glow = v / 100; },
      fmt: v => Math.round(v) + '%' },
    { id: 's-exp',    out: 'v-exp',    get: () => S.exp * 100,   set: v => { S.exp = v / 100; },
      fmt: v => Math.round(v) + '%' },
    { id: 's-aurora', out: 'v-aurora', get: () => (S.aurora !== undefined ? S.aurora : 1) * 100,
      set: v => { S.aurora = v / 100; window.__auroraBoost = S.aurora; },
      fmt: v => Math.round(v) + '%' },
  ];

  for (const sl of sliders) {
    const el = $(sl.id), out = $(sl.out);
    if (!el) continue;
    el.addEventListener('input', () => {
      sl.set(Number(el.value));
      saveCfg();
      if (out) out.textContent = sl.fmt(Number(el.value));
    });
  }

  // 分段按钮：环绕 / 画质
  const seg = (wrapId, key, after) => {
    const wrap = $(wrapId);
    if (!wrap) return;
    wrap.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        S[key] = Number(b.dataset.v);
        saveCfg();
        wrap.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        if (after) after(S[key]);
      });
    });
  };
  const viewWrap = $('seg-view');
  if (viewWrap) {
    const syncView = () => viewWrap.querySelectorAll('button').forEach(b =>
      b.classList.toggle('on', Number(b.dataset.v) === (fpMode.on ? 1 : 0)));
    viewWrap.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => { setFP(Number(b.dataset.v) === 1); syncView(); });
    });
    window.__syncView = syncView;
    syncView();
  }
  seg('seg-orbit', 'orbit');
  seg('seg-tier', 'tier', v => applyTier(v, true));
  // 调试/自动化用：window.__tier(0|1|2) 切档，window.__perf 查当前状态
  window.__applyTier = applyTier;
  window.__perf = perf;
  window.__tier = (t) => { applyTier(t, true); return { tier: perf.tier, scale: renderer.getPixelRatio() }; };

  // 铭牌文字
  const inp = $('in-plaque');
  if (inp) {
    inp.addEventListener('input', () => {
      S.plaque = inp.value.slice(0, 8);
      saveCfg();
      drawPlaque(S.plaque);
    });
  }

  // 复位
  $('cfgReset').addEventListener('click', () => {
    Object.assign(S, DEFAULTS);
    saveCfg();
    applySettings();
    syncPanel();
  });

  function syncPanel() {
    for (const sl of sliders) {
      const el = $(sl.id), out = $(sl.out);
      if (!el) continue;
      el.value = String(Math.round(sl.get()));
      if (out) out.textContent = sl.fmt(sl.get());
    }
    const o = $('seg-orbit'), t = $('seg-tier');
    if (o) o.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === S.orbit));
    if (t) t.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === S.tier));
    if (inp) inp.value = S.plaque;
  }
  syncPanel();

  window.__syncPanel = syncPanel;
  window.__togglePanel = (force) =>
    open(force === undefined ? !panel.classList.contains('open') : !!force);
  if (new URLSearchParams(location.search).get('cfg') === '1') open(true);
}

async function main() {
  resize();
  setupControls();
  setupPanel();
  buildEnvironment();
  buildLights();
  buildGround();
  buildBase();
  buildGlass();
  buildFerris();
  stage('snow');
  buildSnow();
  stage('meteor');
  buildMeteors();
  buildAurora();
  setupDaily();
  applyDaily();
  applyTier(S.tier);
  applySettings();

  const bar = document.getElementById('lprog');
  stage('models');
  await loadAll(p => { bar.style.width = (p * 100).toFixed(0) + '%'; });

  stage('props');
  if (loaded.gondola) attachGondolas(loaded.gondola);
  buildProps();
  stage('track');
  buildStonePath();
  buildTrack();
  buildStation();
  validateLayout();
  stage('train');
  buildTrain();
  stage('done');

  clock.start();
  animate();
  window.__bootMs = Math.round(performance.now());   // 冷启动到可交互的耗时
  window.__ready = true;      // 供外部截图工具（tools/shot.mjs）判断场景已就绪
  window.__getDay = () => dayMix;
  window.__fpsGet = () => fps;
  // 调试接口：外部脚本可摆机位（tools/shot.mjs --eval）
  window.__fp = fpMode;
  window.__setFP = setFP;
  window.__hero = hero;
  window.__fx = fx;
  window.__THREE = THREE;
  window.__scene = scene;
  window.__camera = camera;
  window.__renderer = renderer;
  window.__key = keyLight;
  window.__CFG = CFG;
  window.__layout = LAYOUT;
  window.__lightLamp = lightLamp;
  // 世界坐标 → 屏幕坐标（自动化巡检点击用）
  window.__proj = (x, y, z) => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return {
      x: Math.round((v.x * 0.5 + 0.5) * innerWidth),
      y: Math.round((-v.y * 0.5 + 0.5) * innerHeight),
      z: v.z,
    };
  };
  window.__skY = lowestSkinnedY;
  window.__surfY = surfY;
  window.__pond = pond;
  window.__ctrl = ctrl;
  window.__go = (x, z, yaw, pitch) => {
    setFP(true);
    fpMode.pos.set(x, 0, z);
    fpMode.yaw = yaw;
    fpMode.pitch = pitch || 0;
  };
  if (new URLSearchParams(location.search).get('fp') === '1') setTimeout(() => setFP(true), 400);

  setTimeout(() => {
    const ld = document.getElementById('loader');
    if (new URLSearchParams(location.search).get('nofade') === '1') ld.remove();
    else ld.classList.add('done');
    setTimeout(() => {
      if (!hintShown) document.getElementById('hint').classList.add('show');
      setTimeout(hideHint, 6000);
    }, 900);
  }, 320);
}

main().catch(err => {
  console.error(err);
  document.getElementById('err').classList.add('show');
});
