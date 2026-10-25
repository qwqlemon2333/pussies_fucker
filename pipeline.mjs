// pipeline.mjs - GitHub-Actions-driven free-node aggregator.
//
//   1 discover    dynamic GitHub search + default-branch recency gate (lib/discover.mjs)
//   2 transports   raw.githubusercontent first (works from Actions), then jsdelivr, mirrors
//   3 fetch+parse  reuse lib/parse.mjs, retry the next transport on a 0-node parse
//   4 safety       reuse lib/safety.mjs unchanged (+ optional --drop-port-110)
//   5 dedupe       (type,server,port) then content identity; deterministic order
//   6 tcp          cheap connect prefilter (lib/live.mjs)
//   7 fidelity     REAL mihomo proxy test per node (lib/probe.mjs)
//   8 emit         out/nodepool.yaml + out/nodes.txt + out/nodepool.patch.yaml
//   9 verify       mihomo -t on the produced fragment when a binary is available
//
//   node pipeline.mjs                 # local / dev box
//   node pipeline.mjs --ci            # what the workflow runs
//   node pipeline.mjs --offline       # replay the cached discovery snapshot
//
// No third-party deps. Requires: node >= 18, curl.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeTransports, fetchPath, declaredChain } from './lib/transport.mjs';
import { detectShape, extractUris, parseUri, parseClashItems, b64decode, makeUri } from './lib/parse.mjs';
import { safetyCheck, dedupeKey, contentKey } from './lib/safety.mjs';
import { poolCheck } from './lib/live.mjs';
import { buildProvider } from './lib/emit.mjs';
import { writeReadme } from './lib/readme.mjs';
import { buildPatch } from './lib/patch.mjs';
import { GitHub } from './lib/github.mjs';
import { discover } from './lib/discover.mjs';
import { findMihomoBinary, downloadMihomo, fidelityProbe } from './lib/probe.mjs';
import { validateProviderText } from './lib/validate.mjs';
import { loadRegistry, saveRegistry, mergeRun, seedRepos } from './lib/registry.mjs';
import { stratifyByType } from './lib/select.mjs';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();

function log() {
  console.log(Array.prototype.slice.call(arguments).join(' '));
}

// ---------- CLI ----------
function parseArgs(argv) {
  const out = {
    ci: false, offline: false, refresh: false, dropPort110: false, allowPlaintext: false, probe: true,
    reuseLiveness: false, reuseRaw: false, registry: true, help: false,
  };
  const numFlags = {
    '--max-repos': 'maxRepos', '--max-pages': 'maxPages', '--max-files': 'maxFiles',
    '--max-live': 'maxLive', '--max-probe': 'maxProbe', '--recency-days': 'recencyDays',
    '--commit-cap': 'commitCap', '--registry-forget-after': 'registryForgetAfter',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ci') out.ci = true;
    else if (a === '--offline') out.offline = true;
    else if (a === '--refresh') out.refresh = true;
    else if (a === '--drop-port-110') out.dropPort110 = true;
    else if (a === '--allow-plaintext') out.allowPlaintext = true;
    else if (a === '--no-probe') out.probe = false;
    else if (a === '--reuse-liveness') out.reuseLiveness = true;
    else if (a === '--reuse-raw') out.reuseRaw = true;
    else if (a === '--no-registry') out.registry = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (numFlags[a]) {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(a + ' needs a positive number, got ' + JSON.stringify(v));
      out[numFlags[a]] = n;
    } else if (a.startsWith('--')) throw new Error('unknown option ' + a);
  }
  return out;
}

function num(...vals) {
  for (const v of vals) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

const ARGS = parseArgs(process.argv.slice(2));
const ENV = process.env;
const TOKEN = ENV.GITHUB_TOKEN || ENV.GH_TOKEN || null;
const CI = ARGS.ci;

const CFG = {
  root: ROOT,
  outDir: path.join(ROOT, 'out'),
  rawDir: path.join(ROOT, 'raw'),
  cacheDir: path.join(ROOT, 'cache'),
  verifyDir: path.join(ROOT, '.verify'),
  binDir: path.join(ROOT, 'bin'),
  maxRepos: num(ARGS.maxRepos, ENV.MAX_REPOS, 60),
  maxPages: num(ARGS.maxPages, ENV.MAX_PAGES, 3),
  maxFiles: num(ARGS.maxFiles, ENV.MAX_FILES, 3),
  recencyDays: num(ARGS.recencyDays, ENV.RECENCY_DAYS, 5),
  // Unauthenticated core allows 60 requests/h: commit-verify ~25 and stop.
  commitCap: num(ARGS.commitCap, ENV.COMMIT_CAP, TOKEN ? 140 : 25),
  maxLive: num(ARGS.maxLive, ENV.MAX_LIVE, 4000),
  maxProbe: num(ARGS.maxProbe, ENV.MAX_PROBE, 400),
  fetchTimeoutMs: 20000,
  probeTimeoutMs: 8000,
  liveTimeoutMs: 2000,
  liveConcurrency: 150,
  maxFileBytes: 8 * 1024 * 1024,
  probeApiTimeoutMs: 20000,
  probeDeadlineMs: num(ENV.PROBE_DEADLINE_MS, 240000),
  probeConcurrency: num(ENV.PROBE_CONCURRENCY, 12),
  probeUrl: ENV.PROBE_URL || 'https://www.gstatic.com/generate_204',
  liveCacheMs: ARGS.reuseLiveness ? Infinity : 15 * 60 * 1000,
  probeCacheMs: ARGS.reuseLiveness ? Infinity : 15 * 60 * 1000,
  reuseRaw: !!ARGS.reuseRaw,
  dropPort110: !!ARGS.dropPort110,
  allowPlaintext: !!ARGS.allowPlaintext,
  probeEnabled: !!ARGS.probe,
  offline: !!ARGS.offline,
  // 源花名册：CI 每轮结算一次，把「收录」从「今天恰好搜到谁」变成有状态的集合。
  // offline 回放时不结算（否则重放会改写花名册，破坏确定性）。
  registryEnabled: !!ARGS.registry && !ARGS.offline,
  registryForgetAfter: num(ARGS.registryForgetAfter, ENV.REGISTRY_FORGET_AFTER, 6),
  token: TOKEN,
};

const USAFE = /[\u0000-\u001f]/;

// ---------- helpers ----------
async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}

async function writeJsonAtomic(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, p);
}

async function writeTextAtomic(p, text) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, p);
}

function slugify(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 90);
}

function countBy(arr, fn) {
  const m = {};
  for (const x of arr) { const k = fn(x); m[k] = (m[k] || 0) + 1; }
  return m;
}

// One file -> {shape, nodes, uris, parsed, errs}. Shared by the first attempt and retries.
function parseAnyShape(text) {
  const errs = {};
  const shape = detectShape(text);
  const out = [];
  let uris = [];
  if (shape === 'clash-yaml') {
    const res = parseClashItems(text);
    for (const it of res.items) {
      if (!it.type) { errs.no_type = (errs.no_type || 0) + 1; continue; }
      out.push(it);
    }
  } else if (shape === 'uri-list' || shape === 'base64-list') {
    const src = shape === 'base64-list' ? (b64decode(text) || '') : text;
    uris = extractUris(src);
    for (const u of uris) {
      const res = parseUri(u);
      if (res.error) { errs[res.error] = (errs[res.error] || 0) + 1; continue; }
      res.node.uri = u;
      res.node.uriInsecure = null;
      out.push(res.node);
    }
  }
  return { shape, nodes: out, uris, parsed: out.length, errs };
}

// ---------- geodata + mihomo -t ----------
const GEODATA_FILES = ['geoip.metadb', 'Country.mmdb', 'geoip.dat'];
const GEODATA_DIRS = [
  'C:\\Program Files\\Clash Verge\\resources',
  path.join(ENV.APPDATA || '', 'io.github.clash-verge-rev.clash-verge-rev'),
  path.join(ROOT, 'out'),
  path.join(ROOT, 'mihomo'),
];

async function detectGeodata() {
  for (const dir of GEODATA_DIRS) {
    if (!dir) continue;
    for (const f of GEODATA_FILES) {
      const full = path.join(dir, f);
      if (await exists(full)) return { found: true, dir: dir, file: full };
    }
  }
  return { found: false, dir: null, file: null };
}

// Load the generated fragment with a real mihomo binary ('-t' = config test only).
async function verifyWithMihomo(bin, patchText, providerPath, geo) {
  if (!bin) return { ran: false, reason: 'no mihomo binary found' };
  const dir = path.join(CFG.verifyDir, 'config-test');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'providers'), { recursive: true });
  await fs.copyFile(providerPath, path.join(dir, 'providers', 'nodepool.yaml'));
  if (geo && geo.found) await fs.copyFile(geo.file, path.join(dir, path.basename(geo.file)));
  const body = patchText.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const base = ['mixed-port: 17890', 'allow-lan: false', 'mode: rule', 'log-level: silent', ''].join('\n');
  const cfg = path.join(dir, 'config.yaml');
  await fs.writeFile(cfg, base + body, 'utf8');
  let ok = false;
  let message = '';
  try {
    const r = await execFileAsync(bin, ['-t', '-d', dir, '-f', cfg], { timeout: 180000, windowsHide: true });
    ok = true;
    message = String(r.stdout || '').trim().split('\n').slice(-3).join(' | ');
  } catch (e) {
    message = String((e.stdout || '') + (e.stderr || '') + (e.message || ''));
    message = message.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 600);
  }
  await fs.rm(dir, { recursive: true, force: true });
  return { ran: true, binary: bin, geoip_rules: !!(geo && geo.found), ok: ok, message: message };
}

// ---------- liveness cache ----------
async function loadLiveCache() {
  const p = path.join(CFG.cacheDir, 'live.json');
  const d = await readJson(p);
  if (!d || !d.entries || typeof d.ts !== 'number') return { path: p, entries: {}, ts: 0, fresh: false };
  const age = Date.now() - d.ts;
  return { path: p, entries: d.entries, ts: d.ts, age_ms: age, fresh: age <= CFG.liveCacheMs };
}

// ---------- probe cache ----------
async function loadProbeCache() {
  const p = path.join(CFG.cacheDir, 'probe.json');
  const d = await readJson(p);
  if (!d || !d.entries || typeof d.ts !== 'number') return { path: p, entries: {}, ts: 0, fresh: false };
  const age = Date.now() - d.ts;
  return { path: p, entries: d.entries, ts: d.ts, age_ms: age, fresh: age <= CFG.probeCacheMs };
}

// ---------- main ----------
async function main() {
  const t0 = Date.now();
  await fs.mkdir(CFG.rawDir, { recursive: true });
  await fs.mkdir(CFG.outDir, { recursive: true });
  await fs.mkdir(CFG.cacheDir, { recursive: true });
  await fs.mkdir(path.join(CFG.cacheDir, 'api'), { recursive: true });
  await fs.mkdir(path.join(CFG.cacheDir, '.tmp'), { recursive: true });

  log('nodepool: mode=' + (CI ? 'ci' : 'local') + ' recency=' + CFG.recencyDays + 'd max_repos=' + CFG.maxRepos +
    ' max_pages=' + CFG.maxPages + ' max_files=' + CFG.maxFiles + ' max_live=' + CFG.maxLive +
    ' max_probe=' + CFG.maxProbe + ' token=' + (TOKEN ? 'yes' : 'no') + ' offline=' + CFG.offline +
    ' drop_port_110=' + CFG.dropPort110 + ' probe=' + CFG.probeEnabled);

  // ---- 1. discovery (dynamic search + default-branch recency gate) ----
  const github = new GitHub({
    token: TOKEN,
    cacheDir: path.join(CFG.cacheDir, 'api'),
    tmpDir: path.join(CFG.cacheDir, '.tmp'),
    offline: CFG.offline,
    refresh: ARGS.refresh,
    log: log,
  });
  await github.init();
  const registry = CFG.registryEnabled ? await loadRegistry(ROOT) : null;
  const seeds = registry ? seedRepos(registry) : [];
  if (seeds.length) log('[1/9] registry: ' + seeds.length + ' adopted source(s) will be re-verified this run');
  const snap = await discover(github, {
    seedRepos: seeds,
    recencyDays: CFG.recencyDays,
    maxRepos: CFG.maxRepos,
    maxPages: CFG.maxPages,
    maxFiles: CFG.maxFiles,
    commitCap: CFG.commitCap,
    maxFileBytes: CFG.maxFileBytes,
    cacheFile: path.join(CFG.cacheDir, 'discovery.json'),
    offline: CFG.offline,
    log: log,
  });
  const repos = snap.repos || [];
  if (!repos.length) {
    log('FATAL: discovery selected 0 repos; refusing to overwrite outputs.');
    await writeJsonAtomic(path.join(CFG.outDir, 'report.json'), {
      generated_at: new Date().toISOString(), mode: CI ? 'ci' : 'local', aborted: 'no_repos',
      errors: ['discovery selected 0 repos'], recency: { days: CFG.recencyDays, cutoff: snap.cutoff },
    });
    process.exitCode = 3;
    return;
  }

  // ---- 2. transport probe ----
  const firstRepo = repos[0];
  const firstFile = (firstRepo.files && firstRepo.files[0]) || 'README.md';
  const probeTarget = {
    owner: firstRepo.full_name.split('/')[0],
    repo: firstRepo.full_name.split('/')[1],
    branch: firstRepo.default_branch || 'HEAD',
    path: firstFile,
  };
  const probed = await probeTransports(probeTarget, CFG.rawDir, CFG.probeTimeoutMs);
  let chain = probed.chain;
  if (!chain.length) {
    chain = declaredChain();
    log('[2/9] WARNING: no transport answered the health probe; trying the full declared chain anyway');
  } else {
    log('[2/9] transport chain: ' + chain.join(' > '));
  }

  // ---- 3. fetch + parse ----
  const fileRecords = [];
  const nodes = [];
  const parseErrors = {};
  let rawFiles = 0;
  let rawBytes = 0;

  for (const repo of repos) {
    const owner = repo.full_name.split('/')[0];
    const name = repo.full_name.split('/')[1];
    const branch = repo.default_branch || 'HEAD';
    for (const p of repo.files || []) {
      const outFile = path.join(CFG.rawDir, slugify(repo.full_name) + '__' + slugify(p) + '.bin');
      const rec = {
        repo: repo.full_name, canonical: repo.full_name, branch, path: p,
        commit: repo.commit ? repo.commit.date : null,
        url: null, status: 0, bytes: 0, parsed: 0, transport: null, shape: null, attempts_tried: 0,
      };
      let best = null;
      // --reuse-raw: determinism / debugging only. Reuse the bodies already sitting in
      // raw/ so two runs see byte-identical input; upstream list repos rewrite their
      // files constantly, which would otherwise make every output differ for real
      // reasons that have nothing to do with the tool.
      if (CFG.reuseRaw && (await exists(outFile))) {
        let text = null;
        try { text = await fs.readFile(outFile, 'utf8'); } catch { text = null; }
        if (text) {
          const res = parseAnyShape(text);
          best = {
            ok: true,
            fetch: { ok: true, bytes: Buffer.byteLength(text, 'utf8'), url: 'raw-cache', status: 0, transport: 'cache', attempts: [] },
            shape: res.shape, nodes: res.nodes, parsed: res.parsed, uris: res.uris, errs: res.errs,
          };
        }
      }
      // Mirrors truncate large files while still answering 200, so a file that fetches
      // 'fine' but parses to zero nodes is retried through the next transport, and the
      // attempt that parsed the most wins.
      for (let k = 0; best === null && k < chain.length; k++) {
        const rotated = chain.slice(k).concat(chain.slice(0, k));
        const r = await fetchPath(rotated, owner, name, branch, p, outFile, CFG.fetchTimeoutMs);
        rec.attempts_tried = k + 1;
        if (!r.ok) { if (!best) best = { ok: false, fetch: r }; continue; }
        let text;
        try { text = await fs.readFile(outFile, 'utf8'); } catch { continue; }
        const res = parseAnyShape(text);
        if (!best || !best.ok || res.parsed > best.parsed) {
          best = { ok: true, fetch: r, shape: res.shape, nodes: res.nodes, parsed: res.parsed, uris: res.uris, errs: res.errs };
        }
        if (res.parsed > 0) break;
      }
      if (!best || !best.ok) {
        const r = best ? best.fetch : null;
        rec.error = r && r.attempts && r.attempts.length
          ? (r.attempts[r.attempts.length - 1].error || ('http ' + (r.status || 0)))
          : 'fetch failed';
        if (r) { rec.url = r.url; rec.status = r.status; }
        fileRecords.push(rec);
        log('  FAIL ' + repo.full_name + '/' + p + ' status=' + rec.status + ' ' + (rec.error || ''));
        continue;
      }
      rawFiles++;
      rawBytes += best.fetch.bytes;
      rec.url = best.fetch.url;
      rec.status = best.fetch.status;
      rec.bytes = best.fetch.bytes;
      rec.transport = best.fetch.transport;
      rec.shape = best.shape;
      rec.parsed = best.parsed;
      for (const kk of Object.keys(best.errs || {})) parseErrors[kk] = (parseErrors[kk] || 0) + best.errs[kk];
      for (const n of best.nodes) nodes.push(n);
      if (!best.parsed) rec.error = 'fetched but parsed 0 nodes';
      fileRecords.push(rec);
      log('  ' + (best.parsed ? 'ok  ' : 'warn') + ' ' + repo.full_name + '/' + p + ' ' + best.fetch.bytes + 'B shape=' +
        best.shape + ' parsed=' + best.parsed + ' via ' + best.fetch.transport +
        (rec.attempts_tried > 1 ? ' (after ' + rec.attempts_tried + ' attempts)' : ''));
    }
  }
  log('[3/9] parsed ' + nodes.length + ' nodes from ' + rawFiles + ' files (' + (rawBytes / 1024 / 1024).toFixed(2) + ' MiB)');

  // ---- 4. safety ----
  const dropReasons = {};
  const safe = [];
  const safetyOpts = { dropPort110: CFG.dropPort110, allowPlaintext: CFG.allowPlaintext };
  for (const n of nodes) {
    const chk = safetyCheck(n, safetyOpts);
    if (!chk.ok) {
      dropReasons[chk.reason] = (dropReasons[chk.reason] || 0) + 1;
      continue;
    }
    safe.push(n);
  }
  const insecureDropped = (dropReasons.insecure || 0) + (dropReasons.tls_disabled || 0);
  const privateDropped = (dropReasons.private || 0) + (dropReasons.localhost || 0);
  log('[4/9] after safety ' + safe.length + ' (dropped ' + (nodes.length - safe.length) + ') ' + JSON.stringify(dropReasons));

  // ---- 5. dedupe (endpoint key, then content key) + deterministic order ----
  // Sort first so "which duplicate survives" is a function of the data, not of the
  // order the files happened to be fetched in.
  safe.sort((a, b) => {
    const ka = dedupeKey(a) + '|' + contentKey(a);
    const kb = dedupeKey(b) + '|' + contentKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const seenContent = new Set();
  const seenEndpoint = new Set();
  const unique = [];
  let contentDupes = 0;
  let endpointDupes = 0;
  for (const n of safe) {
    const ck = contentKey(n);
    if (seenContent.has(ck)) { contentDupes++; continue; }
    seenContent.add(ck);
    const ek = dedupeKey(n);
    if (seenEndpoint.has(ek)) { endpointDupes++; continue; }
    seenEndpoint.add(ek);
    unique.push(n);
  }
  const dupDropped = contentDupes + endpointDupes;
  log('[5/9] unique ' + unique.length + ' (content dupes ' + contentDupes + ', endpoint dupes ' + endpointDupes + ')');

  // ---- 6. TCP prefilter (cached: a re-run on unchanged inputs must not re-measure) ----
  // A hard cap applied to the sorted list starves whole families: 'http' and 'socks5'
  // sort before 'ss'/'trojan'/'vmess', so the first N of the TCP budget were 100%
  // plaintext and the probe could then only keep plaintext nodes. Interleave by type
  // so every family is probed in proportion to what it contributed.
  const candidates = stratifyByType(unique, CFG.maxLive);
  const targets = new Map();
  for (const n of candidates) {
    const k = n.server + ':' + n.port;
    if (!targets.has(k)) targets.set(k, { server: n.server, port: n.port });
  }
  const tkeys = Array.from(targets.keys());
  const liveCache = await loadLiveCache();
  const cachedLive = liveCache.fresh ? liveCache.entries : {};
  const needProbe = tkeys.filter((k) => !cachedLive[k]);
  log('[6/9] tcp prefilter: ' + tkeys.length + ' endpoints (' + needProbe.length + ' to measure, ' +
    (tkeys.length - needProbe.length) + ' from cache' + (liveCache.fresh ? ', age ' + Math.round((liveCache.age_ms || 0) / 1000) + 's' : '') + ')');
  const measured = needProbe.length
    ? await poolCheck(needProbe.map((k) => targets.get(k)), CFG.liveConcurrency, CFG.liveTimeoutMs,
      (d, total) => log('    tcp ' + d + '/' + total))
    : [];
  const liveEntries = Object.assign({}, cachedLive);
  needProbe.forEach((k, i) => { liveEntries[k] = measured[i]; });
  if (needProbe.length) {
    await writeJsonAtomic(liveCache.path, { ts: Date.now(), ttl_ms: CFG.liveCacheMs === Infinity ? null : CFG.liveCacheMs, entries: liveEntries });
  }
  const alive = [];
  let deadDropped = 0;
  for (const n of candidates) {
    const r = liveEntries[n.server + ':' + n.port];
    if (r && r.ok) { n.rtt_ms = r.rtt_ms; alive.push(n); } else deadDropped++;
  }
  log('[6/9] tcp alive ' + alive.length + ', dead ' + deadDropped);

  // ---- names (assigned BEFORE the probe: the probe config needs them, and the
  // deterministic order here is what makes a re-run byte-identical) ----
  const emitOrder = alive.slice().sort((a, b) => {
    const ka = dedupeKey(a) + '|' + String(a.name || '');
    const kb = dedupeKey(b) + '|' + String(b.name || '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const used = new Map();
  for (const n of emitOrder) {
    let base = String(n.name || '').replace(/[^\x20-\x7E]/g, '').replace(/["'|\\]/g, '').trim();
    if (!base) base = n.server + '-' + n.port;
    base = base.replace(/\s+/g, '-');
    if (base.length > 40) base = base.slice(0, 40);
    // an opened-but-never-closed bracket looks like a truncated UUID; drop that tail
    // (the cut above can create one, and some upstream lists ship names like that too)
    if ((base.match(/\[/g) || []).length > (base.match(/\]/g) || []).length) base = base.replace(/\[[^\]]*$/, '');
    base = base.replace(/[-_.(:\s]+$/, '');
    if (!base) base = n.server + '-' + n.port;
    let uname = base;
    let i = 2;
    while (used.has(uname)) { uname = base + '-' + i; i++; }
    used.set(uname, true);
    n.uniqueName = uname;
  }

  // ---- 7. fidelity probe (real mihomo proxy test) ----
  const probeCandidates = stratifyByType(emitOrder, CFG.maxProbe);
  const report = {
    tcp_alive: alive.length,
    proxy_verified: null,
    probe_seconds: null,
  };
  let kept = probeCandidates;
  let probeInfo = { ran: false, skipped: true, reason: 'disabled' };

  if (!CFG.probeEnabled) {
    log('[7/9] fidelity probe DISABLED (--no-probe): proxy_verified=null, nodes are TCP-only');
  } else if (!probeCandidates.length) {
    log('[7/9] fidelity probe skipped: no nodes survived the TCP prefilter');
    probeInfo = { ran: false, skipped: true, reason: 'no_tcp_alive_nodes' };
  } else {
    const probeCache = await loadProbeCache();
    const cacheFresh = probeCache.fresh && probeCandidates.every((n) => Object.prototype.hasOwnProperty.call(probeCache.entries, contentKey(n)));
    if (cacheFresh) {
      const survivors = [];
      for (const n of probeCandidates) {
        const e = probeCache.entries[contentKey(n)];
        if (e && e.delay > 0) { n.probe_delay = e.delay; survivors.push(n); }
      }
      kept = survivors;
      probeInfo = { ran: true, cached: true, verified: survivors.length, tested: probeCandidates.length, seconds: 0, cached_age_s: Math.round((probeCache.age_ms || 0) / 1000) };
      log('[7/9] fidelity probe from cache: ' + survivors.length + '/' + probeCandidates.length + ' verified (cache age ' + probeInfo.cached_age_s + 's)');
    } else {
      let bin = null;
      let binInfo = await findMihomoBinary({ root: ROOT, env: ENV });
      if (binInfo.path) {
        bin = binInfo.path;
        log('[7/9] fidelity probe binary: ' + bin + ' (from ' + binInfo.source + ')');
      } else {
        log('[7/9] no mihomo binary (MIHOMO_BIN / ./bin / Clash Verge); trying the latest release download...');
        const dl = await downloadMihomo({ destDir: CFG.binDir, log: log });
        if (dl.ok) { bin = dl.path; log('    downloaded mihomo ' + dl.version + ' (' + dl.asset + ')'); }
        else log('    DOWNLOAD FAILED: ' + dl.error + ' -> fidelity stage will be SKIPPED (proxy_verified=null)');
      }
      if (!bin) {
        probeInfo = { ran: false, skipped: true, reason: 'mihomo_unavailable' };
        log('[7/9] FIDELITY PROBE SKIPPED: mihomo is not available. These nodes are TCP-fresh but NOT proxy-tested — proxy_verified=null');
      } else {
        const tProbe = Date.now();
        const r = await fidelityProbe({
          nodes: probeCandidates,
          names: probeCandidates.map((n) => n.uniqueName),
          bin: bin,
          workDir: CFG.verifyDir,
          apiTimeoutMs: CFG.probeApiTimeoutMs,
          deadlineMs: CFG.probeDeadlineMs,
          concurrency: CFG.probeConcurrency,
          url: CFG.probeUrl,
          log: log,
          onProgress: (d, total) => log('    probe ' + d + '/' + total),
        });
        const secs = Math.round((Date.now() - tProbe) / 100) / 10;
        if (r.skipped) {
          probeInfo = { ran: false, skipped: true, reason: r.reason, detail: r.detail || null, seconds: secs, api_port: r.api_port || null, attempts: r.attempts || 0 };
          log('[7/9] FIDELITY PROBE SKIPPED (' + r.reason + '): ' + (r.detail || '') + ' — proxy_verified=null, NOT pretending these nodes work');
        } else {
          kept = r.kept.map((k) => {
            k.node.probe_delay = k.delay;
            return k.node;
          });
          const entries = {};
          for (const n of probeCandidates) {
            const hit = r.details.find((d) => d.name === n.uniqueName);
            entries[contentKey(n)] = { delay: hit ? hit.delay : 0, at: new Date().toISOString() };
          }
          await writeJsonAtomic(probeCache.path, { ts: Date.now(), entries: entries });
          probeInfo = {
            ran: true, cached: false, verified: kept.length, tested: probeCandidates.length,
            seconds: secs, api_port: r.api_port, attempts: r.attempts,
            partial: !!r.partial, timed_out: !!r.timed_out, config_rejected: r.config_rejected || 0,
          };
          log('[7/9] fidelity probe: ' + kept.length + '/' + probeCandidates.length + ' verified in ' + secs + 's' +
            (r.partial ? ' (DEADLINE HIT — untested nodes were dropped)' : '') +
            (r.config_rejected ? ' (' + r.config_rejected + ' rejected by mihomo config parse)' : ''));
        }
      }
    }
  }

  const tcpAlive = alive.length;
  const proxyVerified = probeInfo.ran ? kept.length : null;
  if (!kept.length) {
    log('FATAL: 0 nodes survived; refusing to overwrite out/nodepool.yaml (that would break the published asset).');
    await writeJsonAtomic(path.join(CFG.outDir, 'report.json'), {
      generated_at: new Date().toISOString(), mode: CI ? 'ci' : 'local', aborted: 'no_nodes',
      tcp_alive: tcpAlive, proxy_verified: proxyVerified, probe: probeInfo,
      recency: { days: CFG.recencyDays, cutoff: snap.cutoff, cutoff_date: snap.cutoff_date },
    });
    process.exitCode = 4;
    return;
  }

  // ---- 8. emit ----
  kept.sort((a, b) => {
    const ka = dedupeKey(a) + '|' + String(a.uniqueName || '');
    const kb = dedupeKey(b) + '|' + String(b.uniqueName || '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const built = buildProvider(kept);
  let emitted = built.emitted;
  const unnameable = built.skipped.length;
  const providerPath = path.join(CFG.outDir, 'nodepool.yaml');
  await writeTextAtomic(providerPath, built.text);

  const uriLines = [];
  let uriSkipped = 0;
  for (const n of emitted) {
    const u = n.uri || makeUri(n);
    if (!u) { uriSkipped++; continue; }
    uriLines.push(u);
  }
  await writeTextAtomic(path.join(CFG.outDir, 'nodes.txt'), uriLines.join('\n') + '\n');

  const geo = await detectGeodata();
  const patchText = buildPatch({ geoip: geo.found });
  await writeTextAtomic(path.join(CFG.outDir, 'nodepool.patch.yaml'), patchText);

  // legacy mirror so an existing local Clash Verge setup keeps working
  await fs.mkdir(path.join(ROOT, 'mihomo', 'providers'), { recursive: true });
  await writeTextAtomic(path.join(ROOT, 'mihomo', 'providers', 'nodepool.yaml'), built.text);
  await writeTextAtomic(path.join(ROOT, 'mihomo', 'nodepool.patch.yaml'), patchText);
  await writeTextAtomic(path.join(ROOT, 'nodes.txt'), uriLines.join('\n') + '\n');

  log('[8/9] wrote out/nodepool.yaml (' + emitted.length + ' proxies), out/nodes.txt (' + uriLines.length + ' uris)');

  // ---- registry: 结算「谁还在名单里」 ----
  // 这一步是「自动删除超时不更新的源」的唯一实现点：被闸门判死的、连续多轮验不到的、
  // 以及超过上限的低产出源，都在这里离开花名册，并留一条原因。
  let registrySummary = null;
  if (CFG.registryEnabled) {
    const nodeCounts = {};
    for (const f of fileRecords) {
      if (!f.repo) continue;
      nodeCounts[f.repo] = (nodeCounts[f.repo] || 0) + (f.parsed || 0);
    }
    const merged = mergeRun(registry, snap, {
      recencyDays: CFG.recencyDays,
      maxSources: CFG.maxRepos,
      forgetAfterRuns: CFG.registryForgetAfter,
      nodeCounts: nodeCounts,
    });
    registrySummary = merged.summary;
    await saveRegistry(ROOT, merged.registry);
    log('[8/9] registry: ' + registrySummary.total + ' sources (added ' + registrySummary.added.length +
      ', removed ' + registrySummary.removed.length + ', unverified ' + registrySummary.unverified.length + ')');
    for (const r of registrySummary.removed) log('    removed ' + r.repo + ' (' + r.reason + ')');
  }

  // ---- sources.json: discovery evidence (every drop keeps its reason + commit date) ----
  const sourcesDoc = {
    generated_at: snap.generated_at,
    ci: CI,
    recency_days: snap.recency_days,
    cutoff: snap.cutoff,
    cutoff_date: snap.cutoff_date,
    authenticated: snap.authenticated,
    queries: snap.queries,
    api: snap.api,
    counts: snap.counts,
    recent_repos: snap.recent_repos || [],
    repos: snap.repos,
    dropped: snap.dropped,
    files: fileRecords,
    registry: registrySummary,
  };
  await writeJsonAtomic(path.join(CFG.outDir, 'sources.json'), sourcesDoc);

  // ---- 9. verify the emitted fragment with a real mihomo ----
  let binForVerify = null;
  const found = await findMihomoBinary({ root: ROOT, env: ENV });
  binForVerify = found.path || (await exists(path.join(CFG.binDir, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'))
    ? path.join(CFG.binDir, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo') : null);
  const verify = await verifyWithMihomo(binForVerify, patchText, providerPath, geo);
  log('[9/9] mihomo -t: ' + (verify.ran ? (verify.ok ? 'OK' : 'FAILED - ' + verify.message) : 'skipped (' + verify.reason + ')') +
    ' | geoip=' + (geo.found ? geo.file : 'none'));

  // mihomo resolves "providers:" lazily, so verifyWithMihomo proves the config loads but
  // never parses a single proxy entry. That blind spot shipped a provider nobody could
  // load (string booleans, a bare-dash scalar, invalid REALITY keys). Inline the fragment
  // and drop whatever mihomo refuses, so the published file is known-loadable.
  let providerTest = { ok: null, ran: false };
  if (binForVerify) {
    providerTest = await validateProviderText({
      text: built.text,
      bin: binForVerify,
      workDir: path.join(CFG.verifyDir, 'provider-test'),
      log: log,
    });
    providerTest.ran = true;
    if (providerTest.ok === true && providerTest.dropped.length) {
      const survivors = providerTest.emitted;
      const rebuilt = buildProvider(survivors);
      const uris = [];
      for (const n of survivors) {
        const u = n.uri || makeUri(n);
        if (u) uris.push(u);
      }
      await writeTextAtomic(providerPath, rebuilt.text);
      await writeTextAtomic(path.join(CFG.outDir, 'nodes.txt'), uris.join('\n') + '\n');
      await writeTextAtomic(path.join(ROOT, 'mihomo', 'providers', 'nodepool.yaml'), rebuilt.text);
      await writeTextAtomic(path.join(ROOT, 'nodes.txt'), uris.join('\n') + '\n');
      emitted = survivors;
      log('[9/9] provider: dropped ' + providerTest.dropped.length + ' entr' + (providerTest.dropped.length === 1 ? 'y' : 'ies') +
        ' mihomo refuses (' + providerTest.dropped.map((d) => d.name + ': ' + d.reason).join('; ') + ')');
    }
    log('[9/9] provider: ' + (providerTest.ok === true ? 'OK (' + providerTest.nodes + ' entries load)'
      : providerTest.ok === false ? 'FAILED - ' + providerTest.message : 'skipped (' + providerTest.reason + ')'));
  }

  const byType = countBy(emitted, (n) => n.type);
  const rawByType = countBy(nodes, (n) => n.type);
  const fastest = emitted.slice().sort((a, b) => (a.rtt_ms == null ? 1e9 : a.rtt_ms) - (b.rtt_ms == null ? 1e9 : b.rtt_ms)).slice(0, 5)
    .map((n) => ({ name: n.uniqueName, type: n.type, server: n.server, port: n.port, rtt_ms: n.rtt_ms == null ? null : n.rtt_ms, probe_delay_ms: n.probe_delay == null ? null : n.probe_delay }));

  const reportOut = {
    generated_at: new Date().toISOString(),
    mode: CI ? 'ci' : 'local',
    duration_s: Math.round((Date.now() - t0) / 100) / 10,
    recency: { days: CFG.recencyDays, cutoff: snap.cutoff, cutoff_date: snap.cutoff_date },
    discovery: { counts: snap.counts, queries: snap.queries, api: snap.api, offline_replay: !!snap.offline_replay },
    transports: chain,
    transport_detail: probed.hosts,
    registry: registrySummary,
    sources: fileRecords,
    tcp_alive: tcpAlive,
    proxy_verified: proxyVerified,
    probe_seconds: probeInfo.seconds == null ? null : probeInfo.seconds,
    probe: probeInfo,
    provider_test: {
      ran: !!providerTest.ran,
      ok: providerTest.ok === undefined ? null : providerTest.ok,
      dropped: providerTest.dropped || [],
      nodes: providerTest.nodes == null ? null : providerTest.nodes,
      message: providerTest.message || '',
    },
    totals: {
      raw_files: rawFiles,
      raw_bytes: rawBytes,
      raw: nodes.length,
      unique: unique.length,
      insecure_dropped: insecureDropped,
      private_dropped: privateDropped,
      dead_dropped: deadDropped,
      kept: emitted.length,
      alive_tcp: tcpAlive,
      proxy_verified: proxyVerified,
      unnameable_dropped: unnameable,
      duplicates_dropped: dupDropped,
      content_duplicates_dropped: contentDupes,
      endpoint_duplicates_dropped: endpointDupes,
      invalid_dropped: (dropReasons.bad_port || 0) + (dropReasons.empty_server || 0) + (dropReasons.no_type || 0),
      live_candidates: candidates.length,
      live_candidates_capped: unique.length > CFG.maxLive,
      uri_skipped: uriSkipped,
      repos: repos.length,
      files: fileRecords.filter((f) => !f.error).length,
    },
    geodata: geo,
    verify: verify,
    drop_reasons: dropReasons,
    parse_errors: parseErrors,
    by_type: byType,
    raw_by_type: rawByType,
    fastest: fastest,
    config: {
      recency_days: CFG.recencyDays, max_repos: CFG.maxRepos, max_pages: CFG.maxPages, max_files: CFG.maxFiles,
      commit_cap: CFG.commitCap, max_live: CFG.maxLive, max_probe: CFG.maxProbe,
      live_timeout_ms: CFG.liveTimeoutMs, live_concurrency: CFG.liveConcurrency,
      fetch_timeout_ms: CFG.fetchTimeoutMs, drop_port_110: CFG.dropPort110,
      probe_url: CFG.probeUrl, probe_concurrency: CFG.probeConcurrency,
    },
  };
  await writeJsonAtomic(path.join(CFG.outDir, 'report.json'), reportOut);
  await writeJsonAtomic(path.join(ROOT, 'report.json'), reportOut);

  await writeReadme(ROOT, reportOut);
  log('[9/9] kept ' + emitted.length + ' (tcp ' + tcpAlive + ', proxy-verified ' + String(proxyVerified) + ') types ' + JSON.stringify(byType));
  log('done in ' + reportOut.duration_s + 's');
}

main().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
