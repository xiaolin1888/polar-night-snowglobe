import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9451;
const udd = path.resolve('_cdnprof2');
fs.mkdirSync(udd, { recursive: true });
const proc = spawn(EDGE, [
  '--headless=new', '--use-angle=d3d11', '--no-proxy-server', '--hide-scrollbars',
  '--mute-audio', '--force-device-scale-factor=1', '--window-size=1100,700',
  `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page = null;
for (let i = 0; i < 60 && !page; i++) {
  try {
    const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = j.find((t) => t.type === 'page');
  } catch (_) {}
  if (!page) await sleep(250);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));
let id = 0; const waiting = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
  if (m.method === 'Runtime.consoleAPICalled') logs.push('[console] ' + m.params.args.map(a => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('[EXC] ' + JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Log.entryAdded') logs.push('[log] ' + m.params.entry.level + ' ' + m.params.entry.text);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (waiting.has(i)) { waiting.delete(i); res({ error: 'timeout' }); } }, 30000); });
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.enable');
await send('Page.navigate', { url: (process.env.PROBE_URL || 'http://127.0.0.1:8940/index.html?nofade=1') });
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  const r = await send('Runtime.evaluate', { expression: 'JSON.stringify({ready:!!window.__ready,title:document.title,body:document.body?document.body.children.length:0})', returnByValue: true });
  const v = r.result?.result?.value;
  if (i % 4 === 0) console.log('t=' + (i + 1) + 's', v);
  if (v && v.includes('"ready":true')) break;
}
const evalJs = process.argv[2];
if (evalJs) {
  const r = await send('Runtime.evaluate', { expression: evalJs, returnByValue: true, awaitPromise: true });
  console.log('EVAL', JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r).slice(0, 4000));
}
console.log('--- logs ---');
console.log(logs.slice(0, 40).join('\n'));
ws.close(); proc.kill();
