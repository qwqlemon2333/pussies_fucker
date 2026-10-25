// lib/emit.mjs - YAML / URI writers.
import { reindentItem } from './yamlmini.mjs';

const SCALAR_SAFE = /^[A-Za-z0-9._\/+=-]+$/;

function q(s) {
  const v = String(s);
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// A proxy-group membership entry is a plain scalar in a block sequence, so a name that
// starts with '[' or '#' or contains ' #' silently turns into a flow sequence: mihomo
// then reports "yaml: line N: did not find expected '-' indicator" and refuses the whole
// file. Quote unless the name is boringly safe.
export function yamlName(name) {
  const s = String(name == null ? '' : name);
  const safe = /^[A-Za-z0-9_][A-Za-z0-9._\/+=@ -]*$/;
  if (s !== '' && safe.test(s) && !/\s#/.test(s) && s === s.trim() && !/^(true|false|null|yes|no|on|off)$/i.test(s)) {
    return s;
  }
  return q(s);
}

function yval(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (typeof x === 'number' ? String(x) : q(x))).join(', ') + ']';
  const s = String(v);
  if (s !== '' && SCALAR_SAFE.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s)) return s;
  return q(s);
}

// Some upstream lists write boolean scalars as strings (`udp: "true"`, `tls: 'true'`).
// mihomo refuses that outright -- "'tls' expected type 'bool', got unconvertible type
// 'string'" -- and one such node aborts the WHOLE config parse, which took the entire
// fidelity probe down. The yaml-kind path below deliberately keeps each node's original
// text, so the scalar has to be normalized on the way out.
const BOOL_KEYS = ['skip-cert-verify', 'udp-over-tcp', 'vmess-aead', 'xudp', 'tls', 'udp', 'tfo']
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/-/g, '\\-'));

const BOOL_RE = new RegExp(
  '(^|[\\s{,])(-\\s+)?(' + BOOL_KEYS.join('|') + ')\\s*:\\s*(["\']?)(true|false|1|0|yes|no)\\4(?=[\\s,}\\]]|$)',
  'gi',
);

export function coerceBoolScalars(text) {
  return String(text).replace(BOOL_RE, (m0, pre, dash, key, quote, val) => {
    const b = /^(true|1|yes)$/i.test(val);
    return pre + (dash || '') + key + ': ' + (b ? 'true' : 'false');
  });
}

// Same coercion for the structured path (fields we parsed out of a URI).
export function coerceBoolFields(fields) {
  for (const k of BOOL_KEYS) {
    const name = k.replace(/\\-/g, '-');
    const v = fields[name];
    if (typeof v !== 'string') continue;
    if (/^(true|1|yes)$/i.test(v)) fields[name] = true;
    else if (/^(false|0|no)$/i.test(v)) fields[name] = false;
  }
  return fields;
}

// Upstream text is copied through verbatim, so a value YAML refuses to read as a plain
// scalar survives into the provider. One node carrying an unquoted "path: -" made mihomo
// reject the WHOLE file ("yaml: line 9770: block sequence entries are not allowed in this
// context"), which took the fidelity probe down and would have broken the published
// provider for every consumer too. Quote those values on the way out.
const PLAIN_BAD_START = /^[-?:,[\]{}#&*!|>'"%@\x60]/;
// true/false/yes/no/on/off are valid YAML plain scalars (and mihomo wants real bools),
// so only the null family is quoted here.
const PLAIN_BAD_WORD = /^(null|~)$/i;

export function needsQuotePlain(v) {
  const s = String(v);
  if (s === '') return true;
  if (PLAIN_BAD_START.test(s)) return true;
  if (PLAIN_BAD_WORD.test(s)) return true;
  if (/:\s/.test(s) || /\s#/.test(s) || /:$/.test(s)) return true;
  if (/[\t\r]/.test(s)) return true;
  return false;
}

// The one flow-map shape that actually bites: a bare dash used as a value.
export function sanitizeFlowText(text) {
  return String(text).replace(/([:{,]\s*)-(?=\s*[,}\]])/g, '$1"-"');
}

export function sanitizePlainScalarLine(line) {
  const m = /^(\s*(?:-\s+)?)([^\s:#][^:]*?):([ \t]+)(\S.*)$/.exec(line);
  if (!m) return line;
  const lead = m[1];
  const key = m[2];
  const gap = m[3];
  let value = m[4];
  if (value[0] === '"' || value[0] === "'") return line;
  if (value[0] === '{' || value[0] === '[') return sanitizeFlowText(line);
  let tail = '';
  const ci = value.search(/\s#/);
  if (ci >= 0) {
    tail = value.slice(ci);
    value = value.slice(0, ci);
  }
  if (!needsQuotePlain(value)) return line;
  return lead + key + ':' + gap + q(value.trim()) + tail;
}

const KEY_ORDER = ['name', 'type', 'server', 'port', 'uuid', 'password', 'cipher', 'alterId', 'udp',
  'tls', 'sni', 'servername', 'network', 'flow', 'client-fingerprint', 'ws-opts', 'grpc-opts',
  'h2-opts', 'reality-opts', 'plugin', 'plugin-opts', 'obfs', 'obfs-password', 'alpn',
  'congestion-controller', 'up', 'down'];

function orderedKeys(fields) {
  const keys = Object.keys(fields);
  const head = KEY_ORDER.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !KEY_ORDER.includes(k)).sort();
  return head.concat(rest);
}

function emitMap(fields, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  for (const k of orderedKeys(fields)) {
    const v = fields[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const inner = emitMap(v, indent + 2);
      if (!inner.length) continue;
      out.push(pad + k + ':');
      out.push.apply(out, inner);
    } else {
      out.push(pad + k + ': ' + yval(v));
    }
  }
  return out;
}

// Replace the value of 'name:' inside a single-line flow map, leaving every
// other key/value exactly as the source wrote it.
export function rewriteFlowName(text, newName) {
  const m = /(^|[\s{,])(name\s*:\s*)/.exec(text);
  if (!m) return null;
  const vStart = m.index + m[1].length + m[2].length;
  let i = vStart;
  let quote = '';
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) { quote = ''; i++; break; }
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) break;
  }
  const vEnd = quote ? text.length : i;
  return text.slice(0, vStart).replace(/\s+$/, '') + ' ' + q(newName) + text.slice(vEnd);
}

// One proxies sequence entry. yaml-kind nodes keep their original text.
export function emitItem(node, uniqueName) {
  if (node.kind === 'yaml' && node.flowText) {
    const rewritten = rewriteFlowName(node.flowText, uniqueName);
    if (rewritten) return ['  - ' + sanitizeFlowText(coerceBoolScalars(rewritten))];
    return null; // caller counts it as unnameable rather than emitting a duplicate name
  }
  if (node.kind === 'yaml' && node.lines) {
    const lines = reindentItem({ indent: node.indent, lines: node.lines })
      .map(coerceBoolScalars)
      .map(sanitizePlainScalarLine);
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*-\s*name\s*:).*$/);
      if (m) {
        lines[i] = m[1] + ' ' + q(uniqueName);
        replaced = true;
        break;
      }
    }
    if (replaced) return lines;
  }
  const fields = Object.assign({}, node.fields || {});
  const ordered = { name: uniqueName, type: node.type, server: node.server, port: node.port };
  for (const k of orderedKeys(fields)) {
    if (k === 'name' || k === 'type' || k === 'server' || k === 'port') continue;
    ordered[k] = fields[k];
  }
  coerceBoolFields(ordered);
  const body = emitMap(ordered, 4);
  const out = ['  - ' + body[0].trim()];
  for (let i = 1; i < body.length; i++) out.push(body[i]);
  return out;
}

// "ranges" carries, per emitted entry, the line span it occupies inside the produced
// text ('proxies:' is line 1). A YAML syntax error names a line and no proxy, so this is
// the only way to trace it back to the one node that has to be dropped.
export function buildProvider(nodes) {
  const lines = ['proxies:'];
  const emitted = [];
  const skipped = [];
  const ranges = [];
  for (const n of nodes) {
    const item = emitItem(n, n.uniqueName);
    if (!item || !item.length) { skipped.push(n); continue; }
    const start = lines.length + 1;
    lines.push.apply(lines, item);
    ranges.push({ index: emitted.length, name: String(n.uniqueName), start: start, end: lines.length });
    emitted.push(n);
  }
  return { text: lines.join('\n') + '\n', emitted, skipped, ranges };
}
