/* lab.mjs —— 常驻浏览器调试器（替代 shots.mjs 的"每次冷启动"模式）
 *
 * 解决的问题：
 *   1. shots.mjs 每个 plan 都要起一次 Edge 进程（3~5s）+ 载入 26MB 资产（5~10s），
 *      跑 40 次等于 40 次冷启动，且中途超时会让整轮结果作废。
 *   2. 改完代码必须整个进程重来，无法"改文件 → 刷新 → 截图"快速循环。
 *   3. 结果靠肉眼看图判断，主观且不可复现。
 *
 * 本工具：
 *   - 只启动一次浏览器，plan 里用 { "reload": true } 在同一会话内刷新；
 *   - 每个 task 可带 "probe"（表达式，返回值会被打印）和 "expect"（断言），
 *     输出 PASS/FAIL，避免"看着像好了"的误判；
 *   - 单个 task 失败只记录，不中断后续 task。
 *
 * 用法：
 *   node tools/lab.mjs --url "http://127.0.0.1:8930/index.html?nofade=1" --plan lab.json
 *
 * plan 示例：
 *   [
 *     { "name": "base",  "reload": true, "wait": 1200,
 *       "probe": "JSON.stringify({key:__key.intensity})" },
 *     { "name": "fp",    "js": "__setFP(true)", "wait": 1200,
 *       "probe": "JSON.stringify({fp:__fp.on})",
 *       "expect": { "fp": true } }
 *   ]
 *
 * expect 支持三种形式：
 *   { "a": 1 }            → probe 结果中 a 全等于 1
 *   { "a": ">0.5" }       → 比较运算（>, >=, <, <=, ==, !=）
 *   { "a": true }         → 真值判断
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
const planFile = arg('plan', 'lab.json');
const size = arg('size', '1100x700');
const dir = arg('dir', 'shots');
const port = Number(arg('port', '9460'));
const [W, H] = size.split('x').map(Number);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));

fs.mkdirSync(dir, { recursive: true });
const udd = path.resolve('_labprof');
fs.mkdirSync(udd, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map(); this.logs = [];
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.logs.push('[EXC] ' + (d.exception?.description || d.text));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.logs.push('[console.error] ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (m.id && this.waiting.has(m.id)) {
        const { res } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        res(m);
      }
    });
  }
  send(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((res) => {
      this.waiting.set(id, { res });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); res({ error: 'timeout ' + method }); }
      }, timeout);
    });
  }
  /// 求值并把结果按 JSON 解析；表达式应自行 return 字符串
  async eval(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise,
    }, 60000);
    if (r.error) return { __err: r.error };
    if (r.result?.exceptionDetails) {
      return { __err: r.result.exceptionDetails.exception?.description || 'exception' };
    }
    const v = r.result?.result?.value;
    if (typeof v !== 'string') return { __raw: v };
    try { return JSON.parse(v); } catch (_) { return { __raw: v }; }
  }
  async shot(file) {
    const s = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 60000);
    if (!s.result?.data) return 0;
    fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'));
    return fs.statSync(file).size;
  }
  async waitReady(ms = 60000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await sleep(500);
      const st = await this.eval('JSON.stringify({ready:!!window.__ready})', false);
      if (st.ready) return true;
    }
    return false;
  }
}

/* ---------- 断言 ---------- */
function check(expect, got) {
  const fails = [];
  for (const [k, want] of Object.entries(expect)) {
    const v = got?.[k];
    if (typeof want === 'string' && /^(>=|<=|>|<|==|!=)\s*-?[\d.]+$/.test(want)) {
      const m = want.match(/^(>=|<=|>|<|==|!=)\s*(-?[\d.]+)$/);
      const op = m[1], n = Number(m[2]);
      const num = Number(v);
      const ok = op === '>' ? num > n : op === '>=' ? num >= n
        : op === '<' ? num < n : op === '<=' ? num <= n
          : op === '==' ? num === n : num !== n;
      if (!ok) fails.push(`${k}=${v} 不满足 ${want}`);
    } else if (want === true || want === false) {
      if (!!v !== want) fails.push(`${k}=${JSON.stringify(v)} 期望 ${want}`);
    } else if (JSON.stringify(v) !== JSON.stringify(want)) {
      fails.push(`${k}=${JSON.stringify(v)} 期望 ${JSON.stringify(want)}`);
    }
  }
  return fails;
}

/* ---------- 主流程 ---------- */
async function main() {
  const proc = spawn(EDGE, [
    '--headless=new', '--use-angle=d3d11', '--no-proxy-server', '--hide-scrollbars',
    '--mute-audio', '--force-device-scale-factor=1', `--window-size=${W},${H}`,
    `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, 'about:blank',
  ], { stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 80 && !page; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = j.find((t) => t.type === 'page');
    } catch (_) { /* retry */ }
    if (!page) await sleep(200);
  }
  if (!page) throw new Error('devtools not ready');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const t0 = Date.now();
  await cdp.send('Page.navigate', { url });
  if (!(await cdp.waitReady())) throw new Error('scene never ready');
  const bootMs = Date.now() - t0;

  const report = [];
  for (const task of plan) {
    const rec = { name: task.name, ok: true };
    const ts = Date.now();
    try {
      if (task.reload) {
        await cdp.send('Page.reload', { ignoreCache: true });
        if (!(await cdp.waitReady())) throw new Error('reload 后未就绪');
        if (task.js) await cdp.eval(task.js);
      } else if (task.js) {
        const r = await cdp.eval(task.js);
        if (r.__err) throw new Error('js 抛错: ' + r.__err);
      }
      await sleep(task.wait ?? 1400);

      if (task.probe) {
        let p = await cdp.eval(task.probe);
        if (p.__err) throw new Error('probe 抛错: ' + p.__err);
        rec.probe = p;
        if (task.expect) {
          const fails = check(task.expect, p);
          if (fails.length) { rec.ok = false; rec.fails = fails; }
        }
      }
      if (task.name) {
        rec.bytes = await cdp.shot(path.join(dir, task.name + '.png'));
      }
    } catch (e) {
      rec.ok = false;
      rec.error = e.message;
    }
    rec.ms = Date.now() - ts;
    report.push(rec);
  }

  const bad = report.filter((r) => !r.ok);
  console.log(JSON.stringify({
    bootMs,
    total: report.length,
    pass: report.length - bad.length,
    fail: bad.length,
    report,
  }, null, 1));
  if (cdp.logs.length) console.log('--- 页面错误 ---\n' + cdp.logs.slice(0, 10).join('\n'));

  ws.close();
  proc.kill();
  process.exit(bad.length ? 2 : 0);
}

main().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
