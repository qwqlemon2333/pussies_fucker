// lib/yamlmini.mjs - deliberately NOT a general YAML parser.
// Extracts the top-level 'proxies:' sequence by indentation and returns each item
// block as raw text (passed through to the output) plus a small field map used for
// safety checks, dedupe and URI synthesis.

export function indentOf(line) {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') n += 1;
    else if (c === '\t') n += 2;
    else break;
  }
  return n;
}

function stripComment(s) {
  const i = s.indexOf(' #');
  return i === -1 ? s : s.slice(0, i);
}

export function unquote(v) {
  let s = String(v).trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    s = s.slice(1, -1);
    if (v[0] === '"') s = s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}

// --- flow-style ('- {name: x, server: y}') support -------------------------
// Walks a string tracking quote state and brace/bracket depth so commas and
// colons inside quoted values or nested inline maps are not treated as separators.
function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '' || out.length) out.push(cur);
  return out;
}

function findTopLevelColon(s) {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ':' && depth === 0) return i;
  }
  return -1;
}

function braceBalance(s) {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return depth;
}

// If this item is written as an inline flow map, return it as ONE line of text
// (still starting with '{'): '- {a: 1, b: 2}' -> '{a: 1, b: 2}'. Otherwise null.
export function flowTextOf(blockLines) {
  const lines = blockLines.map((l) => l.replace(/\r$/, ''));
  let k = 0;
  while (k < lines.length && (!lines[k].trim() || lines[k].trim().startsWith('#'))) k++;
  if (k >= lines.length) return null;
  const m = lines[k].match(/^\s*-\s+(\{.*)$/);
  if (!m) return null;
  const parts = [m[1].trim()];
  let text = parts[0];
  let j = k + 1;
  while (braceBalance(text) > 0 && j < lines.length) {
    const t = lines[j].trim();
    j++;
    if (!t || t.startsWith('#')) continue;
    text += ' ' + t;
  }
  const end = text.lastIndexOf('}');
  if (end === -1) return null;
  return text.slice(0, end + 1).replace(/\s+/g, ' ').trim();
}

// Parse '{k: v, k2: v2, k3: {nested: map}}' into a flat field map. Nested inline
// values are kept as their raw text so they can be re-emitted untouched.
export function parseFlowMap(text) {
  let body = String(text).trim();
  if (body.startsWith('{')) body = body.slice(1);
  if (body.endsWith('}')) body = body.slice(0, -1);
  const out = {};
  for (const token of splitTopLevel(body, ',')) {
    const t = token.trim();
    if (!t) continue;
    const ci = findTopLevelColon(t);
    if (ci === -1) continue;
    const key = unquote(t.slice(0, ci));
    const rest = t.slice(ci + 1).trim();
    if (rest.startsWith('{') || rest.startsWith('[')) out[key] = rest;
    else out[key] = unquote(rest);
  }
  return out;
}

// Minimal block parser for one proxies item: maps, nested maps, scalar lists.
export function parseItemFields(blockLines) {
  const flow = flowTextOf(blockLines);
  if (flow) return parseFlowMap(flow);
  const lines = blockLines.map((l) => l.replace(/\r$/, ''));
  // The block starts with '- key: value'; rewrite the dash so it parses like a map entry.
  const first = lines[0];
  const dashIdx = first.indexOf('-');
  const baseIndent = dashIdx >= 0 ? dashIdx : indentOf(first);
  if (dashIdx >= 0) lines[0] = ' '.repeat(dashIdx + 2) + first.slice(dashIdx + 1).replace(/^\s+/, '');

  let i = 0;
  function nextMeaningful() {
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim() || l.trim().startsWith('#')) { i++; continue; }
      return l;
    }
    return null;
  }
  function parseMap(indent) {
    const out = {};
    for (;;) {
      const l = nextMeaningful();
      if (l === null) break;
      const ind = indentOf(l);
      if (ind < indent) break;
      if (ind > indent) { i++; continue; }
      const body = l.trim();
      const ci = body.indexOf(':');
      if (ci === -1) { i++; continue; }
      const key = unquote(body.slice(0, ci));
      const rest = stripComment(body.slice(ci + 1)).trim();
      i++;
      if (rest === '') {
        const nxt = nextMeaningful();
        if (nxt && indentOf(nxt) > ind) {
          const nind = indentOf(nxt);
          if (nxt.trim().startsWith('- ')) {
            const arr = [];
            while (i < lines.length) {
              const m = nextMeaningful();
              if (!m || indentOf(m) !== nind || !m.trim().startsWith('- ')) break;
              arr.push(unquote(stripComment(m.trim().slice(2)).trim()));
              i++;
            }
            out[key] = arr;
          } else {
            out[key] = parseMap(nind);
          }
        } else out[key] = null;
      } else if (rest.startsWith('{') || rest.startsWith('[')) {
        out[key] = rest;
      } else {
        out[key] = unquote(rest);
      }
    }
    return out;
  }
  return parseMap(baseIndent + 2);
}

// Locate the top-level proxies: sequence. Returns null when the document has none.
export function extractProxiesItems(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^proxies\s*:\s*(#.*)?$/.test(lines[i])) { start = i; break; }
    if (/^proxies\s*:\s*\[\s*\]\s*$/.test(lines[i])) return { items: [], empty: true };
  }
  if (start === -1) return null;
  const items = [];
  let itemIndent = -1;
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t === '' || t.startsWith('#')) { if (cur) cur.push(line); continue; }
    const ind = indentOf(line);
    const isItem = /^-\s+\S/.test(t) || t === '-';
    if (isItem && (itemIndent === -1 || ind === itemIndent)) {
      if (itemIndent === -1) itemIndent = ind;
      if (cur) items.push({ indent: itemIndent, lines: cur });
      cur = [line];
      continue;
    }
    if (ind <= itemIndent && !isItem) {
      // next top-level key ends the sequence
      break;
    }
    if (ind > itemIndent && cur) { cur.push(line); continue; }
    if (ind <= itemIndent && !cur) break;
  }
  if (cur) items.push({ indent: itemIndent, lines: cur });
  return { items };
}

// Normalise item lines to a 2-space indented block.
export function reindentItem(item) {
  const out = [];
  for (const raw of item.lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const ind = indentOf(line);
    const rel = Math.max(0, ind - item.indent);
    out.push('  ' + ' '.repeat(rel) + line.slice(ind));
  }
  return out;
}
