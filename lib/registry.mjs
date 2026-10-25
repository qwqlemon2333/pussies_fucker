// lib/registry.mjs - 被收录源仓库的花名册：谁在看、从什么时候开始、谁因为什么被删掉。
//
// 为什么要这份东西：discovery 每次都是「当场搜一遍」，搜到谁就用谁。没有持久化的话，
// 一个今天没被搜到、或者排名掉出 maxRepos 的仓库会凭空消失，而一个已经停更的仓库
// 反而可能因为搜索缓存又活过来一轮。花名册把「收录」变成一个有状态的集合：
//
//   - 每轮把花名册里的仓库**强制送进** 5 天提交闸门（哪怕这轮搜索没返回它）；
//   - 默认分支最新提交早于窗口，或仓库 404 / archived / disabled，就从花名册里删掉；
//   - 连续多轮都没被验证到的，视为已消失，删掉；
//   - 超过上限按「上轮产出节点数」从低到高淘汰；
//   - 所有删除都留一条原因，写进 registry/removed 数组（只看最近 200 条）。
import fs from 'node:fs/promises';
import path from 'node:path';

export const REGISTRY_FILE = path.join('registry', 'sources.json');
export const SCHEMA = 1;
// 这些是「这个源已经不合格」的确定性理由，出现即删。
// 注意不要把 not_verified_cap / max_repos_reached / no_subscription_file 放进来：
// 那些说明的是「这轮没选中」，不是「这个源坏了」。
export const HARD_REMOVE = [
  'stale_default_branch', 'not_found', 'empty_repository', 'archived', 'disabled',
  'fork_of_candidate', 'no_default_branch',
];
export const FORGET_AFTER_RUNS = 6;
const MAX_REMOVED_LOG = 200;

export function newRegistry() {
  return { schema: SCHEMA, updated_at: null, sources: [], removed: [] };
}

export async function loadRegistry(root) {
  const file = path.join(root, REGISTRY_FILE);
  let doc;
  try { doc = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { return newRegistry(); }
  if (!doc || doc.schema !== SCHEMA || !Array.isArray(doc.sources)) return newRegistry();
  doc.removed = Array.isArray(doc.removed) ? doc.removed : [];
  return doc;
}

export async function saveRegistry(root, reg) {
  const file = path.join(root, REGISTRY_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  reg.updated_at = new Date().toISOString();
  reg.sources.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  await fs.writeFile(file, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  return file;
}

// 花名册里的仓库要作为 seed 灌回 discovery，保证它每轮都被重新验一遍。
export function seedRepos(reg) {
  return (reg.sources || []).map((s) => ({ repo: s.repo, default_branch: s.default_branch || null, stars: s.stars || 0 }));
}

function pickDate(rec) {
  return (rec && (rec.commit_date || (rec.commit && rec.commit.date))) || null;
}

// 一轮跑完之后结算花名册。纯函数：不改 snap，返回新的 registry + 一份摘要。
export function mergeRun(reg, snap, opts) {
  const o = opts || {};
  const nowIso = o.nowIso || new Date().toISOString();
  const recencyDays = o.recencyDays == null ? 5 : o.recencyDays;
  const cutoffMs = Date.parse(nowIso) - recencyDays * 86400e3;
  const maxSources = o.maxSources == null ? 60 : o.maxSources;
  const forgetAfter = o.forgetAfterRuns == null ? FORGET_AFTER_RUNS : o.forgetAfterRuns;
  const nodeCounts = o.nodeCounts || {};

  const kept = new Map();
  for (const s of reg.sources || []) kept.set(s.repo, Object.assign({}, s));
  const added = [];
  const removed = [];
  const evicted = [];
  const refreshed = [];
  const unverified = [];
  const removedLog = (reg.removed || []).slice();

  const seen = new Map();
  for (const r of snap.recent_repos || []) {
    seen.set(r.full_name, { repo: r.full_name, commit_date: pickDate(r), stars: r.stars || 0, files: (r.files || []).slice(), reason: null });
  }
  for (const r of snap.repos || []) {
    const cur = seen.get(r.full_name) || { repo: r.full_name, stars: r.stars || 0, files: [] };
    cur.commit_date = pickDate(r) || cur.commit_date || null;
    cur.files = (r.files || []).slice().length ? (r.files || []).slice() : cur.files;
    cur.selected = true;
    seen.set(r.full_name, cur);
  }
  const dropped = new Map();
  for (const d of snap.dropped || []) dropped.set(d.full_name, { repo: d.full_name, reason: d.reason, commit_date: pickDate(d) });

  function bury(repo, reason) {
    removed.push({ repo, reason, at: nowIso });
    removedLog.push({ repo, reason, at: nowIso });
    kept.delete(repo);
  }

  // 1) 已经在册的：要么刷新，要么按理由请出去
  for (const [repo, s] of Array.from(kept)) {
    const d = dropped.get(repo);
    if (d && HARD_REMOVE.indexOf(d.reason) >= 0) { bury(repo, d.reason); continue; }
    const hit = seen.get(repo);
    if (hit) {
      const date = hit.commit_date || s.last_commit_date || null;
      s.last_seen = nowIso;
      s.last_commit_date = date;
      s.runs_seen = (s.runs_seen || 0) + 1;
      s.unverified_runs = 0;
      s.status = 'active';
      if (hit.files && hit.files.length) s.files = hit.files.slice(0, 6);
      if (nodeCounts[repo] != null) s.nodes_kept = nodeCounts[repo];
      if (date && Date.parse(date) < cutoffMs) { bury(repo, 'stale_default_branch'); continue; }
      refreshed.push(repo);
      continue;
    }
    // 这轮完全没验到它（搜索没返回 + 闸门也没轮到）：留着，但记账
    s.unverified_runs = (s.unverified_runs || 0) + 1;
    s.status = 'unverified';
    if (s.unverified_runs >= forgetAfter) { bury(repo, 'forgotten_unverified'); continue; }
    if (s.last_commit_date && Date.parse(s.last_commit_date) < cutoffMs) { bury(repo, 'stale_default_branch'); continue; }
    unverified.push(repo);
  }

  // 2) 这轮新被选中的：直接入册
  for (const r of snap.repos || []) {
    if (kept.has(r.full_name)) continue;
    const date = pickDate(r);
    if (date && Date.parse(date) < cutoffMs) continue;
    kept.set(r.full_name, {
      repo: r.full_name,
      default_branch: r.default_branch || null,
      stars: r.stars || 0,
      first_seen: nowIso,
      last_seen: nowIso,
      last_commit_date: date,
      runs_seen: 1,
      unverified_runs: 0,
      status: 'active',
      files: (r.files || []).slice(0, 6),
      nodes_kept: nodeCounts[r.full_name] == null ? null : nodeCounts[r.full_name],
    });
    added.push(r.full_name);
  }

  // 3) 上限：先淘汰「上轮一个节点都没产出」的，再淘汰最久没见到的
  if (kept.size > maxSources) {
    const order = Array.from(kept.values()).sort((a, b) => {
      const na = a.nodes_kept == null ? -1 : a.nodes_kept;
      const nb = b.nodes_kept == null ? -1 : b.nodes_kept;
      if (na !== nb) return na - nb;
      return String(a.last_seen || '').localeCompare(String(b.last_seen || ''));
    });
    for (const s of order.slice(0, kept.size - maxSources)) {
      evicted.push(s.repo);
      removed.push({ repo: s.repo, reason: 'evicted_max_sources', at: nowIso });
      removedLog.push({ repo: s.repo, reason: 'evicted_max_sources', at: nowIso });
      kept.delete(s.repo);
    }
  }

  const next = {
    schema: SCHEMA,
    updated_at: nowIso,
    recency_days: recencyDays,
    cutoff: new Date(cutoffMs).toISOString(),
    sources: Array.from(kept.values()),
    removed: removedLog.slice(-MAX_REMOVED_LOG),
  };
  const summary = {
    total: next.sources.length,
    refreshed: refreshed.length,
    added,
    removed,
    evicted,
    unverified,
    note: 'removed = 本轮被请出花名册的源（stale/404/archived/连续未验证/超上限）',
  };
  return { registry: next, summary };
}