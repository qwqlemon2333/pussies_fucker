#!/usr/bin/env node
// verify-cn.mjs - 在大陆真实网络里判定「到底能不能用」。
//
// pipeline.mjs 的第一级验证跑在 GitHub runner（海外机房），只能证明节点还活着。
// 这个脚本是第二级：拿那份候选 provider，在本机（大陆出口）多轮多目标实测，
// 只把多数轮次都成功的节点写成 -cn 订阅。
//
//   node verify-cn.mjs                          # 用 out/nodepool.yaml，本机实测
//   node verify-cn.mjs --url <release asset>    # 直接拉 runner 发布的那份
//   node verify-cn.mjs --rounds 5 --interval 30 --throughput 10
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cnVerify, filterProvider, namesFromProvider, DEFAULT_REQUIRED, DEFAULT_PROBES } from './lib/cnverify.mjs';
import { findMihomoBinary } from './lib/probe.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function parse(argv) {
  const o = {
    input: path.join(ROOT, 'out', 'nodepool.yaml'),
    out: path.join(ROOT, 'out', 'nodepool-cn.yaml'),
    report: path.join(ROOT, 'out', 'cn-report.json'),
    rounds: 3, interval: 20000, timeout: 5000, concurrency: 8,
    minPass: null, maxRtt: 3000, throughput: 0, throughputSeconds: 15,
    throughputUrls: [],
    require: [], probe: [], url: null, bin: null, json: false,
  };
  const num = { '--rounds': 'rounds', '--interval': 'interval', '--timeout': 'timeout', '--concurrency': 'concurrency',
    '--min-pass': 'minPass', '--max-rtt': 'maxRtt', '--throughput': 'throughput', '--throughput-seconds': 'throughputSeconds' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--input') o.input = argv[++i];
    else if (a === '--url') o.url = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--report') o.report = argv[++i];
    else if (a === '--bin') o.bin = argv[++i];
    else if (a === '--throughput-url') o.throughputUrls.push(argv[++i]);
    else if (a === '--throughput-only') o.throughputOnly = true;
    else if (a === '--require') o.require.push(argv[++i]);
    else if (a === '--probe') o.probe.push(argv[++i]);
    else if (num[a]) { const v = Number(argv[++i]); if (Number.isFinite(v)) o[num[a]] = v; }
    else if (a.startsWith('-')) throw new Error('unknown flag ' + a);
  }
  return o;
}

function say(s) { process.stdout.write(s + '\n'); }

async function main() {
  let a;
  try { a = parse(process.argv.slice(2)); } catch (e) { say('error: ' + e.message); process.exit(2); }
  if (a.help) {
    say('verify-cn.mjs - 大陆视角可用性实测');
    say('');
    say('  --input <path>        候选 provider（默认 out/nodepool.yaml）');
    say('  --url <url>           改为下载一份候选 provider（curl 直连）');
    say('  --out <path>          通过者写成的新 provider（默认 out/nodepool-cn.yaml）');
    say('  --report <path>       逐节点逐轮明细（默认 out/cn-report.json）');
    say('  --rounds <n>          采样轮数（默认 3）');
    say('  --interval <ms>       轮次间隔（默认 20000）');
    say('  --timeout <ms>        单次 delay 超时（默认 5000）');
    say('  --concurrency <n>     并发（默认 8）');
    say('  --min-pass <n>        通过所需轮数（默认 ceil(rounds/2)）');
    say('  --max-rtt <ms>        单轮 RTT 上限（默认 3000）');
    say('  --require <url>       必须目标，可重复（默认 ' + DEFAULT_REQUIRED[0] + '）');
    say('  --probe <url>         参考目标，只记录，可重复');
    say('  --throughput <n>      对前 n 个通过者做真实下载测速（默认 0=不测）');
    say('  --throughput-url <u>  测速地址，可重复（默认 cloudflare；再加 github 地址才看得出能否拉 GitHub）');
    say('  --throughput-only     跳过轮次探测，把输入节点都当通过，只测速（配 --throughput）');
    say('  --bin <path>          mihomo 可执行文件');
    say('  --json                额外打印报告 JSON');
    return;
  }

  let providerText;
  if (a.url) {
    say('[1/4] fetching ' + a.url);
    try {
      providerText = execFileSync('curl', ['-sS', '-L', '--max-time', '60', a.url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) { say('error: fetch failed: ' + String((e.stderr || e.message)).trim().slice(0, 300)); process.exit(2); }
  } else {
    say('[1/4] reading ' + a.input);
    try { providerText = await fs.readFile(a.input, 'utf8'); } catch (e) { say('error: cannot read ' + a.input + ': ' + e.message); process.exit(2); }
  }
  const names = namesFromProvider(providerText);
  if (!names.length) { say('error: no proxies found in the provider'); process.exit(2); }
  say('      ' + names.length + ' candidates');

  let bin = a.bin;
  if (!bin) {
    const found = await findMihomoBinary({ root: ROOT });
    bin = found.path;
    if (bin) say('[2/4] mihomo: ' + bin + ' (' + found.source + ')');
  } else {
    say('[2/4] mihomo: ' + bin + ' (--bin)');
  }
  if (!bin) { say('error: no mihomo binary; set MIHOMO_BIN or pass --bin'); process.exit(2); }

  say('[3/4] probing ' + names.length + ' nodes x ' + a.rounds + ' rounds (interval ' + a.interval + 'ms)');
  const res = await cnVerify({
    providerText, names, bin,
    workDir: path.join(ROOT, '.verify', 'cn'),
    rounds: a.rounds, intervalMs: a.interval, timeoutMs: a.timeout, concurrency: a.concurrency,
    minPass: a.minPass, maxRtt: a.maxRtt,
    required: a.require, probes: a.probe, throughput: a.throughput,
    throughputUrls: a.throughputUrls, throughputSeconds: a.throughputSeconds,
    skipProbe: !!a.throughputOnly,
    log: (s) => say(s),
  });
  if (res.skipped) { say('error: probe skipped (' + res.reason + ') ' + (res.detail || '')); process.exit(3); }

  say('[4/4] verified ' + res.verified.length + '/' + res.tested + ' in ' + res.seconds + 's');
  const tp = new Map();
  for (const t of res.throughput || []) {
    if (!t.mbps) continue;
    const prev = tp.get(t.name);
    if (!prev || t.mbps > prev.mbps) tp.set(t.name, t);
  }
  for (const v of res.verified.slice(0, 15)) {
    const t = tp.get(v.name);
    say('  ok   ' + (v.median_rtt + 'ms').padStart(7) + '  ' + v.passes + '/' + res.rounds + '  ' + v.name + (t && t.mbps ? '   ' + t.mbps + ' MiB/s' : ''));
  }
  if (res.rejected.length) say('  dropped ' + res.rejected.length + ' (see report for per-round errors)');

  const filtered = filterProvider(providerText, res.verified.map((v) => v.name));
  await fs.mkdir(path.dirname(a.out), { recursive: true });
  await fs.writeFile(a.out, filtered.text, 'utf8');
  const report = {
    generated_at: new Date().toISOString(),
    source: a.url || a.input,
    vantage: 'mainland-china',
    rounds: res.rounds, min_pass: res.min_pass, max_rtt: res.max_rtt,
    required: res.required, probes: res.probes,
    tested: res.tested,
    verified: res.verified,
    rejected: res.rejected,
    throughput: res.throughput || [],
    seconds: res.seconds,
    rows: res.rows.map((r) => ({ name: r.name, passes: r.passes, median_rtt: r.median_rtt, rounds: r.rounds })),
  };
  await fs.writeFile(a.report, JSON.stringify(report, null, 2) + '\n', 'utf8');
  say('wrote ' + a.out + ' (' + filtered.kept + ' proxies) and ' + a.report);
  if (a.json) say(JSON.stringify(report));
  if (!res.verified.length) process.exit(4);
}

main().catch((e) => { say('FATAL ' + (e && e.stack || e)); process.exit(1); });