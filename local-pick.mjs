// local-pick.mjs - 本地轻量优选：把几千条的粗筛订阅压成几十条，再交给 Clash Verge。
//
// 为什么要有这个入口：把一份几千条的粗筛订阅直接导进 Clash Verge，Verge 会在
// 「测可用性」里一次性对全部节点发探测，UI 卡死、进程吃满，而绝大多数节点本来就
// 是不可用的。这里把同一件事搬到命令行，并且**分块**做：一次只让一个 headless
// mihomo 拿几十条节点，测完退出再换下一块。最终交给 Verge 的只有幸存者。
//
//   node local-pick.mjs --url https://example.com/sub            # 粗筛订阅
//   node local-pick.mjs --file sub.yaml --max 400 --chunk 40     # 本地文件
//   node local-pick.mjs --url <sub> --tcp-only                   # 只做 TCP，不下断言
//   node local-pick.mjs --url <sub> --no-tcp                     # 跳过 TCP 预筛，直接进 mihomo
//
// 产物：
//   out/local.yaml        只含幸存者的 mihomo provider 片段（给 Verge 的 proxy-provider）
//   out/local-nodes.txt   幸存者的分享链接，一行为一条（备用）
//   out/local-report.json 每一阶段的真实数字 + 每个节点每轮的结果
//
// 没有第三方依赖。需要：node >= 18、curl；做优选的阶段还需要一个 mihomo 可执行文件
// （和 pipeline.mjs 共用 bin/ 或 PATH 里的同一个）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { curl } from './lib/transport.mjs';
import { detectShape, extractUris, parseUri, parseClashItems, b64decode, makeUri } from './lib/parse.mjs';
import { safetyCheck, dedupeKey, contentKey } from './lib/safety.mjs';
import { poolCheck } from './lib/live.mjs';
import { buildProvider } from './lib/emit.mjs';
import { findMihomoBinary } from './lib/probe.mjs';
import { cnVerify, namesFromProvider } from './lib/cnverify.mjs';
import { validateProviderText } from './lib/validate.mjs';
import { stratifyByType } from './lib/select.mjs';

const ROOT = process.cwd();

function log() {
  console.log(Array.prototype.slice.call(arguments).join(' '));
}

// ---------- CLI ----------
function parseArgs(argv) {
  const out = {
    urls: [], files: [], max: 300, chunk: 40, rounds: 2, interval: 8000, timeout: 5000,
    concurrency: 4, minPass: 1, maxRtt: 3000, tcp: true, verify: true, throughput: 0,
    out: path.join('out', 'local.yaml'), report: path.join('out', 'local-report.json'),
    bin: null, require: [], help: false,
  };
  const nums = {
    '--max': 'max', '--chunk': 'chunk', '--rounds': 'rounds', '--interval': 'interval',
    '--timeout': 'timeout', '--concurrency': 'concurrency', '--min-pass': 'minPass',
    '--max-rtt': 'maxRtt', '--throughput': 'throughput',
  };
  const strs = { '--out': 'out', '--report': 'report', '--bin': 'bin' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') { const v = argv[++i]; if (!v) throw new Error('--url needs a value'); out.urls.push(v); }
    else if (a === '--file') { const v = argv[++i]; if (!v) throw new Error('--file needs a value'); out.files.push(v); }
    else if (a === '--require') { const v = argv[++i]; if (!v) throw new Error('--require needs a value'); out.require.push(v); }
    else if (a === '--tcp-only') out.verify = false;
    else if (a === '--no-tcp') out.tcp = false;
    else if (a === '--no-verify') out.verify = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (nums[a]) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) throw new Error(a + ' needs a number >= 0');
      out[nums[a]] = n;
    } else if (strs[a]) {
      const v = argv[++i];
      if (!v) throw new Error(a + ' needs a value');
      out[strs[a]] = v;
    } else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else out.files.push(a);
  }
  return out;
}

function usage() {
  log('local-pick.mjs - 本地轻量优选（分块 headless mihomo，不把粗筛订阅塞进 Clash Verge）');
  log('');
  log('  --url <sub>          订阅地址，可重复');
  log('  --file <path>        本地文件（yaml / base64 / 链接列表），可重复');
  log('  --max <n>            去重后进入优选的名额上限，默认 300');
  log('  --chunk <n>          每块送给一个 mihomo 的节点数，默认 40');
  log('  --rounds <n>         每块的探测轮数，默认 2（1 轮只够排除完全死的）');
  log('  --interval <ms>      轮间隔，默认 8000');
  log('  --timeout <ms>       单次延迟探测超时，默认 5000');
  log('  --concurrency <n>    单块内并发探测数，默认 4');
  log('  --min-pass <n>       至少通过几轮才算幸存，默认 1');
  log('  --max-rtt <ms>       首目标的最差延迟上限，默认 3000');
  log('  --require <url>      必须打通的目标，可重复；默认 gstatic/generate_204');
  log('  --throughput <n>     只给前 n 个幸存者测速（默认 0，不测）');
  log('  --tcp-only           只做 TCP 预筛并输出，不进 mihomo（最快，但不验证能否翻出去）');
  log('  --no-tcp             跳过 TCP 预筛');
  log('  --out <path>         provider 输出，默认 out/local.yaml');
  log('  --report <path>      报告输出，默认 out/local-report.json');
  log('  --bin <path>         mihomo 可执行文件路径');
}

// ---------- helpers ----------
async function writeTextAtomic(p, text) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, p);
}

async function writeJsonAtomic(p, obj) {
  await writeTextAtomic(p, JSON.stringify(obj, null, 2) + '\n');
}

function slug(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'x';
}

// 给节点分配唯一名（emit 与 mihomo 都按名字认节点）。排序后再分配，保证同一份输入
// 两次跑出来的名字完全一致；不排序就会跟着抓取顺序漂移，最后连 provider 都做不到可复现。
function assignUniqueNames(list) {
  const ordered = list.slice().sort((a, b) => {
    const ka = dedupeKey(a) + '|' + String(a.name || '');
    const kb = dedupeKey(b) + '|' + String(b.name || '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const used = new Map();
  for (const n of ordered) {
    let base = String(n.name || '').replace(/[^\x20-\x7E]/g, '').replace(/["'|\\]/g, '').trim();
    if (!base) base = n.server + '-' + n.port;
    base = base.replace(/\s+/g, '-');
    if (base.length > 40) base = base.slice(0, 40);
    if ((base.match(/\[/g) || []).length > (base.match(/\]/g) || []).length) base = base.replace(/\[[^\]]*$/, '');
    base = base.replace(/[-_.(:\s]+$/, '');
    if (!base) base = n.server + '-' + n.port;
    let uname = base;
    let i = 2;
    while (used.has(uname)) { uname = base + '-' + i; i++; }
    used.set(uname, true);
    n.uniqueName = uname;
  }
  return ordered;
}

// 一个响应体 -> {shape, nodes, parsed}. 和 pipeline.mjs 里的同名逻辑保持一致。
function parseAnyShape(text) {
  const shape = detectShape(text);
  const out = [];
  const errs = {};
  if (shape === 'clash-yaml') {
    const res = parseClashItems(text);
    for (const it of res.items) {
      if (!it.type) { errs.no_type = (errs.no_type || 0) + 1; continue; }
      out.push(it);
    }
  } else if (shape === 'uri-list' || shape === 'base64-list') {
    const src = shape === 'base64-list' ? (b64decode(text) || '') : text;
    for (const u of extractUris(src)) {
      const res = parseUri(u);
      if (res.error) { errs[res.error] = (errs[res.error] || 0) + 1; continue; }
      res.node.uri = u;
      res.node.uriInsecure = null;
      out.push(res.node);
    }
  }
  return { shape, nodes: out, parsed: out.length, errs };
}

// 拉一个订阅。先直连（--noproxy *），失败再走环境里的代理 —— 大陆机器上通常是
// 「直连 GitHub 不通、本地 mihomo 能通」，而订阅地址正好在两边都有可能。
async function readSource(spec, tmpDir) {
  if (!/^https?:\/\//i.test(spec)) {
    const text = await fs.readFile(spec, 'utf8');
    return { spec, kind: 'file', status: 200, bytes: Buffer.byteLength(text, 'utf8'), error: null, text };
  }
  const dest = path.join(tmpDir, 'src-' + slug(spec) + '-' + Date.now() + '.bin');
  let r = await curl(spec, ['--noproxy', '*'], dest, 30000);
  let via = 'direct';
  if (r.status !== 200 || !r.bytes) {
    const r2 = await curl(spec, [], dest, 30000);
    if ((r2.status === 200 && r2.bytes) || !r.bytes) { r = r2; via = 'env-proxy'; }
  }
  let text = '';
  try { text = await fs.readFile(dest, 'utf8'); } catch { text = ''; }
  try { await fs.unlink(dest); } catch {}
  return { spec, kind: 'url', via, status: r.status, bytes: r.bytes, error: r.error, text };
}

// ---------- main ----------
async function main() {
  const t0 = Date.now();
  const ARGS = parseArgs(process.argv.slice(2));
  if (ARGS.help) { usage(); return; }
  const sources = ARGS.urls.concat(ARGS.files);
  if (!sources.length) { usage(); process.exitCode = 2; return; }

  const outPath = path.isAbsolute(ARGS.out) ? ARGS.out : path.join(ROOT, ARGS.out);
  const reportPath = path.isAbsolute(ARGS.report) ? ARGS.report : path.join(ROOT, ARGS.report);
  const tmpDir = path.join(ROOT, '.verify', 'local-src');
  await fs.mkdir(tmpDir, { recursive: true });

  log('local-pick: ' + sources.length + ' source(s), max=' + ARGS.max + ' chunk=' + ARGS.chunk +
    ' rounds=' + ARGS.rounds + ' tcp=' + (ARGS.tcp ? 'yes' : 'no') + ' verify=' + (ARGS.verify ? 'yes' : 'no'));

  // ---- 1. read ----
  const srcRecords = [];
  const nodes = [];
  for (const spec of sources) {
    let s;
    try { s = await readSource(spec, tmpDir); } catch (e) {
      srcRecords.push({ spec, error: String((e && e.message) || e) });
      log('  FAIL ' + spec + ' ' + String((e && e.message) || e));
      continue;
    }
    const res = parseAnyShape(s.text || '');
    for (const n of res.nodes) nodes.push(n);
    srcRecords.push({
      spec, kind: s.kind, via: s.via || null, status: s.status || null, bytes: s.bytes || 0,
      shape: res.shape, parsed: res.parsed, error: s.error || null, parse_errors: res.errs,
    });
    log('  ' + (res.parsed ? 'ok  ' : 'warn') + spec + ' ' + (s.bytes || 0) + 'B shape=' + res.shape +
      ' parsed=' + res.parsed + (s.error ? ' (' + s.error + ')' : ''));
  }
  log('[1/5] parsed ' + nodes.length + ' nodes from ' + srcRecords.filter((r) => r.parsed).length + ' source(s)');
  if (!nodes.length) {
    await writeJsonAtomic(reportPath, { generated_at: new Date().toISOString(), aborted: 'no_nodes', sources: srcRecords });
    log('FATAL: 输入里没有解析出任何节点（形状不支持，或拉取失败）。');
    process.exitCode = 3;
    return;
  }

  // ---- 2. safety（默认丢明文代理、丢关校验的、丢内网地址） ----
  const dropReasons = {};
  const safe = [];
  for (const n of nodes) {
    const chk = safetyCheck(n, { allowPlaintext: false, dropPort110: true });
    if (!chk.ok) { dropReasons[chk.reason] = (dropReasons[chk.reason] || 0) + 1; continue; }
    safe.push(n);
  }
  log('[2/5] safety ' + safe.length + ' (dropped ' + (nodes.length - safe.length) + ') ' + JSON.stringify(dropReasons));

  // ---- 3. dedupe + 名额分配 ----
  safe.sort((a, b) => {
    const ka = contentKey(a) + '|' + dedupeKey(a);
    const kb = contentKey(b) + '|' + dedupeKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const seen = new Set();
  const unique = [];
  for (const n of safe) {
    const k = dedupeKey(n);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(n);
  }
  const candidates = stratifyByType(unique, ARGS.max);
  log('[3/5] unique ' + unique.length + ' -> candidates ' + candidates.length +
    (unique.length > candidates.length ? ' (按类型轮转截断到 --max)' : ''));

  // ---- 4. TCP 预筛 ----
  let alive = [];
  let tcpInfo = { ran: false };
  if (ARGS.tcp) {
    const order = [];
    const targets = new Map();
    for (const n of candidates) {
      const k = n.server + ':' + n.port;
      if (!targets.has(k)) { targets.set(k, { server: n.server, port: n.port }); order.push(k); }
    }
    const t1 = Date.now();
    log('[4/5] tcp: ' + order.length + ' endpoint(s), concurrency 200');
    const results = await poolCheck(order.map((k) => targets.get(k)), 200, 2500,
      (d, total) => { if (d % 200 === 0) log('    tcp ' + d + '/' + total); });
    const okSet = new Set();
    order.forEach((k, i) => { if (results[i] && results[i].ok) okSet.add(k); });
    alive = candidates.filter((n) => okSet.has(n.server + ':' + n.port));
    tcpInfo = { ran: true, endpoints: order.length, alive: alive.length, seconds: Math.round((Date.now() - t1) / 100) / 10 };
    log('[4/5] tcp alive ' + alive.length + '/' + order.length + ' in ' + tcpInfo.seconds + 's');
  } else {
    alive = candidates;
    log('[4/5] tcp skipped');
  }

  // 名字必须在进 mihomo 之前定下来：probe 配置靠名字引用节点，输出也靠名字去重。
  alive = assignUniqueNames(alive);

  // ---- 5. 分块优选 ----
  let survivors = alive;
  let verifyInfo = { ran: false };
  const rowsAll = [];
  if (ARGS.verify && alive.length) {
    const found = ARGS.bin ? { path: ARGS.bin } : await findMihomoBinary({ root: ROOT, env: process.env });
    const bin = found && found.path ? found.path : null;
    if (!bin) {
      log('FATAL: 找不到 mihomo，无法做优选。放一个 mihomo/verge-mihomo 到 bin/ 或 PATH，' +
        '或用 --bin 指定；只想先看 TCP 结果就加 --tcp-only。');
      process.exitCode = 2;
      return;
    }
    const chunks = [];
    for (let i = 0; i < alive.length; i += ARGS.chunk) chunks.push(alive.slice(i, i + ARGS.chunk));
    log('[5/5] verify: ' + alive.length + ' node(s) in ' + chunks.length + ' chunk(s) of <= ' + ARGS.chunk +
      ', rounds=' + ARGS.rounds + ', mihomo=' + bin);

    const t1 = Date.now();
    const keptNodes = [];
    let done = 0;
    let skipped = null;
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const built = buildProvider(chunk);
      // cnVerify inlines every entry into one mihomo config, so a single entry mihomo
      // refuses would abort the whole chunk. Drop those first (0-3 per thousand, usually).
      let chunkNodes = built.emitted;
      let chunkText = built.text;
      const vt = await validateProviderText({
        text: chunkText,
        bin: bin,
        workDir: path.join(ROOT, '.verify', 'local-validate-' + (ci + 1)),
        log: (m) => log('    [chunk ' + (ci + 1) + '/' + chunks.length + ']' + m),
      });
      if (vt.ok === true) {
        chunkNodes = vt.emitted;
        chunkText = vt.text;
        if (vt.dropped.length) {
          log('    chunk ' + (ci + 1) + ': dropped ' + vt.dropped.length + ' unloadable entr' +
            (vt.dropped.length === 1 ? 'y' : 'ies') + ' (' + vt.dropped.map((d) => d.name + ': ' + d.reason).join('; ') + ')');
        }
      } else if (vt.ok === false) {
        log('    chunk ' + (ci + 1) + ': mihomo refuses the config (' + vt.message + '); verifying anyway');
      }
      const names = namesFromProvider(chunkText);
      const byName = new Map();
      for (const n of chunkNodes) byName.set(n.uniqueName, n);
      const res = await cnVerify({
        providerText: chunkText,
        names,
        bin,
        workDir: path.join(ROOT, '.verify', 'local-chunk-' + (ci + 1)),
        rounds: ARGS.rounds,
        intervalMs: ARGS.interval,
        timeoutMs: ARGS.timeout,
        concurrency: ARGS.concurrency,
        minPass: ARGS.minPass,
        maxRtt: ARGS.maxRtt,
        required: ARGS.require.length ? ARGS.require : undefined,
        throughput: ARGS.throughput,
        log: (m) => log('    [chunk ' + (ci + 1) + '/' + chunks.length + ']' + m),
      });
      if (res.skipped) {
        skipped = res;
        log('    chunk ' + (ci + 1) + ' skipped: ' + res.reason + (res.detail ? ' ' + String(res.detail).slice(0, 200) : ''));
        break;
      }
      for (const v of res.verified) {
        const n = byName.get(v.name);
        if (!n) continue;
        n.median_rtt = v.median_rtt;
        n.passes = v.passes;
        keptNodes.push(n);
      }
      for (const r of res.rows || []) rowsAll.push({ chunk: ci + 1, name: r.name, passes: r.passes, median_rtt: r.median_rtt, ok: r.ok });
      done += chunk.length;
      log('    chunk ' + (ci + 1) + '/' + chunks.length + ': ' + res.verified.length + '/' + chunk.length +
        ' ok, cumulative ' + keptNodes.length + '/' + done + ', ' + res.seconds + 's');
    }
    survivors = keptNodes;
    verifyInfo = {
      ran: true, rounds: ARGS.rounds, min_pass: ARGS.minPass, max_rtt: ARGS.maxRtt,
      chunks: chunks.length, chunk_size: ARGS.chunk, tested: done,
      verified: keptNodes.length, skipped: skipped ? skipped.reason : null,
      seconds: Math.round((Date.now() - t1) / 100) / 10,
    };
    log('[5/5] verified ' + keptNodes.length + '/' + done + ' in ' + verifyInfo.seconds + 's');
  } else if (ARGS.verify) {
    log('[5/5] verify skipped (nothing alive)');
  } else {
    log('[5/5] verify disabled (--tcp-only)');
  }

  // ---- 输出 ----
  if (!survivors.length) {
    await writeJsonAtomic(reportPath, {
      generated_at: new Date().toISOString(), aborted: 'no_survivors',
      sources: srcRecords, drop_reasons: dropReasons, tcp: tcpInfo, verify: verifyInfo,
    });
    log('FATAL: 0 个幸存者；不覆盖 ' + ARGS.out + '（那会把上一份还能用的列表弄坏）。');
    process.exitCode = 4;
    return;
  }

  survivors.sort((a, b) => {
    const ra = a.median_rtt == null ? 1e9 : a.median_rtt;
    const rb = b.median_rtt == null ? 1e9 : b.median_rtt;
    if (ra !== rb) return ra - rb;
    const ka = dedupeKey(a), kb = dedupeKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const builtOut = buildProvider(survivors);
  await writeTextAtomic(outPath, builtOut.text);
  const uris = [];
  for (const n of builtOut.emitted) {
    const u = n.uri || makeUri(n);
    if (u) uris.push(u);
  }
  await writeTextAtomic(path.join(path.dirname(outPath), 'local-nodes.txt'), uris.join('\n') + '\n');

  const byType = {};
  for (const n of builtOut.emitted) byType[n.type] = (byType[n.type] || 0) + 1;
  const report = {
    generated_at: new Date().toISOString(),
    duration_s: Math.round((Date.now() - t0) / 100) / 10,
    args: {
      max: ARGS.max, chunk: ARGS.chunk, rounds: ARGS.rounds, timeout: ARGS.timeout,
      concurrency: ARGS.concurrency, tcp: ARGS.tcp, verify: ARGS.verify,
    },
    sources: srcRecords,
    stages: {
      parsed: nodes.length,
      after_safety: safe.length,
      drop_reasons: dropReasons,
      unique: unique.length,
      candidates: candidates.length,
      tcp: tcpInfo,
      verify: verifyInfo,
      survivors: builtOut.emitted.length,
    },
    by_type: byType,
    rows: rowsAll,
    outputs: { provider: outPath, uris: path.join(path.dirname(outPath), 'local-nodes.txt') },
  };
  await writeJsonAtomic(reportPath, report);

  log('');
  log('local-pick: ' + builtOut.emitted.length + ' node(s) -> ' + path.relative(ROOT, outPath) +
    ' types ' + JSON.stringify(byType) + ' in ' + report.duration_s + 's');
  log('把 ' + path.relative(ROOT, outPath) + ' 作为 proxy-provider 导入 Clash Verge（不是把原始订阅导进去）。');
}

main().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
