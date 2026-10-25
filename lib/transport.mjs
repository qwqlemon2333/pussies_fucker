// lib/transport.mjs - HTTP(S) transport with measured mirror fallback chain.
// No third-party deps: shells out to curl (present on Windows 10+ and git-bash).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

const PROXY = 'http://127.0.0.1:7897/';

function encPath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

// Ordered candidates, in the order that matters on a GITHUB RUNNER:
// raw.githubusercontent.com works from Actions, so it goes first; jsdelivr and the two
// prefix mirrors follow as fallbacks. The two '*-proxied' entries only work on a dev
// box that runs a local mihomo on 127.0.0.1:7897 - probeTransports drops them wherever
// that listener is absent, so they cost nothing in CI.
export const TRANSPORTS = [
  {
    id: 'raw-direct',
    note: 'raw.githubusercontent.com, direct (no proxy)',
    args: ['--noproxy', '*'],
    url: (o, r, b, p) => 'https://raw.githubusercontent.com/' + o + '/' + r + '/' + b + '/' + encPath(p),
  },
  {
    id: 'jsdelivr-direct',
    note: 'cdn.jsdelivr.net gh endpoint, direct',
    args: ['--noproxy', '*'],
    url: (o, r, b, p) => 'https://cdn.jsdelivr.net/gh/' + o + '/' + r + '@' + b + '/' + encPath(p),
  },
  {
    id: 'jsdelivr-proxied',
    note: 'cdn.jsdelivr.net gh endpoint via local mihomo (dev box only)',
    args: ['--proxy', PROXY],
    url: (o, r, b, p) => 'https://cdn.jsdelivr.net/gh/' + o + '/' + r + '@' + b + '/' + encPath(p),
  },
  {
    id: 'gh-proxy.com',
    note: 'gh-proxy.com prefix mirror',
    args: ['--noproxy', '*'],
    url: (o, r, b, p) => 'https://gh-proxy.com/https://raw.githubusercontent.com/' + o + '/' + r + '/' + b + '/' + encPath(p),
  },
  {
    id: 'ghproxy.net',
    note: 'ghproxy.net prefix mirror',
    args: ['--noproxy', '*'],
    url: (o, r, b, p) => 'https://ghproxy.net/https://raw.githubusercontent.com/' + o + '/' + r + '/' + b + '/' + encPath(p),
  },
  {
    id: 'raw-proxied',
    note: 'raw.githubusercontent.com via local mihomo (dev box only)',
    args: ['--proxy', PROXY],
    url: (o, r, b, p) => 'https://raw.githubusercontent.com/' + o + '/' + r + '/' + b + '/' + encPath(p),
  },
];

export function declaredChain() {
  return TRANSPORTS.map((x) => x.id);
}

export function transportById(id) {
  return TRANSPORTS.find((t) => t.id === id) || null;
}

// Run curl, writing the body to outFile. Resolves never-rejecting status object.
export async function curl(url, args, outFile, timeoutMs) {
  const secs = String(Math.max(1, Math.round((timeoutMs || 20000) / 1000)));
  const argv = ['-sS', '-L', '--max-time', secs].concat(args || []).concat([
    '-o', outFile, '-w', '%{http_code} %{size_download} %{time_total}', url,
  ]);
  const t0 = Date.now();
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile('curl', argv, { maxBuffer: 1 << 20, windowsHide: true }, (err, so, se) => {
        if (err && !so) return reject(Object.assign(err, { stderr: se }));
        resolve({ stdout: so, stderr: se });
      });
    });
    const parts = String(stdout).trim().split(/\s+/);
    return {
      status: parseInt(parts[0], 10) || 0,
      bytes: parseInt(parts[1], 10) || 0,
      seconds: parseFloat(parts[2]) || (Date.now() - t0) / 1000,
      error: null,
    };
  } catch (e) {
    return { status: 0, bytes: 0, seconds: (Date.now() - t0) / 1000, error: String(e.stderr || e.message).trim() };
  }
}

// Probe one file through every transport once; return the working chain by latency.
export async function probeTransports(probe, tmpDir, timeoutMs) {
  const hosts = {};
  const working = [];
  for (const t of TRANSPORTS) {
    const url = t.url(probe.owner, probe.repo, probe.branch, probe.path);
    const out = tmpDir + '/probe.' + t.id + '.bin';
    const r = await curl(url, t.args, out, timeoutMs);
    let ok = r.status === 200 && r.bytes > 0;
    hosts[t.id] = { url, status: r.status, bytes: r.bytes, seconds: +r.seconds.toFixed(2), ok, error: r.error };
    if (ok) working.push({ t, latency: r.seconds });
    try { await fs.unlink(out); } catch {}
  }
  // Fastest first; declared order breaks ties so a chain is reproducible.
  const declared = new Map(TRANSPORTS.map((x, i) => [x.id, i]));
  working.sort((a, b) => a.latency - b.latency || (declared.get(a.t.id) - declared.get(b.t.id)));
  return { hosts, chain: working.map((w) => w.t.id) };
}

// Fetch path from canonical repo, trying the chain. Returns {bytes, transport, status, attempts}.
export async function fetchPath(chain, owner, repo, branch, subPath, outFile, timeoutMs) {
  const attempts = [];
  for (const id of chain) {
    const t = transportById(id);
    if (!t) continue;
    const url = t.url(owner, repo, branch, subPath);
    const r = await curl(url, t.args, outFile, timeoutMs);
    attempts.push({ transport: id, url, status: r.status, bytes: r.bytes, seconds: +r.seconds.toFixed(2), error: r.error });
    if (r.status === 200 && r.bytes > 0) {
      return { ok: true, bytes: r.bytes, transport: id, url, status: r.status, attempts };
    }
  }
  return { ok: false, bytes: 0, transport: null, url: attempts.length ? attempts[attempts.length - 1].url : null, status: attempts.length ? attempts[attempts.length - 1].status : 0, attempts };
}