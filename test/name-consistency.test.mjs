// test/name-consistency.test.mjs
//
// Regression test for the class of failure that broke CI:
//
//   proxy group[0]: POOL: '14' not found
//
// mihomo (v1.19.33) reads a proxy's `name:` and the proxy-group membership entry
// through two different YAML nodes, so they only agree if BOTH render as a YAML
// *string* of the same value:
//
//   proxies:                                     proxy-groups:
//     - name: "014"        <- string "014"         proxies:
//                              - 014              <- int 12  -> "... '12' not found"
//
// The proxy item name is written by lib/emit.mjs emitItem()/yval() (or inside the
// verbatim yaml block), while the group entry is written by lib/emit.mjs yamlName()
// via lib/validate.mjs assemble(). Nothing ties the two renderers together, so a
// name that is a valid YAML *typed* scalar (int, octal, hex, float, sexagesimal,
// .inf, date/time) decodes to two different values and mihomo refuses the whole
// generated config.
//
// The oracle is a real mihomo binary: `mihomo -t` resolves YAML types exactly the
// way production does, so "exit 0" is proof that every name round-trips to the same
// string on both sides. Without a binary the mihomo cases SKIP (and the structural
// cases still run), so CI that ships no binary stays green.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { assemble } from '../lib/validate.mjs';
import { parseClashItems } from '../lib/parse.mjs';
import { unquote } from '../lib/yamlmini.mjs';

const execFileAsync = promisify(execFile);
const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// ---- mihomo discovery -------------------------------------------------------

function findMihomo() {
  const candidates = [];
  if (process.env.MIHOMO_BIN) candidates.push(process.env.MIHOMO_BIN);
  candidates.push(path.join(REPO, 'bin', 'mihomo.exe'));
  candidates.push(path.join(REPO, 'bin', 'mihomo'));
  for (const c of candidates) {
    try { if (c && existsSync(c)) return c; } catch { /* ignore unreadable candidate */ }
  }
  return null;
}

const MIHOMO = findMihomo();
const SKIP_NO_BIN = MIHOMO ? false : 'no mihomo binary (set MIHOMO_BIN or place bin/mihomo.exe)';
const CASE_TIMEOUT_MS = 60000;

// ---- corpus -----------------------------------------------------------------
// Every one of these is a YAML scalar that either keeps its text or resolves to a
// non-string type. The typed ones ('014' -> 12, '0x14' -> 20, '1e3' -> 1E+03,
// '2024-01-01' -> time.Time, '.5' -> 0.5, '.inf' -> +Inf, '1:30' -> 90) are the
// exact shapes that make the two renderers disagree.
const NAMES = [
  '14',
  '014',
  '0x14',
  '1e3',
  '.5',
  '+14',
  '.14',
  '.inf',
  '2024-01-01',
  'yes',
  'null',
  '~',
  '14 443',
  '-14',
  '=14',
  '1:30',
  '9999999999999999999',
  '14-2',
  'name with @ at',
  'a[1]',
  '#hash',
  'x #y',
  '%s',
];

// ---- node shapes ------------------------------------------------------------
// Each shape reaches a different name renderer in lib/emit.mjs:
//   fields-only -> emitMap()/yval()          (structured fields, no verbatim text)
//   block-lines -> emitItem() quote path     (block-style yaml kept verbatim)
//   flow-map    -> rewriteFlowName() + q()   (single-line flow map kept verbatim)
const SERVER = '198.51.100.7';
const PORT = 8388;

const SHAPES = {
  'fields-only': (name) => ({
    kind: 'yaml',
    type: 'ss',
    server: SERVER,
    port: PORT,
    fields: {
      name: name,
      type: 'ss',
      server: SERVER,
      port: PORT,
      cipher: 'aes-128-gcm',
      password: 'pw',
      udp: true,
    },
  }),
  'block-lines': (name) => ({
    kind: 'yaml',
    indent: 0,
    lines: [
      '- name: ' + JSON.stringify(name),
      '  type: ss',
      '  server: ' + SERVER,
      '  port: ' + PORT,
      '  cipher: aes-128-gcm',
      '  password: pw',
      '  udp: true',
    ],
  }),
  'flow-map': (name) => ({
    kind: 'yaml',
    flowText: '{name: ' + JSON.stringify(name) + ', type: ss, server: ' + SERVER
      + ', port: ' + PORT + ', cipher: aes-128-gcm, password: pw, udp: true}',
  }),
};

const SHAPE_KEYS = Object.keys(SHAPES);

// ---- config building / inspection -------------------------------------------

// assemble() as production uses it, plus a split of the resulting text into the
// per-proxy entry text and the proxy-group membership entries.
function buildCase(shapeKey, names) {
  const nodes = names.map((n) => SHAPES[shapeKey](n));
  const asm = assemble(nodes, names, 17991, 9013);
  const lines = asm.text.split('\n');

  const proxies = asm.ranges.map((r) => lines.slice(r.start - 1, r.end).join('\n'));

  const groupStart = lines.indexOf('proxy-groups:');
  assert.notEqual(groupStart, -1, 'assemble() produced no proxy-groups: section');
  const group = [];
  for (let i = groupStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === 'rules:') break;
    if (/^      - /.test(line)) group.push(line.slice(8));
  }
  return { asm, text: asm.text, proxies, group };
}

let tmpDir = null;
let caseSeq = 0;

async function workDir() {
  if (!tmpDir) tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mihomo-name-check-'));
  return tmpDir;
}

after(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

// Run `mihomo -t` on one generated config. Reuses a single -d directory: mihomo
// only needs somewhere to put its runtime files for a config test.
async function runMihomo(text) {
  const dir = await workDir();
  const cfg = path.join(dir, 'case-' + (++caseSeq) + '.yaml');
  await fs.writeFile(cfg, text, 'utf8');
  try {
    await execFileAsync(MIHOMO, ['-t', '-d', dir, '-f', cfg], {
      timeout: CASE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, output: '' };
  } catch (e) {
    const raw = String((e.stdout || '') + (e.stderr || '') + (e.message || ''));
    const output = raw.split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !/^configuration file .* test failed$/.test(s))
      .map((s) => s.replace(/^time="[^"]*"\s*level=\w+\s*msg=/, ''))
      .slice(-2)
      .join(' | ');
    return { ok: false, output: output || 'mihomo exited non-zero (no output)' };
  }
}

function describeFailure(shapeKey, name, one, output) {
  return [
    '  input name:   ' + JSON.stringify(name),
    '  node shape:   ' + shapeKey,
    '  proxy entry:  ' + one.proxies.join('\n                '),
    '  group entry:  - ' + one.group.join('\n               - '),
    '  mihomo says:  ' + output,
  ].join('\n');
}

// ---- structural invariants (no binary needed) -------------------------------

test('assemble() emits one non-empty group entry per proxy, and the text re-parses to the same count', () => {
  for (const shapeKey of SHAPE_KEYS) {
    for (const name of NAMES) {
      const where = shapeKey + ' name ' + JSON.stringify(name);
      const one = buildCase(shapeKey, [name]);

      assert.equal(one.asm.emitted.length, 1, 'no proxy emitted for ' + where);
      assert.equal(one.group.length, 1, 'expected exactly one group entry for ' + where);
      assert.notEqual(unquote(one.group[0]), '', 'empty group entry for ' + where);

      const reparsed = parseClashItems(one.text);
      assert.ok(reparsed.found, 're-parse found no proxies: for ' + where);
      assert.equal(reparsed.items.length, one.asm.emitted.length,
        're-parsed proxy count differs from emitted count for ' + where);
    }
  }
});

test('assemble() keeps the whole corpus 1:1 between proxies and group entries', () => {
  for (const shapeKey of SHAPE_KEYS) {
    const all = buildCase(shapeKey, NAMES);
    assert.equal(all.asm.emitted.length, NAMES.length, 'proxy count for ' + shapeKey);
    assert.equal(all.group.length, NAMES.length, 'group entry count for ' + shapeKey);
    for (const entry of all.group) {
      assert.notEqual(unquote(entry), '', 'empty group entry in ' + shapeKey + ' corpus config');
    }
    const reparsed = parseClashItems(all.text);
    assert.ok(reparsed.found);
    assert.equal(reparsed.items.length, NAMES.length, 're-parsed proxy count for ' + shapeKey);
  }
});

// ---- the mihomo oracle ------------------------------------------------------
// Fast path: the whole corpus in ONE config, so a clean build costs three
// mihomo invocations (~1s). Only when that is rejected do we re-run name by
// name, so every divergent name gets its own line in the failure report.

for (const shapeKey of SHAPE_KEYS) {
  test('mihomo -t: ' + shapeKey + ' proxy names and group entries decode to the same strings', { skip: SKIP_NO_BIN }, async (t) => {
    const batch = buildCase(shapeKey, NAMES);
    const batchRun = await runMihomo(batch.text);
    if (batchRun.ok) {
      t.diagnostic('mihomo ' + path.basename(MIHOMO) + ': ' + NAMES.length
        + ' names accepted for ' + shapeKey + ' (exit 0)');
      return;
    }

    const failures = [];
    for (const name of NAMES) {
      const one = buildCase(shapeKey, [name]);
      const run = await runMihomo(one.text);
      if (run.ok) continue;
      failures.push(describeFailure(shapeKey, name, one, run.output));
    }

    if (!failures.length) {
      assert.fail('mihomo rejected the combined ' + shapeKey + ' config but accepted every name'
        + ' on its own - likely a name collision after YAML coercion.\n'
        + '  mihomo says:  ' + batchRun.output);
    }

    assert.equal(failures.length, 0,
      'proxy name and proxy-group entry decode differently for ' + failures.length + '/' + NAMES.length
      + ' names (' + shapeKey + '):\n\n' + failures.join('\n\n')
      + '\n\nBoth sides must render the name as a YAML string (quote it on BOTH paths).');
  });
}
