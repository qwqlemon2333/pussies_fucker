// test/validate-attribution.test.mjs
//
// lib/validate.mjs removes the entries a real mihomo refuses, so the published
// provider is known-loadable. Its hard case is an error that carries no proxy index:
//
//   level=error msg="proxy group[0]: POOL: '14' not found"
//
// That is what a proxy-group membership entry naming a proxy mihomo cannot resolve
// looks like - the exact string that made CI fail with "provider load test failed,
// refusing to publish". Before the fix the loop could not attribute it to a node,
// broke out, and returned ok:false: one bad name blocked the whole publish.
//
// The runner is injectable, so these cases need no mihomo binary and no subprocess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProvider } from '../lib/emit.mjs';
import { validateProviderText } from '../lib/validate.mjs';

// Fails with the given output once, then succeeds - like dropping one bad node.
function failingOnce(output) {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      const e = new Error('Command failed: mihomo -t');
      e.stderr = output + '\n';
      e.stdout = '';
      throw e;
    }
    return { stdout: 'configuration file test is successful', stderr: '' };
  };
}

const NODES = [
  { type: 'ss', server: '192.0.2.10', port: 8388, cipher: 'aes-256-gcm', password: 'pw-one', uniqueName: '14' },
  { type: 'ss', server: '192.0.2.11', port: 8388, cipher: 'aes-256-gcm', password: 'pw-two', uniqueName: 'keepme' },
];

test('an unattributable "not found" group error drops the named entry instead of failing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-attr-'));
  try {
    const built = buildProvider(NODES);
    const res = await validateProviderText({
      text: built.text,
      bin: 'mihomo',
      workDir: dir,
      run: failingOnce('level=error msg="proxy group[0]: POOL: \'14\' not found"'),
    });
    assert.equal(res.ok, true, 'the loop must recover from a name-only error: ' + res.message);
    assert.equal(res.attempts, 2);
    assert.equal(res.dropped.length, 1);
    assert.equal(res.dropped[0].name, '14');
    assert.equal(res.dropped[0].reason, 'group_reference_missing');
    assert.match(res.text, /keepme/);
    assert.doesNotMatch(res.text, /name: "?14"?/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a proxy-index error still drops by index (the common path)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-attr-idx-'));
  try {
    const built = buildProvider(NODES);
    const res = await validateProviderText({
      text: built.text,
      bin: 'mihomo',
      workDir: dir,
      run: failingOnce('level=fatal msg="Parse config error: proxy 0: ss 192.0.2.10:8388 cipher: null initialize error: unknown method: null"'),
    });
    assert.equal(res.ok, true);
    assert.equal(res.dropped.length, 1);
    assert.equal(res.dropped[0].name, '14');
    assert.match(res.dropped[0].reason, /unknown method: null/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an error that names no entry still fails loudly instead of publishing blind', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-attr2-'));
  try {
    const built = buildProvider(NODES);
    const res = await validateProviderText({
      text: built.text,
      bin: 'mihomo',
      workDir: dir,
      run: failingOnce('level=error msg="something entirely unparseable happened"'),
    });
    assert.equal(res.ok, false);
    assert.equal(res.dropped.length, 0);
    assert.match(res.message, /unparseable/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
