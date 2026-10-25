// lib/select.mjs - 「有限名额怎么分」这件事只写一遍。
//
// 背景（真实发生过的 bug）：探测名额是有限的（max-live / max-probe），而节点列表是按
// 去重键排序的。http / socks5 的键在字母序上靠前，直接 slice 会把这些明文代理塞满整个
// 名额，后面的 ss / trojan / vmess 根本没被测到 —— 于是整池子清一色是用户想屏蔽的类别。
// 这里按类型分桶后轮转交错，让每个类别按自己的贡献比例拿到名额，且保持确定性。

export function stratifyByType(list, cap) {
  if (!cap || list.length <= cap) return list.slice();
  const buckets = new Map();
  for (const n of list) {
    const t = String(n.type || '').toLowerCase();
    if (!buckets.has(t)) buckets.set(t, []);
    buckets.get(t).push(n);
  }
  const queues = Array.from(buckets.values());
  const out = [];
  for (let i = 0; out.length < cap; i++) {
    let progressed = false;
    for (const q of queues) {
      if (i < q.length && out.length < cap) { out.push(q[i]); progressed = true; }
    }
    if (!progressed) break;
  }
  return out;
}
