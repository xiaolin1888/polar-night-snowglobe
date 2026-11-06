/* 交互功能巡检：加载一次，逐项触发交互，记录状态变化 + 截图 + 控制台错误
 *
 *   node tools/audit.mjs --url "http://127.0.0.1:8930/index.html?nofade=1&scale=1"
 *
 * 输出：shots/audit-*.png 与 stdout 的 JSON 报告
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const url = arg('url');
const size = arg('size', '1440x900');
const dir = arg('dir', 'shots');
const port = Number(arg('port', '9443'));
const [W, H] = size.split('x').map(Number);

fs.mkdirSync(dir, { recursive: true });
const udd = path.resolve('_auditprof');
fs.mkdirSync(udd, { recursive: true });

const proc = spawn(EDGE, [
  '--headless=new', '--use-angle=d3d11', '--no-proxy-server', '--hide-scrollbars',
  '--mute-audio', '--force-device-scale-factor=1', `--window-size=${W},${H}`,
  `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map(); this.errors = []; this.logs = [];
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.waiting.has(m.id)) {
        const { res, rej } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        this.errors.push('EXC ' + (d.exception?.description || d.text || '').slice(0, 220));
      }
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        this.logs.push(m.params.type.toUpperCase() + ' ' + String(txt).slice(0, 220));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); rej(new Error('timeout ' + method)); }
      }, 60000);
    });
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { try { return JSON.stringify(${expr}); } catch (e) { return JSON.stringify({ __err: String(e && e.message || e) }); } })()`,
      returnByValue: true,
      awaitPromise: false,
    });
    try { return JSON.parse(r.result.value); } catch (_) { return { __raw: r.result.value }; }
  }
  async key(code, key, vk) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk });
    await sleep(40);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await sleep(60);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(60);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  async shot(name) {
    const s = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const out = path.join(dir, 'audit-' + name + '.png');
    fs.writeFileSync(out, Buffer.from(s.data, 'base64'));
    return out;
  }
}

async function main() {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = j.find((t) => t.type === 'page');
    } catch (_) { /* retry */ }
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('devtools not ready');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url });

  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    await sleep(800);
    const st = await cdp.evalJs('({ ready: !!window.__ready })').catch(() => ({}));
    if (st && st.ready) { ready = true; break; }
  }
  if (!ready) throw new Error('scene never ready');
  await sleep(2000);

  const R = { ready: true, steps: {} };

  R.steps.boot = await cdp.evalJs('({ lamps: __fx.lamps.map(l=>l.on), cover: +__fx.cover.toFixed(2), caught: __hero.fish ? __hero.fish.caught : -1, mode: __hero.mode, collected: __fx.collected.size })');
  await cdp.shot('01-boot');

  // ---- 点击钓鱼男孩 → 咬钩 → 一条鱼飞进桶 ----
  const subj = await cdp.evalJs('__probeSubj ? __proj(__probeSubj.x, __probeSubj.y, __probeSubj.z) : null');
  if (subj && subj.z < 1) {
    await cdp.click(subj.x, subj.y);
    await sleep(500);
    const biting = await cdp.evalJs('({ bite: __hero.fish.bite, caught: __hero.fish.caught })');
    await sleep(3500);
    const after = await cdp.evalJs('({ bite: __hero.fish.bite, caught: __hero.fish.caught, flying: !!__hero.fish.flying })');
    R.steps.catchFish = { click: subj, biting, after, ok: after.caught > 0 };
    await cdp.shot('02-catch');
  } else {
    R.steps.catchFish = { skipped: true, subj };
  }

  // ---- 点击路灯 → 链式点亮 ----
  const lampPt = await cdp.evalJs('__proj(__layout.lamp.x, -0.315, __layout.lamp.z)');
  if (lampPt && lampPt.z < 1) {
    await cdp.click(lampPt.x, lampPt.y);
    await sleep(1400);
    R.steps.lampChain = await cdp.evalJs('({ lamps: __fx.lamps.map(l=>l.on) })');
    R.steps.lampChain.ok = R.steps.lampChain.lamps.some(Boolean);
    await cdp.shot('03-lamp');
  } else {
    R.steps.lampChain = { skipped: true, lampPt };
  }

  // ---- 空格摇一摇 → 积雪增长 ----
  const before = await cdp.evalJs('+__fx.cover.toFixed(2)');
  await cdp.key('Space', ' ', 32);
  await sleep(600);
  await cdp.key('Space', ' ', 32);
  await sleep(900);
  const after2 = await cdp.evalJs('({ cover: +__fx.cover.toFixed(2), piles: __fx.piles ? __fx.piles.filter(p=>p.m.visible).length : -1 })');
  R.steps.shake = { before, after: after2, ok: after2.cover > before };
  await cdp.shot('04-shake');

  // ---- N 昼夜 ----
  await cdp.key('KeyN', 'n', 78);
  await sleep(1600);
  R.steps.day = await cdp.evalJs('({ cls: document.body.className, day: window.__getDay ? +window.__getDay().toFixed(2) : null })').catch(() => ({ note: 'state not exposed' }));
  await cdp.shot('05-day');
  await cdp.key('KeyN', 'n', 78);
  await sleep(1400);

  // ---- C 设置面板 ----
  await cdp.key('KeyC', 'c', 67);
  await sleep(700);
  R.steps.panel = await cdp.evalJs('({ open: (document.getElementById("panel")||{}).className || "" })');
  await cdp.shot('06-panel');
  await cdp.key('KeyC', 'c', 67);
  await sleep(500);

  // ---- M 流星 ----
  await cdp.key('KeyM', 'm', 77);
  await sleep(900);
  await cdp.shot('07-meteor');

  // ---- V 第一人称 + WASD ----
  await cdp.key('KeyV', 'v', 86);
  await sleep(1200);
  const p0 = await cdp.evalJs('({ on: __fp.on, x: +__fp.pos.x.toFixed(3), z: +__fp.pos.z.toFixed(3) })');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  await sleep(1200);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  await sleep(400);
  const p1 = await cdp.evalJs('({ x: +__fp.pos.x.toFixed(3), z: +__fp.pos.z.toFixed(3), fov: +__fp.on })');
  R.steps.fp = { p0, p1, moved: Math.hypot(p1.x - p0.x, p1.z - p0.z) > 0.01 };
  await cdp.shot('08-fp');

  // ---- 收集 ----
  R.steps.collect = await cdp.evalJs('({ n: __fx.collected.size, list: [...__fx.collected] })');

  // ---- 性能 ----
  R.fps = await cdp.evalJs('({ fps: window.__fps || null, dpr: devicePixelRatio, scale: +(document.querySelector("canvas").width / innerWidth).toFixed(2) })');
  R.errors = cdp.errors.slice(0, 20);
  R.logs = cdp.logs.slice(0, 20);

  console.log(JSON.stringify(R, null, 1));
  ws.close();
  proc.kill();
}

main().catch((e) => {
  console.error('FAIL', e.message);
  try { proc.kill(); } catch (_) {}
  process.exit(1);
});
