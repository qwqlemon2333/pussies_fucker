// lib/parse.mjs - turn raw subscription bytes into normalised node objects.
import { extractProxiesItems, parseItemFields, unquote, flowTextOf } from './yamlmini.mjs';

const URI_SCHEMES = ['vmess', 'vless', 'ss', 'trojan', 'hysteria2', 'hy2', 'tuic'];

export function b64decode(s) {
  let t = String(s).replace(/\s+/g, '');
  t = t.replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4;
  if (pad === 1) return null;
  if (pad) t += '='.repeat(4 - pad);
  try {
    const buf = Buffer.from(t, 'base64');
    if (!buf.length) return null;
    const str = buf.toString('utf8');
    if (str.indexOf('\uFFFD') !== -1) return null;
    return str;
  } catch { return null; }
}

export function b64encode(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

function asciiSafe(name) {
  const s = String(name || '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["'|\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function splitHostPort(hp) {
  let host = hp.trim();
  let port = null;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return null;
    const h = host.slice(1, end);
    const rest = host.slice(end + 1);
    if (!rest.startsWith(':')) return null;
    host = h;
    port = parseInt(rest.slice(1), 10);
  } else {
    const idx = host.lastIndexOf(':');
    if (idx === -1) return null;
    port = parseInt(host.slice(idx + 1), 10);
    host = host.slice(0, idx);
  }
  if (!host) return null;
  return { host: host, port: isNaN(port) ? null : port };
}

function qs(u) {
  const out = {};
  const qi = u.indexOf('?');
  if (qi === -1) return { base: u, q: out, hash: '' };
  const hashIdx = u.indexOf('#', qi);
  const raw = hashIdx === -1 ? u.slice(qi + 1) : u.slice(qi + 1, hashIdx);
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq === -1 ? part : part.slice(0, eq);
    const v = eq === -1 ? '' : part.slice(eq + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  const hash = hashIdx === -1 ? '' : u.slice(hashIdx + 1);
  return { base: u.slice(0, qi), q: out, hash: hash };
}

function frag(u) {
  const i = u.indexOf('#');
  if (i === -1) return { rest: u, tag: '' };
  let tag = u.slice(i + 1);
  try { tag = decodeURIComponent(tag); } catch {}
  return { rest: u.slice(0, i), tag: tag };
}

// ---------- individual schemes ----------

function parseVmess(uri) {
  const payload = uri.slice('vmess://'.length).split('#')[0];
  const json = b64decode(payload);
  if (!json) return { error: 'vmess_b64' };
  let o;
  try { o = JSON.parse(json); } catch { return { error: 'vmess_json' }; }
  const server = String(o.add || '').trim();
  const port = parseInt(o.port, 10);
  const uuid = String(o.id || '').trim();
  if (!server || !port || !uuid) return { error: 'vmess_missing' };
  const net = String(o.net || 'tcp').toLowerCase();
  const tlsOn = String(o.tls || '').toLowerCase() === 'tls';
  const host = String(o.host || '').trim();
  const p = String(o.path || '').trim();
  const sni = String(o.sni || '').trim() || host;
  const fields = {
    uuid: uuid,
    alterId: parseInt(o.aid, 10) || 0,
    cipher: String(o.scy || 'auto') || 'auto',
    udp: true,
  };
  if (tlsOn) { fields.tls = true; if (sni) fields.servername = sni; }
  if (net === 'ws') {
    fields.network = 'ws';
    const ws = { path: p || '/' };
    if (host) ws['headers'] = { Host: host };
    fields['ws-opts'] = ws;
  } else if (net === 'grpc') {
    fields.network = 'grpc';
    fields['grpc-opts'] = { 'grpc-service-name': p || String(o.path || '') };
  } else if (net === 'h2' || net === 'http') {
    fields.network = 'h2';
    const h2 = { path: p || '/' };
    if (host) h2.host = [host];
    fields['h2-opts'] = h2;
  } else {
    fields.network = 'tcp';
  }
  const name = asciiSafe(o.ps) || server;
  return { node: { type: 'vmess', server, port, name, fields } };
}

function parseSs(uri) {
  const f = frag(uri.slice('ss://'.length));
  let body = f.rest;
  let plugin = '';
  const qi = body.indexOf('?');
  if (qi !== -1) {
    const q = body.slice(qi + 1);
    body = body.slice(0, qi);
    for (const part of q.split('&')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq) === 'plugin') { try { plugin = decodeURIComponent(part.slice(eq + 1)); } catch { plugin = part.slice(eq + 1); } }
    }
  }
  let method = '';
  let password = '';
  let hp = '';
  const at = body.lastIndexOf('@');
  if (at !== -1) {
    const userinfo = body.slice(0, at);
    hp = body.slice(at + 1);
    let dec = userinfo;
    if (userinfo.indexOf(':') === -1) {
      const d = b64decode(userinfo);
      if (d) dec = d;
    }
    if (dec.indexOf(':') === -1) { try { dec = decodeURIComponent(dec); } catch {} }
    const ci = dec.indexOf(':');
    if (ci === -1) return { error: 'ss_userinfo' };
    method = dec.slice(0, ci).toLowerCase();
    password = dec.slice(ci + 1);
  } else {
    const d = b64decode(body);
    if (!d) return { error: 'ss_b64' };
    const at2 = d.lastIndexOf('@');
    if (at2 === -1) return { error: 'ss_shape' };
    const ui = d.slice(0, at2);
    hp = d.slice(at2 + 1);
    const ci = ui.indexOf(':');
    if (ci === -1) return { error: 'ss_userinfo' };
    method = ui.slice(0, ci).toLowerCase();
    password = ui.slice(ci + 1);
  }
  const addr = splitHostPort(hp);
  if (!addr || !method) return { error: 'ss_addr' };
  const fields = { cipher: method, password: password, udp: true };
  if (plugin) {
    const pname = plugin.split(';')[0];
    const opts = {};
    for (const kv of plugin.split(';').slice(1)) {
      const eq = kv.indexOf('=');
      if (eq === -1) continue;
      opts[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    if (pname === 'obfs-local' || pname === 'simple-obfs' || pname === 'obfs') {
      fields.plugin = 'obfs';
      fields['plugin-opts'] = { mode: opts.obfs || 'http', host: opts['obfs-host'] || 'www.bing.com' };
    } else if (pname === 'v2ray-plugin') {
      return { error: 'ss_plugin_unsupported' };
    } else {
      return { error: 'ss_plugin_unsupported' };
    }
  }
  const name = asciiSafe(f.tag) || addr.host;
  return { node: { type: 'ss', server: addr.host, port: addr.port, name, fields } };
}

function parseTrojan(uri) {
  const f = frag(uri.slice('trojan://'.length));
  const q = qs(f.rest);
  const at = q.base.lastIndexOf('@');
  if (at === -1) return { error: 'trojan_shape' };
  let password = q.base.slice(0, at);
  try { password = decodeURIComponent(password); } catch {}
  const addr = splitHostPort(q.base.slice(at + 1));
  if (!addr) return { error: 'trojan_addr' };
  const p = q.q;
  const sec = String(p.security || '').toLowerCase();
  const tlsOff = sec === 'none' || String(p.tls || '').toLowerCase() === 'false' || String(p.tls || '') === '0';
  const fields = { password: password, udp: true, tls: !tlsOff };
  if (p.sni) fields.sni = p.sni;
  else if (p.peer) fields.sni = p.peer;
  const net = String(p.type || 'tcp').toLowerCase();
  if (net === 'ws') {
    fields.network = 'ws';
    const ws = { path: p.path ? decodeURIComponent(p.path) : '/' };
    if (p.host) ws['headers'] = { Host: p.host };
    fields['ws-opts'] = ws;
  } else if (net === 'grpc') {
    fields.network = 'grpc';
    fields['grpc-opts'] = { 'grpc-service-name': p.serviceName || p.path || '' };
  }
  const name = asciiSafe(f.tag) || addr.host;
  return { node: { type: 'trojan', server: addr.host, port: addr.port, name, fields } };
}

function parseVless(uri) {
  const f = frag(uri.slice('vless://'.length));
  const q = qs(f.rest);
  const at = q.base.lastIndexOf('@');
  if (at === -1) return { error: 'vless_shape' };
  const uuid = q.base.slice(0, at);
  const addr = splitHostPort(q.base.slice(at + 1));
  if (!addr || !uuid) return { error: 'vless_addr' };
  const p = q.q;
  const sec = String(p.security || 'none').toLowerCase();
  const fields = { uuid: uuid, udp: true };
  const tlsOn = sec === 'tls' || sec === 'reality' || sec === 'xtls';
  fields.tls = tlsOn;
  if (p.sni) fields.servername = p.sni;
  else if (p.host) fields.servername = p.host;
  if (p.flow) fields.flow = p.flow;
  if (p.fp) fields['client-fingerprint'] = p.fp;
  if (sec === 'reality') {
    fields['reality-opts'] = { 'public-key': p.pbk || '', 'short-id': p.sid || '' };
  }
  const net = String(p.type || 'tcp').toLowerCase();
  if (net === 'ws') {
    fields.network = 'ws';
    const ws = { path: p.path ? decodeURIComponent(p.path) : '/' };
    if (p.host) ws['headers'] = { Host: p.host };
    fields['ws-opts'] = ws;
  } else if (net === 'grpc') {
    fields.network = 'grpc';
    fields['grpc-opts'] = { 'grpc-service-name': p.serviceName || p.path || '' };
  } else if (net === 'tcp') {
    fields.network = 'tcp';
  } else if (net === 'h2') {
    fields.network = 'h2';
    fields['h2-opts'] = { path: p.path ? decodeURIComponent(p.path) : '/' };
  }
  const name = asciiSafe(f.tag) || addr.host;
  return { node: { type: 'vless', server: addr.host, port: addr.port, name, fields } };
}

function parseHysteria2(uri, scheme) {
  const f = frag(uri.slice(scheme.length + 3));
  const q = qs(f.rest);
  const at = q.base.lastIndexOf('@');
  let password = '';
  let hostpart = q.base;
  if (at !== -1) {
    password = q.base.slice(0, at);
    try { password = decodeURIComponent(password); } catch {}
    hostpart = q.base.slice(at + 1);
  }
  hostpart = hostpart.replace(/\/+$/, '');
  const addr = splitHostPort(hostpart);
  if (!addr) return { error: 'hy2_addr' };
  const p = q.q;
  const fields = { password: password, udp: true };
  if (p.sni) fields.sni = p.sni;
  if (p.obfs) { fields.obfs = p.obfs; if (p['obfs-password']) fields['obfs-password'] = p['obfs-password']; }
  const name = asciiSafe(f.tag) || addr.host;
  return { node: { type: 'hysteria2', server: addr.host, port: addr.port, name, fields } };
}

function parseTuic(uri) {
  const f = frag(uri.slice('tuic://'.length));
  const q = qs(f.rest);
  const at = q.base.lastIndexOf('@');
  if (at === -1) return { error: 'tuic_shape' };
  const ui = q.base.slice(0, at);
  const ci = ui.indexOf(':');
  if (ci === -1) return { error: 'tuic_userinfo' };
  const uuid = ui.slice(0, ci);
  let password = ui.slice(ci + 1);
  try { password = decodeURIComponent(password); } catch {}
  const addr = splitHostPort(q.base.slice(at + 1));
  if (!addr) return { error: 'tuic_addr' };
  const p = q.q;
  const fields = { uuid: uuid, password: password, udp: true };
  if (p.sni) fields.sni = p.sni;
  if (p.alpn) fields.alpn = p.alpn.split(',').map((x) => x.trim()).filter(Boolean);
  if (p.congestion_control) fields['congestion-controller'] = p.congestion_control;
  const name = asciiSafe(f.tag) || addr.host;
  return { node: { type: 'tuic', server: addr.host, port: addr.port, name, fields } };
}

export function parseUri(uri) {
  const u = String(uri).trim();
  const m = u.match(/^(vmess|vless|ss|trojan|hysteria2|hy2|tuic):\/\//i);
  if (!m) return { error: 'scheme_' + (u.split(':')[0] || 'none') };
  const scheme = m[1].toLowerCase();
  try {
    if (scheme === 'vmess') return parseVmess(u);
    if (scheme === 'ss') return parseSs(u);
    if (scheme === 'trojan') return parseTrojan(u);
    if (scheme === 'vless') return parseVless(u);
    if (scheme === 'hysteria2' || scheme === 'hy2') return parseHysteria2(u, scheme);
    if (scheme === 'tuic') return parseTuic(u);
  } catch (e) {
    return { error: 'exception' };
  }
  return { error: 'scheme' };
}

// ---------- document detection + dispatch ----------

export function detectShape(text) {
  const s = String(text);
  if (/^\s*proxies\s*:/m.test(s)) return 'clash-yaml';
  if (/:\/\//.test(s) && /(vmess|vless|ss|trojan|hysteria2|hy2|tuic):\/\//i.test(s)) return 'uri-list';
  const d = b64decode(s);
  if (d && /:\/\//.test(d)) return 'base64-list';
  return 'unknown';
}

export function extractUris(text) {
  const out = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    const m = t.match(/(vmess|vless|ss|trojan|hysteria2|hy2|tuic):\/\/\S+/i);
    if (m) out.push(m[0]);
  }
  return out;
}

// Clash YAML: pass item blocks through as text, with fields parsed for checks.
export function parseClashItems(text) {
  const found = extractProxiesItems(text);
  if (!found) return { found: false, items: [] };
  const items = [];
  for (const it of found.items) {
    const fields = parseItemFields(it.lines);
    const type = String(fields.type || '').toLowerCase();
    const server = String(fields.server || '').trim();
    const port = parseInt(fields.port, 10);
    items.push({
      kind: 'yaml',
      type: type,
      server: server,
      port: isNaN(port) ? null : port,
      name: String(fields.name || ''),
      fields: fields,
      lines: it.lines,
      indent: it.indent,
      flowText: flowTextOf(it.lines),
    });
  }
  return { found: true, items };
}

export function makeUri(node) {
  const f = node.fields || {};
  const enc = encodeURIComponent;
  const name = node.name || (node.server + ':' + node.port);
  if (node.type === 'vmess') {
    const net = f.network || 'tcp';
    const tlsOn = f.tls === true;
    const wsPath = f['ws-opts'] ? f['ws-opts'].path : '';
    const wsHost = f['ws-opts'] && f['ws-opts'].headers ? f['ws-opts'].headers.Host : '';
    const grpc = f['grpc-opts'] ? f['grpc-opts']['grpc-service-name'] : '';
    const o = {
      v: '2', ps: name, add: node.server, port: String(node.port), id: f.uuid || '',
      aid: String(f.alterId == null ? 0 : f.alterId), scy: f.cipher || 'auto',
      net: net === 'h2' ? 'h2' : net,
      type: 'none',
      host: wsHost || f.servername || '',
      path: net === 'grpc' ? (grpc || '') : (wsPath || ''),
      tls: tlsOn ? 'tls' : '',
      sni: f.servername || '',
    };
    return 'vmess://' + b64encode(JSON.stringify(o));
  }
  if (node.type === 'ss') {
    const ui = b64encode((f.cipher || '') + ':' + (f.password || ''));
    let s = 'ss://' + ui.replace(/=+$/, '') + '@' + node.server + ':' + node.port;
    if (f.plugin === 'obfs' && f['plugin-opts']) {
      s += '/?plugin=' + enc('obfs-local;obfs=' + (f['plugin-opts'].mode || 'http') + ';obfs-host=' + (f['plugin-opts'].host || ''));
    }
    return s + '#' + enc(name);
  }
  if (node.type === 'trojan') {
    let s = 'trojan://' + enc(f.password || '') + '@' + node.server + ':' + node.port + '?';
    const q = ['security=tls'];
    if (f.sni) q.push('sni=' + enc(f.sni));
    if (f.network === 'ws') {
      q.push('type=ws');
      if (f['ws-opts'] && f['ws-opts'].path) q.push('path=' + enc(f['ws-opts'].path));
      if (f['ws-opts'] && f['ws-opts'].headers && f['ws-opts'].headers.Host) q.push('host=' + enc(f['ws-opts'].headers.Host));
    }
    return s + q.join('&') + '#' + enc(name);
  }
  if (node.type === 'vless') {
    const q = ['encryption=none'];
    const sec = f['reality-opts'] ? 'reality' : (f.tls === true ? 'tls' : 'none');
    q.push('security=' + sec);
    if (f.servername) q.push('sni=' + enc(f.servername));
    if (f.flow) q.push('flow=' + enc(f.flow));
    if (f.network) q.push('type=' + f.network);
    if (f['ws-opts'] && f['ws-opts'].path) q.push('path=' + enc(f['ws-opts'].path));
    if (f['ws-opts'] && f['ws-opts'].headers && f['ws-opts'].headers.Host) q.push('host=' + enc(f['ws-opts'].headers.Host));
    if (f['grpc-opts'] && f['grpc-opts']['grpc-service-name']) q.push('serviceName=' + enc(f['grpc-opts']['grpc-service-name']));
    if (f['reality-opts']) {
      if (f['reality-opts']['public-key']) q.push('pbk=' + enc(f['reality-opts']['public-key']));
      if (f['reality-opts']['short-id']) q.push('sid=' + enc(f['reality-opts']['short-id']));
    }
    if (f['client-fingerprint']) q.push('fp=' + enc(f['client-fingerprint']));
    return 'vless://' + (f.uuid || '') + '@' + node.server + ':' + node.port + '?' + q.join('&') + '#' + enc(name);
  }
  if (node.type === 'hysteria2') {
    const q = [];
    if (f.sni) q.push('sni=' + enc(f.sni));
    if (f.obfs) q.push('obfs=' + enc(f.obfs));
    if (f['obfs-password']) q.push('obfs-password=' + enc(f['obfs-password']));
    return 'hysteria2://' + enc(f.password || '') + '@' + node.server + ':' + node.port + '/?' + q.join('&') + '#' + enc(name);
  }
  if (node.type === 'tuic') {
    const q = [];
    if (f.sni) q.push('sni=' + enc(f.sni));
    if (f.alpn) q.push('alpn=' + enc(Array.isArray(f.alpn) ? f.alpn.join(',') : f.alpn));
    return 'tuic://' + (f.uuid || '') + ':' + enc(f.password || '') + '@' + node.server + ':' + node.port + '?' + q.join('&') + '#' + enc(name);
  }
  return null;
}
