// lib/validate.mjs - load-test the provider fragment with a real mihomo binary.
//
// Why this exists: pipeline stage 9 used to run "mihomo -t" on a config that only
// REFERENCED the provider ("providers: nodepool: path: ..."). mihomo loads providers
// lazily, so -t never parsed a single proxy entry and happily returned OK for a file
// that mihomo itself refuses to load directly. Two real defects shipped behind that
// blind spot: string booleans ("tls: \"true\"") and a bare-dash scalar ("path: -"),
// each of which makes the WHOLE provider unusable for every consumer.
//
// This module inlines every proxy into one config, runs -t, and removes the entries
// mihomo names as invalid (bounded), so what we publish is known-loadable.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseClashItems } from './parse.mjs';
import { emitItem, buildProvider, yamlName } from './emit.mjs';

const execFileAsync = promisify(execFile);
const TEST_URL = 'https://www.gstatic.com/generate_204';
const HEAD_LINES = 10;

function head(mixedPort, apiPort) {
  return [
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
  ];
}

// Build one config and remember which config line each proxy entry starts on, so a
// YAML syntax error ("yaml: line 9770") can be traced back to a single node.
export function assemble(nodes, names, mixedPort, apiPort) {
  const lines = head(mixedPort, apiPort);
  lines.push('proxies:');
  const ranges = [];
  const emitted = [];
  const skipped = [];
  for (let i = 0; i < nodes.length; i++) {
    const name = names && names[i] != null ? names[i] : 'n' + i;
    const item = emitItem(Object.assign({}, nodes[i], { uniqueName: name }), name);
    if (!item || !item.length) { skipped.push(nodes[i]); ranges.push(null); continue; }
    const start = lines.length + 1;
    for (const l of item) lines.push(l);
    ranges.push({ index: emitted.length, node_index: i, name: name, start: start, end: lines.length });
    emitted.push(nodes[i]);
  }
  lines.push('proxy-groups:');
  lines.push('  - name: POOL');
  lines.push('    type: url-test');
  lines.push('    url: ' + TEST_URL);
  lines.push('    interval: 600');
  lines.push('    timeout: 5000');
  lines.push('    proxies:');
  for (const r of ranges) {
    if (r) lines.push('      - ' + yamlName(r.name));
  }
  lines.push('rules:');
  lines.push('  - MATCH,POOL');
  return { text: lines.join('\n') + '\n', ranges: ranges.filter(Boolean), emitted: emitted, skipped: skipped };
}

function lineToNode(ranges, line) {
  for (const r of ranges) if (line >= r.start && line <= r.end) return r;
  return null;
}

// opts: { text, bin, workDir, mixedPort, apiPort, maxDrops, log }
export async function validateProviderText(opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const bin = o.bin;
  if (!bin) return { ok: null, reason: 'mihomo_unavailable', dropped: [], text: o.text || '' };
  const parsed = parseClashItems(String(o.text || ''));
  if (!parsed.found) return { ok: null, reason: 'no_proxies_section', dropped: [], text: o.text || '' };
  let nodes = parsed.items;
  let names = nodes.map((n, i) => String(n.fields && n.fields.name || 'n' + i));
  const workDir = o.workDir;
  const cfgPath = path.join(workDir, 'provider-test.yaml');
  const maxDrops = o.maxDrops == null ? 40 : o.maxDrops;
  const dropped = [];
  let message = '';
  for (let attempt = 0; attempt <= maxDrops; attempt++) {
    const asm = assemble(nodes, names, o.mixedPort || 17991, o.apiPort || 9013);
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(cfgPath, asm.text, 'utf8');
    try {
      await execFileAsync(bin, ['-t', '-d', workDir, '-f', cfgPath], { timeout: 180000, windowsHide: true });
      const rebuilt = buildProvider(asm.emitted.map((n, i) => Object.assign({}, n, { uniqueName: asm.ranges[i] ? asm.ranges[i].name : (n.fields && n.fields.name) || 'n' + i })));
      return {
        ok: true,
        attempts: attempt + 1,
        dropped: dropped,
        nodes: asm.emitted.length,
        text: rebuilt.text,
        emitted: rebuilt.emitted,
        message: '',
      };
    } catch (e) {
      message = String((e.stdout || '') + (e.stderr || '') + (e.message || '')).trim();
      const sem = /proxy (\d+):\s*([^\n"']+)/.exec(message);
      const yml = /yaml: line (\d+)/.exec(message);
      let target = null;
      let why = '';
      if (sem) {
        const idx = parseInt(sem[1], 10);
        target = asm.ranges[idx] || null;
        why = sem[2].trim().slice(0, 120);
      } else if (yml) {
        target = lineToNode(asm.ranges, parseInt(yml[1], 10));
        why = 'yaml_syntax';
      }
      if (!target) break;
      const dropPos = target.node_index;
      dropped.push({ index: target.index, name: target.name, reason: why });
      nodes = nodes.filter((n, i) => i !== dropPos);
      names = names.filter((n, i) => i !== dropPos);
      log('    provider test: dropped #' + target.index + ' (' + target.name + '): ' + why);
    }
  }
  try { await fs.unlink(cfgPath); } catch {}
  return { ok: false, dropped: dropped, text: o.text || '', message: message.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 600) };
}
