// lib/github.mjs - GitHub REST client built on curl (no third-party deps).
//
// Why curl and not global fetch: the harness/runner can export HTTP(S)_PROXY, and
// Node's undici then routes API traffic through it. api.github.com is reachable
// direct from a GitHub runner AND from the dev box, so every request here is made
// with --noproxy '*'. That keeps the API path independent of whatever local proxy
// the developer happens to be running.
//
// Owns four things:
//   1. a disk cache under cache/api/ (so a re-run inside the TTL costs zero requests)
//   2. request accounting + a hard CORE budget for unauthenticated mode (60/h real)
//   3. a search rate limiter (unauthenticated search allows only 10/min)
//   4. sticky "stop talking to GitHub" state once the API says we are rate limited
//
// It never throws for an HTTP/transport failure: callers get {status, json, error}.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.github.com';
const UA = 'nodepool-aggregator';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');
}

// curl -D appends one header block per redirect hop; the last block is the response.
function parseHeaderBlock(text) {
  const blocks = String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n\n/)
    .filter((b) => /^HTTP\//.test(b.trim()));
  const block = blocks.length ? blocks[blocks.length - 1] : '';
  const out = {};
  for (const line of block.split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function runCurl(url, headers, timeoutMs, hdrFile) {
  const argv = [
    '-sS', '-L', '--noproxy', '*',
    '--max-time', String(Math.max(1, Math.ceil((timeoutMs || 25000) / 1000))),
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: ' + UA,
  ];
  for (const h of headers || []) argv.push('-H', h);
  argv.push('-D', hdrFile, '-w', '\n%{http_code}', url);
  return new Promise((resolve) => {
    execFile('curl', argv, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, async (err, so, se) => {
      let hdrs = {};
      try { hdrs = parseHeaderBlock(await fs.readFile(hdrFile, 'utf8')); } catch {}
      try { await fs.unlink(hdrFile); } catch {}
      const out = String(so == null ? '' : so);
      const m = out.match(/\n(\d{3})$/);
      const body = m ? out.slice(0, m.index) : out;
      const status = m ? parseInt(m[1], 10) : 0;
      let error = null;
      if (!m) error = String((se || (err && err.message) || 'curl failed')).trim().slice(0, 300) || 'curl failed';
      resolve({ status, body, headers: hdrs, error });
    });
  });
}

export class GitHub {
  constructor(opts) {
    const o = opts || {};
    this.token = o.token || null;
    this.cacheDir = o.cacheDir;
    this.tmpDir = o.tmpDir || (o.cacheDir ? path.join(o.cacheDir, '.tmp') : '.');
    this.offline = !!o.offline;
    this.refresh = !!o.refresh;
    // Core budget: unauthenticated core allows 60/h, so stop before we hit the wall
    // and leave the rest of the run a working API instead of a wall of 403s.
    this.coreBudget = o.coreBudget == null ? (this.token ? Infinity : 55) : o.coreBudget;
    // Search allows 10/min unauthenticated -> keep ~6.5s between search requests.
    this.searchMinGapMs = o.searchMinGapMs == null ? (this.token ? 1100 : 6500) : o.searchMinGapMs;
    this.timeoutMs = o.timeoutMs || 25000;
    this.log = o.log || (() => {});
    this.usedCore = 0;
    this.usedSearch = 0;
    this.cacheHits = 0;
    this.seq = 0;
    this.lastSearchAt = 0;
    // Search (10/min unauth) and core (60/h unauth) are SEPARATE rate-limit buckets.
    // Conflating them was a real bug: one exhausted search turned the core API off too,
    // which silently disabled the commit gate. Track them independently.
    this.exhausted = { search: null, core: null };
    // When a 403 carries a reset timestamp close enough, wait for the window to roll
    // over and retry once instead of losing the query entirely.
    this.maxWaitMs = o.maxWaitMs == null ? 70000 : o.maxWaitMs;
  }

  async init() {
    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.mkdir(this.tmpDir, { recursive: true });
  }

  stats() {
    return {
      authenticated: !!this.token,
      core_requests: this.usedCore,
      core_budget: this.coreBudget === Infinity ? null : this.coreBudget,
      search_requests: this.usedSearch,
      cache_hits: this.cacheHits,
      offline: this.offline,
      stopped: this.exhausted.search || this.exhausted.core || null,
      stopped_search: this.exhausted.search,
      stopped_core: this.exhausted.core,
    };
  }

  cachePath(url) {
    return path.join(this.cacheDir, sha1(url) + '.json');
  }

  async readCache(url) {
    try {
      const d = JSON.parse(await fs.readFile(this.cachePath(url), 'utf8'));
      if (!d || typeof d.ts !== 'number' || typeof d.status !== 'number') return null;
      return d;
    } catch { return null; }
  }

  async writeCache(url, status, body) {
    const f = this.cachePath(url);
    const tmp = f + '.' + process.pid + '.' + (++this.seq) + '.tmp';
    const rec = { url, ts: Date.now(), status, body };
    try {
      await fs.writeFile(tmp, JSON.stringify(rec), 'utf8');
      await fs.rename(tmp, f);
    } catch {}
  }

  // pathOrUrl -> {status, json, cached, age_s, error, headers}
  async call(p, opts) {
    const o = opts || {};
    const url = /^https?:/i.test(p) ? p : API + p;
    const ttlMs = o.ttlMs == null ? 30 * 60 * 1000 : o.ttlMs;
    const cached = await this.readCache(url);
    const age = cached ? Date.now() - cached.ts : Infinity;
    if (cached && (this.offline || (!this.refresh && age <= ttlMs))) {
      this.cacheHits++;
      return { status: cached.status, json: cached.body, cached: true, age_s: Math.round(age / 1000), error: null, headers: {} };
    }
    if (this.offline) {
      return { status: 0, json: null, cached: false, error: 'offline_cache_miss', headers: {} };
    }
    const kind = o.search ? 'search' : 'core';
    if (this.exhausted[kind]) {
      return { status: 0, json: null, cached: false, error: 'api_stopped:' + (this.exhausted[kind].reason || 'rate_limited'), headers: {} };
    }
    if (kind === 'core' && this.usedCore >= this.coreBudget) {
      this.exhausted.core = { reason: 'api_budget_exhausted', budget: this.coreBudget, at: new Date().toISOString() };
      return { status: 0, json: null, cached: false, error: 'api_budget_exhausted', headers: {} };
    }
    const headers = [];
    if (this.token) headers.push('Authorization: Bearer ' + this.token);

    for (let attempt = 0; attempt < 2; attempt++) {
      if (kind === 'search') {
        const wait = Math.max(0, this.lastSearchAt + this.searchMinGapMs - Date.now());
        if (wait > 0) await sleep(wait);
        this.lastSearchAt = Date.now();
        this.usedSearch++;
      } else {
        this.usedCore++;
      }
      const hdrFile = path.join(this.tmpDir, 'h.' + process.pid + '.' + (++this.seq) + '.txt');
      const r = await runCurl(url, headers, this.timeoutMs, hdrFile);
      let json = null;
      if (r.body && r.body.trim()) {
        try { json = JSON.parse(r.body); } catch { json = null; }
      }
      let error = r.error;
      if (!error && r.status >= 400) {
        error = (json && json.message) ? String(json.message) : 'http ' + r.status;
        const msg = String(error).toLowerCase();
        const remainingZero = r.headers['x-ratelimit-remaining'] === '0';
        const rateLimited = r.status === 429 || remainingZero || msg.includes('rate limit') || msg.includes('abuse detection');
        if (rateLimited) {
          const resetS = r.headers['x-ratelimit-reset'];
          const resetMs = resetS ? Number(resetS) * 1000 - Date.now() : null;
          const info = {
            reason: String(error).slice(0, 200),
            status: r.status,
            reset_at: resetS ? new Date(Number(resetS) * 1000).toISOString() : null,
            at: new Date().toISOString(),
          };
          // A short window (the 10/min search bucket) is worth waiting out; the hourly
          // core bucket is not, so that one just stops the bucket and says why.
          if (attempt === 0 && resetMs != null && resetMs > 0 && resetMs <= this.maxWaitMs) {
            this.log('    github ' + kind + ' bucket rate limited; waiting ' + Math.round((resetMs + 1200) / 1000) +
              's for the window to reset (reset_at ' + info.reset_at + '), then retrying');
            await sleep(resetMs + 1200);
            continue;
          }
          this.exhausted[kind] = info;
        }
      }
      if (json && (r.status === 200 || r.status === 404 || r.status === 409)) {
        await this.writeCache(url, r.status, json);
      }
      return { status: r.status, json, cached: false, age_s: null, error: error || null, headers: r.headers };
    }
    return { status: 0, json: null, cached: false, error: 'retry_exhausted', headers: {} };
  }

  exhaustedFor(kind) {
    return this.exhausted[kind || 'core'] || null;
  }
}
