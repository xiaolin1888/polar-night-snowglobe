/* 用 CDP 驱动 headless Edge 截图（无需 puppeteer）
 *
 * 用法：
 *   node tools/shot.mjs --url "http://127.0.0.1:8930/index.html?fp=1" --out shots/fp.png
 *   node tools/shot.mjs --url "..." --out x.png --eval "setFP(true)" --wait 26000 --size 1400x900
 *
 * 为什么不用 --screenshot：那个在 load 事件后立即截，早于异步 GLB 加载完成，
 * 拿到的永远是加载页。这里通过 CDP 等自定义条件（#load 消失）再截。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const url = arg('url');
const out = arg('out', 'shots/shot.png');
const waitMs = Number(arg('wait', '24000'));
const size = arg('size', '1440x900');
const evalJs = arg('eval', '');
const port = Number(arg('port', '9441'));
const [W, H] = size.split('x').map(Number);

if (!url) {
  console.error('missing --url');
  process.exit(1);
}

const udd = path.resolve('_cdnprof');
fs.mkdirSync(udd, { recursive: true });
fs.mkdirSync(path.dirname(out), { recursive: true });

const proc = spawn(EDGE, [
  '--headless=new',
  '--use-angle=d3d11',
  '--no-proxy-server',
  '--hide-scrollbars',
  '--mute-audio',
  '--force-device-scale-factor=1',
  `--window-size=${W},${H}`,
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${udd}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jsonList() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const j = await r.json();
      if (j && j.length) return j;
    } catch (_) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('devtools endpoint not ready');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.id && this.waiting.has(msg.id)) {
        const { res, rej } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
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
}

async function main() {
  const targets = await jsonList();
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url });

  // 等 #load 消失（场景构建完成）
  const deadline = Date.now() + waitMs;
  let ready = false;
  let lastTitle = '';
  while (Date.now() < deadline) {
    await sleep(700);
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: "JSON.stringify({t:document.title, ready:!!window.__ready, err:(document.getElementById('err')||{}).className||''})",
        returnByValue: true,
      });
      const st = JSON.parse(r.result.value || '{}');
      lastTitle = st.t || '';
      if (String(st.err).includes('show')) { console.error('page error overlay:', st.t); break; }
      if (st.ready) { ready = true; break; }
    } catch (_) { /* 页面还在跳转 */ }
  }
  await sleep(1200);
  if (!ready) console.error('warning: not confirmed ready, last title =', lastTitle);

  if (evalJs) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: evalJs, awaitPromise: true, returnByValue: true,
    });
    console.error('eval →', JSON.stringify(r.result && r.result.value));
    await sleep(Number(arg('after', '2200')));
  }

  await sleep(400);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({
    out,
    bytes: fs.statSync(out).size,
    title: (await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value,
  }));

  ws.close();
  proc.kill();
}

main().catch((e) => {
  console.error('FAIL', e.message);
  try { proc.kill(); } catch (_) {}
  process.exit(1);
});
