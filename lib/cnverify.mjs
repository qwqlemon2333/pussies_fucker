// lib/cnverify.mjs - 中国大陆视角的可用性实测（第二级验证）。
//
// 第一级（pipeline 的 fidelity probe）跑在 GitHub runner 上：那是一台海外机房机器，
// 它能证明的只有「这条节点还活着、协议握手没问题」。它证明不了「从中国大陆拨号能不能用」——
// 因为大陆出口的国际带宽、路由、以及针对协议特征的干扰，都发生在 runner 之外。
//
// 这一级必须在大陆的真实网络里跑：把候选池灌进一个临时 mihomo，多轮、多目标地测
// 端到端 delay，只有「多数轮次都能成功」的节点才写进 -cn 订阅。可选再对通过的节点
// 做一次真实吞吐抽样（切换 selector 后走 mixed-port 下载固定字节）。
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

// 默认必须目标：一个 204 空响应，直接证明这条链路能把请求送达公网。
export const DEFAULT_REQUIRED = ['https://www.gstatic.com/generate_204'];
// 默认参考目标：只记录，不参与通过判定。github 两个域名正好覆盖「开发场景能不能用」。
export const DEFAULT_PROBES = [
  'https://api.github.com/rate_limit',
  'https://raw.githubusercontent.com/MetaCubeX/mihomo/Meta/README.md',
];

export const DEFAULT_THROUGHPUT_URL = 'https://speed.cloudflare.com/__down?bytes=2000000';

function shortUrl(u) {
  try { const x = new URL(u); return x.hostname + (x.pathname.length > 24 ? x.pathname.slice(0, 24) + '...' : x.pathname); } catch { return String(u).slice(0, 40); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function qname(s) {
  const v = String(s == null ? '' : s);
  if (v !== '' && /^[A-Za-z0-9._\/+=-]+$/.test(v) && !/^(true|false|null|yes|no|on|off)$/i.test(v)) return v;
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function httpJson(port, p, timeoutMs, method, body) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: method || 'GET', timeout: timeoutMs || 8000,
      headers: Object.assign({ 'User-Agent': 'nodepool-cnverify' }, payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (buf.length < 65536) buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = buf.trim() ? JSON.parse(buf) : null; } catch {}
        done({ status: res.statusCode, json, error: null });
      });
    });
    req.on('timeout', () => { req.destroy(); done({ status: 0, json: null, error: 'timeout' }); });
    req.on('error', (e) => done({ status: 0, json: null, error: e.code || String(e.message) }));
    if (payload) req.write(payload);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    try { s.listen(port, '127.0.0.1'); } catch { resolve(false); }
  });
}

// A provider file is exactly 'proxies:' + items, so the text can be reused verbatim;
// we only need the names to address them through the REST API.
export function namesFromProvider(text) {
  const names = [];
  const re = /^  - name: (.+)$/gm;
  let m;
  while ((m = re.exec(text))) {
    let v = m[1].trim();
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
      v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    names.push(v);
  }
  return names;
}

function buildConfig(providerText, names, apiPort, mixedPort) {
  const head = [
    'mixed-port: ' + mixedPort,
    'allow-lan: false',
    'bind-address: 127.0.0.1',
    'mode: rule',
    'log-level: warning',
    'ipv6: false',
    'external-controller: 127.0.0.1:' + apiPort,
    'secret: ""',
    'profile: {store-selected: false, store-fake-ip: false}',
    'dns: {enable: false}',
  ].join('\n') + '\n';
  const group = [
    'proxy-groups:',
    '  - name: POOL',
    '    type: select',
    '    proxies:',
  ].concat(names.map((n) => '      - ' + qname(n))).join('\n') + '\n';
  return head + providerText.trim() + '\n' + group + 'rules:\n  - MATCH,POOL\n';
}

function startMihomo(bin, cfgPath, dir, logPath) {
  return new Promise(async (resolve) => {
    const out = await fs.open(logPath, 'w').catch(() => null);
    const child = spawn(bin, ['-f', cfgPath, '-d', dir], {
      cwd: dir, windowsHide: true,
      stdio: ['ignore', out ? out.fd : 'ignore', out ? out.fd : 'ignore'],
      env: Object.assign({}, process.env, { NO_PROXY: '*', no_proxy: '*' }),
    });
    let exited = null;
    child.once('exit', (code, sig) => { exited = { code, sig }; });
    child.once('error', (e) => { exited = { code: null, sig: null, error: String(e.message) }; });
    // 子进程已经拿到了自己那份描述符副本，父进程这份可以立刻关掉；留着不关会在 GC 时
    // 触发 "Closing file descriptor on garbage collection"，而且日志可能还没落盘就被回收。
    if (out) { try { await out.close(); } catch {} }
    resolve({ child, exited: () => exited });
  });
}

async function killChild(child, waitMs) {
  if (!child) return;
  try { child.kill('SIGTERM'); } catch {}
  const t0 = Date.now();
  while (Date.now() - t0 < (waitMs || 4000)) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(100);
  }
  try { child.kill('SIGKILL'); } catch {}
}

// Download through the pool to measure real throughput: switch the selector,
// then pull N bytes over the mixed-port.
function curlThroughput(mixedPort, url, seconds) {
  return new Promise((resolve) => {
    // -L matters: github.com/.../releases/download/... answers 302 and the body only
    // arrives after following it to objects.githubusercontent.com.
    const args = ['--noproxy', '', '-x', 'http://127.0.0.1:' + mixedPort, '-sS', '-L', '--max-redirs', '5',
      '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
      '-w', '%{http_code} %{size_download} %{time_total}', '-m', String(seconds || 20), url];
    execFile('curl', args, { maxBuffer: 1 << 20, windowsHide: true, encoding: 'utf8' }, (err, so) => {
      const parts = String(so || '').trim().split(/\s+/);
      const code = parseInt(parts[0], 10) || 0;
      const bytes = parseInt(parts[1], 10) || 0;
      const secs = parseFloat(parts[2]) || 0;
      resolve({ code, bytes, seconds: secs, mbps: secs > 0 ? (bytes / 1048576) / secs : 0, error: err ? String(err.code || err.message) : null });
    });
  });
}

export async function cnVerify(opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const providerText = String(o.providerText || '');
  const names = o.names || namesFromProvider(providerText);
  const required = o.required && o.required.length ? o.required : DEFAULT_REQUIRED;
  const probes = o.probes || DEFAULT_PROBES;
  const rounds = Math.max(1, o.rounds || 3);
  const intervalMs = o.intervalMs == null ? 20000 : o.intervalMs;
  const timeoutMs = o.timeoutMs || 5000;
  const concurrency = Math.max(1, o.concurrency || 8);
  const maxRtt = o.maxRtt || 3000;
  const started = Date.now();
  if (!names.length) return { skipped: true, reason: 'no_nodes', names: [], verified: [] };
  if (!o.bin) return { skipped: true, reason: 'mihomo_unavailable', names, verified: [] };

  const workDir = o.workDir;
  await fs.mkdir(workDir, { recursive: true });
  const cfgPath = path.join(workDir, 'cn.yaml');
  const logPath = path.join(workDir, 'mihomo-cn.log');
  const apiPort = await portFree(9090 + 11) ? 9090 + 11 : await freePort();
  const mixedPort = await freePort();

  await fs.writeFile(cfgPath, buildConfig(providerText, names, apiPort, mixedPort), 'utf8');
  const startedProc = await startMihomo(o.bin, cfgPath, workDir, logPath);
  const child = startedProc.child;
  let apiReady = false;
  const dl = Date.now() + (o.apiTimeoutMs || 25000);
  while (Date.now() < dl) {
    const r = await httpJson(apiPort, '/version', 2000);
    if (r.status === 200) { apiReady = true; break; }
    if (startedProc.exited()) break;
    await sleep(200);
  }
  if (!apiReady) {
    let detail = '';
    try { detail = (await fs.readFile(logPath, 'utf8')).trim().slice(0, 400); } catch {}
    await killChild(child, 2000);
    return { skipped: true, reason: 'mihomo_api_unreachable', detail, names, verified: [] };
  }

  const delay = async (name, url) => {
    const p = '/proxies/' + encodeURIComponent(name) + '/delay?url=' + encodeURIComponent(url) + '&timeout=' + timeoutMs;
    const r = await httpJson(apiPort, p, timeoutMs + 3000);
    const d = r.json && typeof r.json.delay === 'number' ? r.json.delay : 0;
    return { delay: d, error: d > 0 ? null : ((r.json && r.json.message) || r.error || ('http ' + r.status)) };
  };

  const samples = new Map();
  for (const n of names) samples.set(n, []);

  const skipProbe = !!o.skipProbe;
  for (let round = 1; round <= (skipProbe ? 0 : rounds); round++) {
    let cursor = 0;
    let done = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= names.length) return;
        const name = names[i];
        const row = { round, required: [], probes: [], ok: true, worst: 0 };
        for (const url of required) {
          const r = await delay(name, url);
          row.required.push({ url, delay: r.delay, error: r.error });
          if (r.delay > 0) { row.worst = Math.max(row.worst, r.delay); } else { row.ok = false; }
        }
        for (const url of probes) {
          const r = await delay(name, url);
          row.probes.push({ url, delay: r.delay, error: r.error });
        }
        if (row.ok && row.worst > maxRtt) row.ok = false;
        samples.get(name).push(row);
        done++;
        if (o.onProgress && done % 10 === 0) o.onProgress(round, done, names.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, () => worker()));
    log('    round ' + round + '/' + rounds + ' done');
    if (round < rounds && intervalMs > 0) await sleep(intervalMs);
  }

  const minPass = o.minPass == null ? Math.ceil(rounds / 2) : o.minPass;
  const rows = [];
  for (const n of names) {
    if (skipProbe) {
      rows.push({ name: n, rounds: [], passes: rounds, median_rtt: 0, github_rtts: [], ok: true });
      continue;
    }
    const rowsForNode = samples.get(n);
    const passes = rowsForNode.filter((r) => r.ok).length;
    const rtts = rowsForNode.filter((r) => r.ok).map((r) => r.worst).sort((a, b) => a - b);
    const median = rtts.length ? rtts[Math.floor(rtts.length / 2)] : 0;
    const gh = rowsForNode.map((r) => { const p = r.probes.find((x) => x.delay > 0); return p ? p.delay : 0; }).filter((x) => x > 0);
    rows.push({ name: n, rounds: rowsForNode, passes, median_rtt: median, github_rtts: gh, ok: passes >= minPass && median > 0 });
  }

  const verified = rows.filter((r) => r.ok).sort((a, b) => (a.median_rtt || 1e9) - (b.median_rtt || 1e9));

  // Optional throughput sampling on the survivors. Several URLs matter more than one:
  // a node can be fast to a generic CDN and useless for github.com, and github.com is
  // usually the reason to want a node at all.
  let throughput = [];
  const tpUrls = o.throughputUrls && o.throughputUrls.length ? o.throughputUrls
    : [o.throughputUrl || DEFAULT_THROUGHPUT_URL];
  if (o.throughput && verified.length) {
    const pick = verified.slice(0, Math.min(o.throughput, verified.length));
    for (const row of pick) {
      const sel = await httpJson(apiPort, '/proxies/POOL', 5000, 'PUT', { name: row.name });
      if (sel.status !== 204 && sel.status !== 200) {
        throughput.push({ name: row.name, error: 'selector_switch_failed http ' + sel.status });
        continue;
      }
      await sleep(300);
      for (const url of tpUrls) {
        const t = await curlThroughput(mixedPort, url, o.throughputSeconds || 15);
        throughput.push({ name: row.name, url, http: t.code, bytes: t.bytes, seconds: t.seconds, mbps: Math.round(t.mbps * 100) / 100, error: t.code === 200 ? null : (t.error || 'http ' + t.code) });
        log('    throughput ' + row.name + ' ' + shortUrl(url) + ': ' + (t.code === 200 ? (Math.round(t.mbps * 100) / 100) + ' MiB/s (' + Math.round(t.bytes / 1024) + ' KiB)' : 'failed ' + (t.error || t.code)));
      }
    }
  }

  await killChild(child, 4000);
  try { await fs.unlink(cfgPath); } catch {}

  return {
    skipped: false,
    rounds,
    min_pass: minPass,
    max_rtt: maxRtt,
    required, probes,
    tested: names.length,
    verified: verified.map((r) => ({ name: r.name, median_rtt: r.median_rtt, passes: r.passes })),
    rejected: rows.filter((r) => !r.ok).map((r) => ({ name: r.name, passes: r.passes, median_rtt: r.median_rtt })),
    rows,
    throughput,
    api_port: apiPort,
    mixed_port: mixedPort,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

// Emit a provider file containing only the verified nodes, preserving each node's
// original YAML block so nothing we do not understand gets lost.
export function filterProvider(providerText, keepNames) {
  const keep = new Set(keepNames);
  const lines = providerText.split('\n');
  const head = [];
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    if (/^  - name: /.test(line)) {
      if (cur) blocks.push(cur);
      cur = [line];
      continue;
    }
    if (cur) cur.push(line);
    else head.push(line);
  }
  if (cur) blocks.push(cur);
  const out = [];
  const h = head.join('\n').replace(/\s+$/, '');
  out.push(h || 'proxies:');
  let kept = 0;
  for (const b of blocks) {
    const m = /^  - name: (.+)$/.exec(b[0]);
    let nm = m ? m[1].trim() : '';
    if (nm.length >= 2 && nm[0] === '"' && nm[nm.length - 1] === '"') nm = nm.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (!keep.has(nm)) continue;
    while (b.length && b[b.length - 1].trim() === '') b.pop();
    out.push(b.join('\n'));
    kept++;
  }
  return { text: out.join('\n') + '\n', kept };
}