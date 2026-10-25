// lib/live.mjs - cheap TCP connect prefilter (NOT proof the node proxies traffic).
import net from 'node:net';

function tcpOnce(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let settled = false;
    const sock = new net.Socket();
    const done = (ok, err) => {
      if (settled) return;
      settled = true;
      const rtt = Number(process.hrtime.bigint() - t0) / 1e6;
      try { sock.destroy(); } catch {}
      resolve({ ok, rtt_ms: Math.round(rtt * 10) / 10, error: err || null });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true, null));
    sock.once('timeout', () => done(false, 'timeout'));
    sock.once('error', (e) => done(false, e.code || String(e.message)));
    try {
      sock.connect({ host, port });
    } catch (e) {
      done(false, String(e.message));
    }
  });
}

export async function tcpCheck(host, port, timeoutMs) {
  // one retry: a single refused handshake on a busy box is not proof of death
  const a = await tcpOnce(host, port, timeoutMs);
  if (a.ok) return a;
  if (a.error === 'ENOTFOUND') return a;
  return tcpOnce(host, port, timeoutMs);
}

// Bounded pool. items in, results out (same order).
export async function poolCheck(items, concurrency, timeoutMs, onProgress) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      const it = items[i];
      const r = await tcpCheck(it.server, it.port, timeoutMs);
      results[i] = r;
      done++;
      if (onProgress && done % 250 === 0) onProgress(done, items.length);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
