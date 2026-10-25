// test/adapter.test.mjs - lib/adapter.mjs must agree with the real parser.
//
// The point of the module is a prediction: "mihomo will refuse this entry". So the
// test does not compare it against a hard-coded list - it builds a one-proxy config,
// runs the pinned mihomo binary's '-t', and asserts the prediction matches what the
// binary actually did. A case that mihomo accepts must be accepted by adapterCheck
// (no false drop) and a case mihomo refuses must be dropped (no false keep).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { adapterCheck } from '../lib/adapter.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin', process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
const HAS_BIN = fs.existsSync(BIN);

const b64 = (n) => crypto.randomBytes(n).toString('base64');
const b64u = (n) => crypto.randomBytes(n).toString('base64url');

const HEAD = [
  'mixed-port: 17951',
  'allow-lan: false',
  'mode: global',
  'log-level: warning',
  'external-controller: 127.0.0.1:9011',
  'secret: ""',
  'profile: {store-selected: false, store-fake-ip: false}',
  'dns: {enable: false}',
];

// One proxy, one group that references it - the same shape the pipeline emits.
function configText(node) {
  const fields = Object.assign({}, node.fields || {});
  const name = 'probe-target';
  const flat = Object.entries(Object.assign({ name, type: node.type, server: node.server, port: node.port }, fields))
    .map(([k, v]) => k + ': ' + (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)))
    .join(', ');
  return HEAD.concat([
    'proxies:',
    '  - {' + flat + '}',
    'proxy-groups:',
    '  - name: POOL',
    '    type: url-test',
    '    url: https://www.gstatic.com/generate_204',
    '    interval: 600',
    '    timeout: 5000',
    '    proxies:',
    '      - ' + name,
    'rules:',
    '  - MATCH,POOL',
  ]).join('\n') + '\n';
}

let workDir = null;
let cfgPath = null;

async function mihomoAccepts(node) {
  await fsp.writeFile(cfgPath, configText(node), 'utf8');
  try {
    await execFileAsync(BIN, ['-t', '-d', workDir, '-f', cfgPath], { timeout: 60000, windowsHide: true });
    return { ok: true, message: '' };
  } catch (e) {
    const text = String((e.stdout || '') + (e.stderr || '') + (e.message || ''));
    return { ok: false, message: text.trim().split('\n').slice(-1)[0].slice(0, 200) };
  }
}

test.before(async () => {
  if (!HAS_BIN) return;
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'adapter-'));
  cfgPath = path.join(workDir, 'check.yaml');
});

test.after(async () => {
  if (workDir) await fsp.rm(workDir, { recursive: true, force: true });
});

const CASES = [
  { label: 'ss aes-256-gcm', expectOk: true, node: { type: 'ss', server: '1.1.1.1', port: 443, fields: { cipher: 'aes-256-gcm', password: 'p' } } },
  { label: 'ss unknown method', expectOk: false, node: { type: 'ss', server: '1.1.1.1', port: 443, fields: { cipher: 'chacha20-poly1305', password: 'p' } } },
  { label: 'ss uppercase method', expectOk: false, node: { type: 'ss', server: '1.1.1.1', port: 443, fields: { cipher: 'AES-256-GCM', password: 'p' } } },
  { label: 'ss cipher null', expectOk: false, node: { type: 'ss', server: '1.1.1.1', port: 443, fields: { cipher: 'null', password: 'p' } } },
  { label: 'ss missing password', expectOk: false, node: { type: 'ss', server: '1.1.1.1', port: 443, fields: { cipher: 'aes-256-gcm' } } },
  { label: 'ss2022 single key', expectOk: true, node: { type: 'ss', server: '1.1.1.1', port: 443, fields: { cipher: '2022-blake3-aes-256-gcm', password: b64(32) } } },
  { label: 'ss2022 server:user keys', expectOk: true, node: { type: 'ss', server: '1.1.1.1', port: 443, fields: { cipher: '2022-blake3-aes-256-gcm', password: b64(32) + ':' + b64(32) } } },
  { label: 'ss2022 short key', expectOk: false, node: { type: 'ss', server: '1.1.1.1', port: 443, fields: { cipher: '2022-blake3-aes-256-gcm', password: b64(16) } } },
  { label: 'ss2022 unpadded key', expectOk: false, node: { type: 'ss', server: '1.1.1.1', port: 443, fields: { cipher: '2022-blake3-aes-256-gcm', password: b64(32).replace(/=+$/, '') } } },
  { label: 'reality base64url key', expectOk: true, node: { type: 'vless', server: '1.1.1.1', port: 443, fields: { uuid: 'u', tls: true, servername: 'a.bing.com', 'reality-opts': { 'public-key': b64u(32), 'short-id': 'ab12' } } } },
  { label: 'reality padded key', expectOk: false, node: { type: 'vless', server: '1.1.1.1', port: 443, fields: { uuid: 'u', tls: true, servername: 'a.bing.com', 'reality-opts': { 'public-key': b64(32) } } } },
  { label: 'reality odd short-id', expectOk: false, node: { type: 'vless', server: '1.1.1.1', port: 443, fields: { uuid: 'u', tls: true, servername: 'a.bing.com', 'reality-opts': { 'public-key': b64u(32), 'short-id': 'abc' } } } },
  { label: 'gost-plugin without mode', expectOk: false, node: { type: 'ss', server: '1.1.1.1', port: 443, fields: { cipher: 'aes-256-gcm', password: 'p', plugin: 'gost-plugin', 'plugin-opts': { host: 'a.bing.com' } } } },
  { label: 'gost-plugin websocket', expectOk: true, node: { type: 'ss', server: '1.1.1.1', port: 443, fields: { cipher: 'aes-256-gcm', password: 'p', plugin: 'gost-plugin', 'plugin-opts': { mode: 'websocket', host: 'a.bing.com' } } } },
  { label: 'vmess missing alterId', expectOk: false, node: { type: 'vmess', server: '1.1.1.1', port: 443, fields: { uuid: 'u', cipher: 'auto' } } },
  { label: 'vmess alterId 0', expectOk: true, node: { type: 'vmess', server: '1.1.1.1', port: 443, fields: { uuid: 'u', alterId: 0, cipher: 'auto' } } },
  { label: 'trojan alpn as string', expectOk: false, node: { type: 'trojan', server: '1.1.1.1', port: 443, fields: { password: 'p', sni: 'a.bing.com', alpn: 'h2,http/1.1' } } },
  { label: 'trojan alpn as list', expectOk: true, node: { type: 'trojan', server: '1.1.1.1', port: 443, fields: { password: 'p', sni: 'a.bing.com', alpn: ['h2', 'http/1.1'] } } },
];

test('adapterCheck verdicts match what the mihomo parser does', { skip: !HAS_BIN && 'no mihomo binary (set MIHOMO_BIN or place bin/mihomo.exe)' }, async () => {
  const wrong = [];
  for (const c of CASES) {
    const verdict = adapterCheck(c.node);
    const real = await mihomoAccepts(c.node);
    if (verdict.ok !== real.ok) {
      wrong.push(c.label + ': adapterCheck=' + (verdict.ok ? 'accept' : 'drop(' + verdict.reason + ')') +
        ' mihomo=' + (real.ok ? 'accept' : 'reject(' + real.message + ')'));
    }
    assert.equal(verdict.ok, c.expectOk, c.label + ': adapterCheck disagreed with the documented rule');
  }
  assert.deepEqual(wrong, [], 'adapterCheck and mihomo disagreed:\n  ' + wrong.join('\n  '));
});

test('a kept node never carries a field mihomo refuses', { skip: !HAS_BIN && 'no mihomo binary' }, async () => {
  // Regression for the CI failure shape: a full list of mixed nodes, all accepted by
  // adapterCheck, must load as ONE config - mihomo stops at the first bad entry.
  const kept = CASES.filter((c) => c.expectOk).map((c) => c.node);
  const text = HEAD.concat(['proxies:']).concat(kept.map((n, i) => {
    const fields = Object.assign({}, n.fields);
    const flat = Object.entries(Object.assign({ name: 'n' + i, type: n.type, server: n.server, port: n.port }, fields))
      .map(([k, v]) => k + ': ' + JSON.stringify(v)).join(', ');
    return '  - {' + flat + '}';
  })).concat(['proxy-groups:', '  - name: POOL', '    type: url-test', '    url: https://www.gstatic.com/generate_204',
    '    interval: 600', '    timeout: 5000', '    proxies:'].concat(kept.map((n, i) => '      - n' + i))
    .concat(['rules:', '  - MATCH,POOL'])).join('\n') + '\n';
  await fsp.writeFile(cfgPath, text, 'utf8');
  const r = await execFileAsync(BIN, ['-t', '-d', workDir, '-f', cfgPath], { timeout: 60000, windowsHide: true })
    .then(() => ({ ok: true, message: '' }))
    .catch((e) => ({ ok: false, message: String((e.stdout || '') + (e.stderr || '')).trim().split('\n').slice(-1)[0] }));
  assert.equal(r.ok, true, 'the kept set did not load: ' + r.message);
});
