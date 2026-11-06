/* 一次加载、批量摆机位截图（复用 tools/shot.mjs 的 CDP 逻辑，省去反复加载 26MB 资产）
 *
 * 用法：
 *   node tools/shots.mjs --url "http://127.0.0.1:8930/index.html?nofade=1" --plan plan.json
 *
 * plan.json: [{ "name": "fp-front", "js": "__go(0,0.66,0)", "wait": 1800 }, ...]
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
const planFile = arg('plan', 'plan.json');
const size = arg('size', '1440x900');
const dir = arg('dir', 'shots');
const port = Number(arg('port', '9442'));
const [W, H] = size.split('x').map(Number);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));

fs.mkdirSync(dir, { recursive: true });
const udd = path.resolve('_cdnprof2');
fs.mkdirSync(udd, { recursive: true });

const proc = spawn(EDGE, [
  '--headless=new', '--use-angle=d3d11', '--no-proxy-server', '--hide-scrollbars',
  '--mute-audio', '--force-device-scale-factor=1', `--window-size=${W},${H}`,
  `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.waiting.has(m.id)) {
        const { res, rej } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
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
      }, 90000);
    });
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

  const deadline = Date.now() + Number(arg('wait', '45000'));
  let ready = false;
  while (Date.now() < deadline) {
    await sleep(800);
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: "JSON.stringify({ready:!!window.__ready,t:document.title})",
        returnByValue: true,
      });
      const st = JSON.parse(r.result.value || '{}');
      if (st.ready) { ready = true; break; }
    } catch (_) { /* navigating */ }
  }
  if (!ready) throw new Error('scene never became ready');
  await sleep(1500);

  const outList = [];
  for (const task of plan) {
    if (task.js) {
      await cdp.send('Runtime.evaluate', { expression: task.js, awaitPromise: true, returnByValue: true });
    }
    await sleep(task.wait || 1600);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const out = path.join(dir, task.name + '.png');
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    outList.push({ name: task.name, bytes: fs.statSync(out).size });
  }
  console.log(JSON.stringify({ ready, shots: outList }));
  ws.close();
  proc.kill();
}

main().catch((e) => {
  console.error('FAIL', e.message);
  try { proc.kill(); } catch (_) {}
  process.exit(1);
});
