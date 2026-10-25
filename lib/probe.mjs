// lib/probe.mjs - REAL proxy fidelity probe (the reason to run this in CI).
//
// A TCP connect only proves something is listening. This stage starts a private
// mihomo instance with every surviving node, asks its REST API for the delay each
// node achieves against https://www.gstatic.com/generate_204, and keeps only the
// nodes that actually proxied traffic. From a GitHub runner there is no egress
// firewall, so this is meaningful; from a locked-down dev box it is skipped.
//
// Everything here fails LOUDLY: if mihomo is unavailable or its API never answers,
// the stage returns {skipped:true, reason} and the caller reports proxy_verified:null.
// It never pretends nodes were verified.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildProvider, yamlName } from './emit.mjs';

export const PROBE_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_API_PORT = 9090;
const PROBE_GROUP = '__nodepool_probe__';

function qname(s) {
  const v = String(s == null ? '' : s);
  if (v !== '' && /^[A-Za-z0-9._\/+=-]+$/.test(v) && !/^(true|false|null|yes|no|on|off)$/i.test(v)) return v;
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    try { s.listen(port, '127.0.0.1'); } catch { resolve(false); }
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// Plain node:http, never the ambient proxy: this talks to 127.0.0.1 only.
function httpJson(port, p, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'GET', timeout: timeoutMs || 8000, headers: { 'User-Agent': 'nodepool-probe' } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (buf.length < 65536) buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = buf.trim() ? JSON.parse(buf) : null; } catch {}
          done({ status: res.statusCode, json, error: null });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); done({ status: 0, json: null, error: 'timeout' }); });
    req.on('error', (e) => done({ status: 0, json: null, error: e.code || String(e.message) }));
    req.end();
  });
}

// ---------- binary discovery ----------

const LOCAL_CANDIDATES = [
  'C:\\Program Files\\Clash Verge\\verge-mihomo.exe',
  'C:\\Program Files\\Clash Verge\\verge-mihomo-alpha.exe',
];

export async function findMihomoBinary(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  if (env.MIHOMO_BIN) {
    try {
      await fs.access(env.MIHOMO_BIN);
      return { path: env.MIHOMO_BIN, source: 'MIHOMO_BIN' };
    } catch {
      return { path: null, source: 'MIHOMO_BIN', error: 'MIHOMO_BIN set but not executable: ' + env.MIHOMO_BIN };
    }
  }
  const local = path.join(o.root || '.', 'bin', process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
  try {
    await fs.access(local);
    return { path: local, source: './bin' };
  } catch {}
  for (const c of LOCAL_CANDIDATES) {
    try { await fs.access(c); return { path: c, source: 'clash-verge' }; } catch {}
  }
  return { path: null, source: null };
}

function assetOsArch() {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? '386' : process.arch;
  const plat = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  return { plat, arch };
}

function pickAsset(assets, plat, arch) {
  const cands = [];
  for (const a of assets || []) {
    const name = a && a.name;
    if (!name || !a.browser_download_url) continue;
    if (/^mihomo-alpha-/.test(name) || /compatible|go120|go122/.test(name)) continue;
    const m = /^mihomo-([a-z0-9]+)-([a-z0-9]+)-v?([\d.]+)\.(gz|zip)$/.exec(name);
    if (!m) continue;
    if (m[1] !== plat || m[2] !== arch) continue;
    cands.push({ name, url: a.browser_download_url, ext: m[4], version: m[3], size: a.size || 0 });
  }
  cands.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return cands[0] || null;
}

function run(cmd, argv, opts) {
  return new Promise((resolve) => {
    execFile(cmd, argv, Object.assign({ maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, opts || {}), (err, so, se) => {
      resolve({ ok: !err, code: err && typeof err.code === 'number' ? err.code : 0, stdout: String(so || ''), stderr: String(se || (err && err.message) || '') });
    });
  });
}

// Download the latest mihomo release matching this runner's OS/arch.
export async function downloadMihomo(opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const destDir = o.destDir;
  const { plat, arch } = assetOsArch();
  const meta = await run('curl', ['-sS', '-L', '--max-time', '40', '-H', 'Accept: application/vnd.github+json', '-H', 'User-Agent: nodepool', 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest']);
  if (!meta.ok) return { ok: false, error: 'release metadata fetch failed: ' + (meta.stderr || '').trim().slice(0, 200) };
  let json = null;
  try { json = JSON.parse(meta.stdout); } catch { return { ok: false, error: 'release metadata is not JSON' }; }
  const asset = pickAsset(json.assets, plat, arch);
  if (!asset) return { ok: false, error: 'no mihomo asset for ' + plat + '-' + arch + ' in ' + (json.tag_name || 'latest') };
  await fs.mkdir(destDir, { recursive: true });
  const archFile = path.join(destDir, asset.name);
  log('    mihomo: downloading ' + asset.name + ' (' + Math.round(asset.size / 1024) + ' KB)');
  const dl = await run('curl', ['-sS', '-L', '--max-time', '180', '-o', archFile, '-w', '%{http_code}', asset.url]);
  if (!dl.ok) return { ok: false, error: 'download failed: ' + (dl.stderr || '').trim().slice(0, 200) };
  const code = parseInt((dl.stdout || '').trim().slice(-3), 10);
  if (code !== 200) return { ok: false, error: 'download http ' + code + ' for ' + asset.url };
  const binPath = path.join(destDir, plat === 'windows' ? 'mihomo.exe' : 'mihomo');
  if (asset.ext === 'gz') {
    const buf = await fs.readFile(archFile);
    await fs.writeFile(binPath, zlib.gunzipSync(buf));
  } else {
    const t = await run('tar', ['-xf', archFile, '-C', destDir]);
    if (!t.ok) {
      const ps = await run('powershell', ['-NoProfile', '-Command', 'Expand-Archive -Force -LiteralPath "' + archFile + '" -DestinationPath "' + destDir + '"']);
      if (!ps.ok) return { ok: false, error: 'unzip failed: ' + (t.stderr || ps.stderr || '').trim().slice(0, 200) };
    }
    try { await fs.rename(path.join(destDir, 'mihomo.exe'), binPath); } catch {}
  }
  await fs.chmod(binPath, 0o755).catch(() => {});
  const v = await run(binPath, ['-v']);
  if (!v.ok) return { ok: false, error: 'downloaded binary is not runnable: ' + (v.stderr || '').trim().slice(0, 200) };
  return { ok: true, path: binPath, version: (v.stdout || v.stderr || '').split('\n')[0].slice(0, 120), asset: asset.name };
}

// ---------- the probe ----------

function buildProbeConfig(nodes, names, apiPort, mixedPort, built) {
  const tagged = nodes.map((n, i) => Object.assign({}, n, { uniqueName: names[i] }));
  const provider = built || buildProvider(tagged);
  const text = provider.text;
  // The group must list exactly the proxies that were emitted. Listing every input
  // name instead would reference a name no proxy carries when buildProvider had to
  // skip an entry, and mihomo rejects the whole config with "'<name>' not found".
  const emitted = (provider.ranges || []).map((r) => String(r.name));
  const posByName = new Map(names.map((u, i) => [String(u), i]));
  const present = emitted.map((u) => (posByName.has(u) ? posByName.get(u) : -1)).filter((i) => i >= 0);
  const head = [
    'mixed-port: ' + mixedPort,
    'allow-lan: false',
    'bind-address: 127.0.0.1',
    'mode: global',
    'log-level: warning',
    'ipv6: false',
    'external-controller: 127.0.0.1:' + apiPort,
    'secret: ""',
    'profile: {store-selected: false, store-fake-ip: false}',
    'dns: {enable: false}',
  ].join('\n') + '\n';
  const group = [
    'proxy-groups:',
    '  - name: ' + PROBE_GROUP,
    '    type: url-test',
    '    url: ' + PROBE_URL,
    '    interval: 600',
    '    timeout: 5000',
    '    proxies:',
  ].concat(emitted.map((n) => '      - ' + yamlName(n))).join('\n') + '\n';
  // ranges are relative to the provider text; the head occupies its own lines first
  const lineOffset = head.split('\n').length - 1;
  const ranges = (provider.ranges || []).map((r) => ({ index: r.index, name: r.name, start: r.start + lineOffset, end: r.end + lineOffset }));
  return { text: head + text + group, ranges: ranges, present: present, emitted: emitted };
}

function startMihomo(bin, cfgPath, dir, logPath) {
  return new Promise(async (resolve) => {
    const out = await fs.open(logPath, 'w').catch(() => null);
    const child = spawn(bin, ['-f', cfgPath, '-d', dir], {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', out ? out.fd : 'ignore', out ? out.fd : 'ignore'],
      env: Object.assign({}, process.env, { NO_PROXY: '*', no_proxy: '*' }),
    });
    let exited = null;
    child.once('exit', (code, sig) => { exited = { code, sig }; });
    child.once('error', (e) => { exited = { code: null, sig: null, error: String(e.message) }; });
    resolve({ child, exited: () => exited });
    // The child owns its own descriptor now; leaving ours open makes node warn about
    // closing a FileHandle during garbage collection.
    try { if (out) await out.close(); } catch {}
  });
}

async function killChild(child, waitMs) {
  try { child.kill('SIGTERM'); } catch {}
  const t0 = Date.now();
  while (Date.now() - t0 < (waitMs || 4000)) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(100);
  }
  try { child.kill('SIGKILL'); } catch {}
}

export async function fidelityProbe(opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const nodes = o.nodes || [];
  const names = o.names || nodes.map((n, i) => 'n' + i);
  const bin = o.bin;
  const workDir = o.workDir;
  const started = Date.now();
  if (!nodes.length) return { skipped: true, reason: 'no_nodes', verified: 0, kept: [], seconds: 0 };
  if (!bin) return { skipped: true, reason: 'mihomo_unavailable', verified: 0, kept: [], seconds: 0 };

  await fs.mkdir(workDir, { recursive: true });
  const cfgPath = path.join(workDir, 'probe.yaml');
  const logPath = path.join(workDir, 'mihomo.log');

  let apiPort = await portFree(DEFAULT_API_PORT) ? DEFAULT_API_PORT : await freePort();
  let mixedPort = await freePort();
  let alive = nodes.map((n, i) => ({ node: n, name: names[i], bad: null }));

  let child = null;
  let attempt = 0;
  let apiReady = false;
  let lastErr = '';
  // Each rejection costs one immediate mihomo exit, so allow a fair number of them:
  // dropping the whole stage over a handful of malformed nodes would throw away the
  // one measurement that makes this tool worth running.
  while (attempt < 30) {
    attempt++;
    let built = buildProbeConfig(alive.map((a) => a.node), alive.map((a) => a.name), apiPort, mixedPort);
    // Entries buildProvider could not name are not in the config at all; drop them
    // from the list being measured so proxy indices and group entries stay aligned.
    if (built.present.length !== alive.length) {
      const keep = new Set(built.present);
      const before = alive.length;
      alive = alive.filter((a, i) => keep.has(i));
      log('    skipped ' + (before - alive.length) + ' unnameable entries; ' + alive.length + ' left');
      if (!alive.length) break;
      built = buildProbeConfig(alive.map((a) => a.node), alive.map((a) => a.name), apiPort, mixedPort);
    }
    const cfg = built.text;
    await fs.writeFile(cfgPath, cfg, 'utf8');
    const startedProc = await startMihomo(bin, cfgPath, workDir, logPath);
    child = startedProc.child;
    // wait for the REST API
    const deadline = Date.now() + (o.apiTimeoutMs || 20000);
    while (Date.now() < deadline) {
      const r = await httpJson(apiPort, '/version', 2000);
      if (r.status === 200) { apiReady = true; break; }
      const ex = startedProc.exited();
      if (ex) break;
      await sleep(200);
    }
    if (apiReady) break;
    const ex = startedProc.exited() || {};
    let stderrText = '';
    try { stderrText = await fs.readFile(logPath, 'utf8'); } catch {}
    lastErr = (stderrText || String(ex.error || '')).trim().slice(0, 400) || ('mihomo exited code=' + ex.code);
    await killChild(child, 2000);
    child = null;
    // mihomo names the offending proxy index; drop it and try again rather than
    // throwing away the whole stage.
    const m = /proxy (\d+)/i.exec(stderrText);
    if (m) {
      const idx = parseInt(m[1], 10);
      if (!(idx >= 0 && idx < alive.length)) break;
      alive[idx].bad = 'config_rejected';
      alive = alive.filter((a) => !a.bad);
      log('    mihomo rejected proxy #' + idx + ' (' + alive.length + ' left); retrying');
      continue;
    }
    // A YAML syntax error names a line, never a proxy. Trace the line back to the entry
    // that occupies it and drop that one, so a single malformed node cannot cost us the
    // whole measurement.
    const y = /yaml: line (\d+)/.exec(stderrText);
    if (!y) break;
    const line = parseInt(y[1], 10);
    const owner = built.ranges.find((r) => line >= r.start && line <= r.end);
    if (!owner || !(owner.index >= 0 && owner.index < alive.length)) break;
    alive[owner.index].bad = 'yaml_invalid';
    alive = alive.filter((a) => !a.bad);
    log('    mihomo rejected a malformed entry at line ' + line + ' (' + (owner.name || '?') + '); ' + alive.length + ' left; retrying');
  }

  if (!apiReady) {
    if (child) await killChild(child, 2000);
    try { await fs.unlink(cfgPath); } catch {}
    return {
      skipped: true,
      reason: 'mihomo_api_unreachable',
      detail: lastErr,
      verified: 0,
      kept: [],
      seconds: Math.round((Date.now() - started) / 100) / 10,
      api_port: apiPort,
      attempts: attempt,
    };
  }

  // per-proxy delay against generate_204
  const deadline = started + (o.deadlineMs || 240000);
  const concurrency = Math.max(1, o.concurrency || 12);
  const perReqTimeout = o.perReqTimeoutMs || 6000;
  const results = new Array(alive.length).fill(null);
  let cursor = 0;
  let done = 0;
  let timedOut = false;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= alive.length) return;
      if (Date.now() > deadline) { timedOut = true; results[i] = { delay: 0, error: 'probe_deadline' }; return; }
      const a = alive[i];
      const p = '/proxies/' + encodeURIComponent(a.name) + '/delay?url=' + encodeURIComponent(o.url || PROBE_URL) + '&timeout=' + perReqTimeout;
      const r = await httpJson(apiPort, p, perReqTimeout + 2000);
      const delay = r.json && typeof r.json.delay === 'number' ? r.json.delay : 0;
      results[i] = { delay, error: delay > 0 ? null : (r.json && r.json.message) || r.error || ('http ' + r.status) };
      done++;
      if (o.onProgress && done % 25 === 0) o.onProgress(done, alive.length);
    }
  }
  const startedWorkers = Math.min(concurrency, alive.length);
  await Promise.all(Array.from({ length: startedWorkers }, () => worker()));

  await killChild(child, 4000);
  try { await fs.unlink(cfgPath); } catch {}

  const kept = [];
  const rejected = [];
  const details = [];
  for (let i = 0; i < alive.length; i++) {
    const r = results[i] || { delay: 0, error: 'not_probed' };
    details.push({ name: alive[i].name, delay: r.delay, error: r.error });
    if (r.delay > 0) kept.push({ node: alive[i].node, delay: r.delay });
    else rejected.push({ name: alive[i].name, error: r.error });
  }
  return {
    skipped: false,
    verified: kept.length,
    kept,
    rejected,
    details,
    api_port: apiPort,
    attempts: attempt,
    timed_out: timedOut,
    partial: timedOut || results.some((r) => r && r.error === 'probe_deadline'),
    config_rejected: nodes.length - alive.length,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}