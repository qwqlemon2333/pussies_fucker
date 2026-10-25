// lib/adapter.mjs - "will mihomo actually load this entry?" validation.
//
// lib/safety.mjs answers a POLICY question (is this node safe to publish?). This
// module answers a FORMAT question (will mihomo's config parser accept the fields?).
// Both matter: a node that passes every policy check but leaves mihomo unable to
// parse the file takes the whole list down, because mihomo aborts on the first
// fatal field - and a stage that is measuring "does this proxy work?" against a
// config that will not load has nothing left to measure.
//
// Every rule here is evidence-based: each was derived by feeding one-proxy configs
// to the mihomo binary this repo pins (v1.19.33) and recording which ones it
// refused (see .verify/methodprobe*.mjs). Rules that could not be proven fatal are
// deliberately absent - a speculative drop costs a working node, which is worse
// than letting the stage-9 load test catch a rare bad one.
import { parseFlowMap } from './yamlmini.mjs';

// shadowsocks methods mihomo v1.19.33 accepts. Case-sensitive: it lowercases
// nothing, so 'AES-256-GCM' is rejected as an unknown method.
export const SS_METHODS = new Set([
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm',
  'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
  'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb',
  'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr',
  'rc4-md5', 'chacha20', 'chacha20-ietf', 'xchacha20', 'none',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
  'aes-128-gcm-siv', 'aes-256-gcm-siv',
]);

// SIP022 ciphers take a base64 pre-shared key of a fixed length, not a password.
const SS2022_KEY_BYTES = {
  '2022-blake3-aes-128-gcm': 16,
  '2022-blake3-aes-256-gcm': 32,
  '2022-blake3-chacha20-poly1305': 32,
};

// Types mihomo knows. An unknown type is a fatal parse error ('unsupport proxy
// type'), so anything outside this set must be dropped rather than published.
export const KNOWN_TYPES = new Set([
  'ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic',
  'anytls', 'snell', 'http', 'socks5', 'direct', 'wireguard', 'ssh', 'mieru',
]);

// Fields mihomo requires per type: a missing one aborts the whole config with
// "has unset fields: <name>". (hysteria2/tuic accept a missing credential.)
const REQUIRED = {
  ss: ['cipher', 'password'],
  ssr: ['cipher', 'password', 'protocol', 'obfs'],
  vmess: ['uuid', 'alterId'],
  vless: ['uuid'],
  trojan: ['password'],
  anytls: ['password'],
  snell: ['psk'],
  ssh: ['username'],
  mieru: ['transport'],
  wireguard: ['private-key', 'public-key', 'ip'],
};

// A plugin whose mandatory options are missing is fatal while the config is being
// built, so the plugin name alone is not enough to accept the node.
const PLUGIN_RULES = {
  obfs: { modes: ['tls', 'http'] },
  'v2ray-plugin': { modes: ['websocket'] },
  'gost-plugin': { modes: ['websocket'] },
  'shadow-tls': { required: ['host'] },
  restls: { required: ['password', 'version-hint'] },
};

function isBlank(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' || t === '~' || /^null$/i.test(t);
  }
  return false;
}

function str(v) {
  return v === undefined || v === null ? '' : String(v);
}

// A field that must be a map. Returns the map, or null when the value is a
// string that is not an inline '{...}' map (mihomo calls that a type error).
function asMap(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('{')) {
      const m = parseFlowMap(t);
      if (m && typeof m === 'object') return m;
    }
  }
  return null;
}

function isFlowish(v) {
  return typeof v === 'string' && v.trim().startsWith('{');
}

// Decoded length of a standard-alphabet base64 string, or -1 when mihomo's
// base64.StdEncoding would refuse it. Padding is required: a 43-character padded
// key without its '=' fails with 'decode key: illegal base64 data at input byte 40'.
export function stdBase64Bytes(s) {
  const t = str(s).trim();
  if (!t || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return -1;
  if (t.length % 4 !== 0) return -1;
  const pad = (t.match(/=+$/) || [''])[0].length;
  const body = t.slice(0, t.length - pad);
  const rem = body.length % 4;
  if (rem === 1) return -1;
  if (pad !== (4 - rem) % 4) return -1;
  return Math.floor((body.length * 3) / 4);
}

// Decoded length of an unpadded base64url string. REALITY public keys use
// base64.RawURLEncoding: '+' or '/' (standard alphabet) makes mihomo report
// 'invalid REALITY public key', and so does any '=' padding.
export function urlBase64Bytes(s) {
  const t = str(s).trim();
  if (!t || !/^[A-Za-z0-9_-]+$/.test(t)) return -1;
  if (t.length % 4 === 1) return -1;
  return Math.floor((t.length * 3) / 4);
}

// A 2022-blake3 credential is either the server pre-shared key or
// 'serverkey:userkey[:...]'. Every part must be a padded standard-base64 key of
// exactly the cipher's key length; a valid two-key form is the common case, so
// validating only the whole string would drop working nodes.
export function ss2022KeyOk(password, needBytes) {
  const parts = str(password).trim().split(':');
  if (parts.length > 4) return false;
  for (const p of parts) {
    if (stdBase64Bytes(p) !== needBytes) return false;
  }
  return true;
}

function realCheck(f) {
  const ro = f['reality-opts'];
  if (ro === undefined) return null;
  const map = asMap(ro);
  if (!map) return { reason: 'adapter_field_type', detail: 'reality-opts' };
  const pk = map['public-key'] !== undefined ? map['public-key'] : map.publicKey;
  if (isBlank(pk)) return { reason: 'adapter_reality_pubkey', detail: 'missing' };
  const raw = str(pk).trim();
  if (/=/.test(raw)) return { reason: 'adapter_reality_pubkey', detail: 'padded' };
  if (urlBase64Bytes(raw) !== 32) return { reason: 'adapter_reality_pubkey', detail: 'not-32-bytes' };
  const sid = map['short-id'] !== undefined ? map['short-id'] : map.shortId;
  if (sid !== undefined && sid !== null && str(sid).trim() !== '') {
    const s = str(sid).trim();
    if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2 !== 0 || s.length > 16) {
      return { reason: 'adapter_reality_shortid', detail: s.slice(0, 24) };
    }
  }
  return null;
}

function ssCheck(f) {
  const m = str(f.cipher).trim();
  if (!m) return { reason: 'adapter_ss_method', detail: '(missing)' };
  if (!SS_METHODS.has(m)) return { reason: 'adapter_ss_method', detail: m.slice(0, 40) };
  const need = SS2022_KEY_BYTES[m];
  if (need && !ss2022KeyOk(f.password, need)) {
    return { reason: 'adapter_ss2022_key', detail: m + ' want ' + need + 'B base64 keys' };
  }
  const plugin = str(f.plugin).trim();
  if (plugin) {
    const rule = PLUGIN_RULES[plugin];
    if (rule) {
      const opts = asMap(f['plugin-opts']);
      if (!opts && !isBlank(f['plugin-opts'])) return { reason: 'adapter_plugin_opts', detail: plugin + ' opts not a map' };
      const o = opts || {};
      for (const k of rule.required || []) {
        if (isBlank(o[k])) return { reason: 'adapter_plugin_opts', detail: plugin + ' missing ' + k };
      }
      if (rule.modes) {
        const mode = str(o.mode).trim();
        if (!rule.modes.includes(mode)) return { reason: 'adapter_plugin_opts', detail: plugin + ' mode=' + (mode || '(none)') };
      }
    }
  }
  return null;
}

// Fields whose YAML shape mihomo type-checks: a bare string where a sequence or
// map is expected is fatal ('alpn' is not a slice / expected a map, got 'string').
function shapeCheck(f) {
  const alpn = f.alpn;
  if (alpn !== undefined && alpn !== null && typeof alpn === 'string') {
    const t = alpn.trim();
    if (t && !t.startsWith('[')) return { reason: 'adapter_field_type', detail: 'alpn is a string' };
  }
  for (const key of ['ws-opts', 'grpc-opts', 'h2-opts', 'plugin-opts']) {
    const v = f[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && !isFlowish(v)) return { reason: 'adapter_field_type', detail: key };
  }
  const ws = asMap(f['ws-opts']);
  if (ws && ws.headers !== undefined && typeof ws.headers === 'string' && !isFlowish(ws.headers)) {
    return { reason: 'adapter_field_type', detail: "ws-opts.headers" };
  }
  return null;
}

// Returns { ok, reason, detail }. reason is a stable drop bucket name.
export function adapterCheck(node) {
  const type = String(node && node.type ? node.type : '').toLowerCase();
  if (!type) return { ok: false, reason: 'adapter_unknown_type', detail: '(none)' };
  if (!KNOWN_TYPES.has(type)) return { ok: false, reason: 'adapter_unknown_type', detail: type };
  const f = (node && node.fields) || {};

  for (const key of REQUIRED[type] || []) {
    if (isBlank(f[key])) return { ok: false, reason: 'adapter_required_field', detail: type + ' ' + key };
  }

  if (type === 'ss') {
    const bad = ssCheck(f);
    if (bad) return { ok: false, reason: bad.reason, detail: bad.detail };
  } else if (type === 'vless' || type === 'vmess' || type === 'trojan') {
    const bad = realCheck(f);
    if (bad) return { ok: false, reason: bad.reason, detail: bad.detail };
  }

  const shape = shapeCheck(f);
  if (shape) return { ok: false, reason: shape.reason, detail: shape.detail };

  return { ok: true, reason: null };
}
