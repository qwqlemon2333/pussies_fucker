// lib/safety.mjs - mandatory safety filters. Every drop is counted by reason.
const V4 = [
  { name: 'rfc1918_10', test: (o) => o[0] === 10 },
  { name: 'loopback_127', test: (o) => o[0] === 127 },
  { name: 'linklocal_169254', test: (o) => o[0] === 169 && o[1] === 254 },
  { name: 'rfc1918_17216', test: (o) => o[0] === 172 && o[1] >= 16 && o[1] <= 31 },
  { name: 'rfc1918_192168', test: (o) => o[0] === 192 && o[1] === 168 },
  { name: 'cgnat_10064', test: (o) => o[0] === 100 && o[1] >= 64 && o[1] <= 127 },
  { name: 'thisnet_0', test: (o) => o[0] === 0 },
  { name: 'multicast_224', test: (o) => o[0] >= 224 && o[0] <= 239 },
  { name: 'broadcast_255', test: (o) => o[0] === 255 },
];

export function ipv4Parts(host) {
  const m = String(host).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = [1, 2, 3, 4].map((i) => parseInt(m[i], 10));
  if (p.some((x) => x > 255)) return null;
  return p;
}

export function privateReason(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return 'empty_server';
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'localhost.localdomain') return 'localhost';
  const v4 = ipv4Parts(h);
  if (v4) {
    for (const r of V4) if (r.test(v4)) return r.name;
    return null;
  }
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return 'ipv6_loopback';
  if (h === '::' ) return 'ipv6_unspecified';
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return 'ipv6_ula_fc00';
  if (/^fe[89ab][0-9a-f]:/.test(h)) return 'ipv6_linklocal';
  return null;
}

// Unauthenticated / broken stream ciphers: a MITM can tamper with the traffic.
const WEAK_SS_CIPHERS = new Set([
  'none', 'plain', 'table', 'rc4', 'rc4-md5', 'rc4-md5-6', 'rc4-ietf',
  'des-cfb', 'bf-cfb', 'chacha20', 'chacha20-ietf',
]);
// vmess 'security' values that disable encryption.
const WEAK_VMESS_CIPHERS = new Set(['none', 'zero']);

// Proxy types with no transport encryption of their own: an HTTP or SOCKS relay
// forwards plaintext, so whoever runs it can rewrite anything sent over http:// and
// learns every destination you visit. They are also usually open relays or
// honeypots, and they are what the fidelity probe tends to prefer because a bare
// CONNECT answers instantly. Encrypted types (ss/trojan/vmess/vless/hysteria2/
// tuic/anytls/socks5-tls) stay allowed.
const PLAINTEXT_TYPES = new Set(['http', 'socks5', 'socks4', 'socks4a', 'http-connect']);

export function isIpLiteral(host) {
  const h = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (ipv4Parts(h)) return true;
  if (h.includes(':')) return true;
  return false;
}

// Every field that can carry a SNI / Host value, including the inline forms.
function hostishValues(fields) {
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) out.push(v.trim()); };
  push(fields.sni);
  push(fields.servername);
  push(fields.host);
  const ws = fields['ws-opts'];
  if (ws && typeof ws === 'object') {
    if (ws.headers && typeof ws.headers === 'object') push(ws.headers.Host || ws.headers.host);
    else if (typeof ws.headers === 'string') push(flowHost(ws.headers));
  } else if (typeof ws === 'string') {
    push(flowHost(ws));
  }
  const wh = fields['ws-headers'];
  if (typeof wh === 'string') push(flowHost(wh));
  else if (wh && typeof wh === 'object') push(wh.Host || wh.host);
  return out;
}

// Pull the Host from an inline '{Host: value}' fragment left unparsed on purpose.
function flowHost(s) {
  const m = String(s).match(/[{,]\s*Host\s*:\s*([^,}]+)/i);
  return m ? m[1].trim() : '';
}

const INSECURE_KEYS = ['skip-cert-verify', 'allowInsecure', 'allow_insecure', 'insecure', 'skip_cert_verify'];

export function insecureKeysPresent(fields) {
  const hits = [];
  for (const k of INSECURE_KEYS) {
    if (fields && Object.prototype.hasOwnProperty.call(fields, k)) hits.push(k);
  }
  if (fields) {
    for (const k of Object.keys(fields)) {
      const norm = k.toLowerCase().replace(/[_-]/g, '');
      if (norm === 'skipcertverify' || norm === 'allowinsecure' || norm === 'insecure') {
        if (!hits.includes(k)) hits.push(k);
      }
    }
  }
  return hits;
}

export function insecureFromUri(uri) {
  const m = String(uri).match(/[?&](allowinsecure|allow_insecure|insecure|skip-cert-verify|skip_cert_verify|tls)=(1|true|yes)/i);
  if (m) return m[1] + '=' + m[2];
  return null;
}

// Returns { ok, reason, detail }
//
// opts.dropPort110 (--drop-port-110, OFF by default): several carriers answer a
// SYN to ANY destination port 110 within 1-2 ms, so a "live" 110 node is usually a
// middlebox in front of you rather than a proxy. That makes port-110 nodes noise on
// this box, but port 110 is also a legitimate POP3 port, so it stays opt-in.
export function safetyCheck(node, opts) {
  const o = opts || {};
  const type = String(node.type || '').toLowerCase();
  if (!type) return { ok: false, reason: 'no_type' };
  const server = String(node.server || '').trim();
  if (!server) return { ok: false, reason: 'empty_server' };
  const port = node.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'bad_port' };

  if (PLAINTEXT_TYPES.has(type) && !o.allowPlaintext) {
    return { ok: false, reason: 'plaintext_proxy', detail: type };
  }

  const f = node.fields || {};
  const hits = insecureKeysPresent(f);
  if (hits.length) return { ok: false, reason: 'insecure', detail: hits.join(',') };

  if (node.uriInsecure) return { ok: false, reason: 'insecure', detail: node.uriInsecure };

  // trojan without TLS is a plaintext password on the wire.
  if (type === 'trojan' && f.tls !== true) {
    return { ok: false, reason: 'trojan_no_tls', detail: String(f.tls) };
  }
  if (type === 'vless' && (f.tls === false || f.tls === undefined)) {
    const hasReality = !!(f['reality-opts'] && f['reality-opts']['public-key']);
    if (!hasReality) return { ok: false, reason: 'tls_disabled', detail: 'vless' };
  }
  if (type === 'vmess' && f.tls === false && String(f.network || '') === '') {
    // vmess without TLS is allowed only when it is the plain default; do not drop.
  }

  // Unauthenticated / broken ciphers.
  if (type === 'ss') {
    const cipher = String(f.cipher || '').trim().toLowerCase();
    if (WEAK_SS_CIPHERS.has(cipher)) return { ok: false, reason: 'weak_ss_cipher', detail: cipher || '(empty)' };
    if (!cipher) return { ok: false, reason: 'weak_ss_cipher', detail: '(empty)' };
  }
  if (type === 'vmess') {
    const sec = String(f.cipher || f.security || f.scy || '').trim().toLowerCase();
    if (WEAK_VMESS_CIPHERS.has(sec)) return { ok: false, reason: 'vmess_weak_cipher', detail: sec };
  }

  // A SNI/Host that is a bare IP cannot be certificate-validated, which is exactly
  // what pushes clients into disabling verification.
  for (const hv of hostishValues(f)) {
    if (isIpLiteral(hv)) return { ok: false, reason: 'sni_ip_literal', detail: hv };
  }

  // REALITY with no pinned public key cannot authenticate the server.
  if (Object.prototype.hasOwnProperty.call(f, 'reality-opts')) {
    const ro = f['reality-opts'];
    const pk = ro && typeof ro === 'object' ? ro['public-key'] : (typeof ro === 'string' ? (ro.match(/public-key\s*:\s*([^,}]+)/i) || [])[1] : null);
    if (!pk || !String(pk).trim()) return { ok: false, reason: 'reality_no_pubkey' };
  }

  if (o.dropPort110 && port === 110) return { ok: false, reason: 'port_110_middlebox', detail: server };

  const priv = privateReason(server);
  if (priv) return { ok: false, reason: 'private', detail: priv };

  return { ok: true, reason: null };
}

// First dedupe key: one node per reachable endpoint.
export function dedupeKey(node) {
  return String(node.type).toLowerCase() + '|' + String(node.server).toLowerCase() + '|' + node.port;
}

// Second dedupe key: content identity. Two entries with the same
// (type, server, port) AND the same credential are literally the same node copied
// into several lists; two entries with the same endpoint but a different credential
// are genuinely different accounts on one host and must both survive.
export function contentKey(node) {
  const f = node.fields || {};
  const cred = f.uuid != null ? 'u:' + String(f.uuid).toLowerCase()
    : f.password != null ? 'p:' + String(f.password)
      : (node.uri ? 'uri:' + String(node.uri) : 'none');
  return dedupeKey(node) + '|' + cred;
}
