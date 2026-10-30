// test/cipher-policy.test.mjs
//
// The README promises: a published node never uses an unauthenticated cipher. That
// promise has to hold for the cipher names mihomo still ACCEPTS - otherwise the
// policy silently stops covering what actually ships. Two real escapes reached the
// published pool (nodepool-latest, 2026-10-26):
//
//   - ss  aes-128-cfb  password "shadowsocks"
//   - ssr rc4-md5
//
// AES-CFB/CTR are unauthenticated stream modes like RC4, and ssr was never checked
// at all. These cases pin the boundary so the list cannot quietly shrink again.
//
// Shape note: safetyCheck reads type/server/port from the node and every protocol
// field from node.fields (that is what lib/parse.mjs produces).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safetyCheck } from '../lib/safety.mjs';

const ss = (cipher) => ({ type: 'ss', server: '192.0.2.10', port: 8388, fields: { type: 'ss', cipher, password: 'x'.repeat(20), name: 't-ss' } });
const ssr = (cipher) => ({ type: 'ssr', server: '192.0.2.11', port: 8080, fields: { type: 'ssr', cipher, password: 'p'.repeat(20), protocol: 'origin', obfs: 'plain', name: 't-ssr' } });

test('ss: unauthenticated AES-CFB/CTR modes are dropped like RC4', () => {
  for (const c of ['aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb', 'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr']) {
    const r = safetyCheck(ss(c), {});
    assert.equal(r.ok, false, c + ' must be dropped');
    assert.equal(r.reason, 'weak_ss_cipher');
    assert.equal(r.detail, c);
  }
});

test('ss: AEAD ciphers (gcm / chacha20-poly1305 / 2022-blake3) still pass', () => {
  for (const c of ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305', 'aes-256-gcm-siv', '2022-blake3-aes-256-gcm']) {
    const r = safetyCheck(ss(c), {});
    assert.equal(r.ok, true, c + ' must be kept: ' + r.reason + ' ' + (r.detail || ''));
  }
});

test('ssr: the same cipher list applies (it used to be exempt)', () => {
  for (const c of ['rc4-md5', 'rc4', 'aes-256-cfb', 'aes-128-ctr', 'chacha20', 'none']) {
    const r = safetyCheck(ssr(c), {});
    assert.equal(r.ok, false, 'ssr ' + c + ' must be dropped');
    assert.equal(r.reason, 'weak_ssr_cipher');
  }
  const ok = safetyCheck(ssr('aes-256-gcm'), {});
  assert.equal(ok.ok, true, 'ssr with an AEAD cipher must be kept: ' + ok.reason);
});

test('ss/ssr without a cipher are dropped (mihomo would abort the whole config)', () => {
  const a = safetyCheck({ type: 'ss', server: '192.0.2.12', port: 8388, fields: { type: 'ss', password: 'x'.repeat(20) } }, {});
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'weak_ss_cipher');
  assert.equal(a.detail, '(empty)');
  const b = safetyCheck({ type: 'ssr', server: '192.0.2.13', port: 8080, fields: { type: 'ssr', password: 'p'.repeat(20), protocol: 'origin', obfs: 'plain' } }, {});
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'weak_ssr_cipher');
});
