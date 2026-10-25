// lib/discover.mjs - dynamic source discovery with a REAL default-branch recency gate.
//
// Nothing here is a fixed repo list: stage 1 runs several GitHub searches, merges them
// and dedupes by full_name; stage 2 confirms the recency claim against the *default
// branch* commit history (pushed_at is not enough: a push to a side branch bumps it).
//
//   stage 1  /search/repositories?q=<topic|keyword> pushed:>=<date>
//   stage 2  /repos/{o}/{r}/commits?per_page=1&sha=<default_branch>   -> {sha, date}
//   stage 3  /repos/{o}/{r}/git/trees/<default_branch>?recursive=1    -> pick <=3 files
//
// A repo whose newest default-branch commit is older than RECENCY_DAYS is DROPPED
// and the reason + commit date are recorded for out/sources.json.
import fs from 'node:fs/promises';
import path from 'node:path';

export const TOPIC_QUERIES = [
  'topic:v2ray',
  'topic:v2ray-configs',
  'topic:clash',
  'topic:clash-config',
  'topic:free-subscribe',
  'topic:shadowsocks',
  'topic:hysteria',
  'topic:vmess',
];

export const KEYWORD_QUERIES = [
  'vmess subscription',
  'free v2ray nodes',
  'clash subscription free',
  'free proxies nodes',
];

// Topics first (they are the strongest signal), then keyword searches.
export const ALL_QUERIES = TOPIC_QUERIES.concat(KEYWORD_QUERIES);

export function isoDate(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Trees are cached on disk (cache/trees/<owner>__<repo>.json, same layout the old tool
// used) so that a re-run which has already spent its unauthenticated core quota can still
// rank repos it has seen before instead of selecting nothing.
async function readTreeCache(file) {
  try {
    const txt = await fs.readFile(file, 'utf8');
    const j = JSON.parse(txt);
    if (j && Array.isArray(j.tree)) return j;
  } catch (e) { /* missing or unreadable: treated as a miss */ }
  return null;
}

async function writeTreeCache(file, payload) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp' + process.pid;
    await fs.writeFile(tmp, JSON.stringify(payload));
    await fs.rename(tmp, file);
  } catch (e) { /* cache is best effort; never fail discovery over it */ }
}

export function cutoffDateString(recencyDays, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  return new Date(now - recencyDays * 86400e3).toISOString().slice(0, 10);
}

// Keep ':' '-' '.' '=' literal (topic:foo-bar, pushed:>=date); spaces become '+'.
function encodeQuery(q) {
  return String(q)
    .split(' ')
    .map((part) => part.replace(/[^A-Za-z0-9:_.\-=]/g, (c) => encodeURIComponent(c)))
    .join('+');
}

// ---------- file selection inside a repo ----------

// name hints, higher weight = more likely to be a full node list
// [hint, weight, mode]
//   sub   = distinctive word, substring anywhere is fine ('clash20261025.yml')
//   token = must be a whole token ('ss.txt')
//   first = generic word, must LEAD the stem, otherwise 'linux/packaging/deb/make_config.yaml'
//           and 'release/config/config.json' look like node lists and parse to nothing
const NAME_HINTS = [
  ['sub', 14, 'sub'], ['subs', 12, 'sub'], ['clash', 12, 'sub'], ['v2ray', 10, 'sub'],
  ['vmess', 10, 'sub'], ['nodes', 10, 'sub'], ['proxy', 8, 'sub'], ['trojan', 8, 'sub'],
  ['hysteria', 8, 'sub'], ['vless', 8, 'sub'], ['configs', 7, 'sub'],
  ['node', 7, 'first'], ['config', 6, 'first'], ['best', 7, 'first'], ['all', 6, 'first'],
  ['mix', 6, 'first'], ['list', 5, 'first'], ['free', 5, 'first'], ['ss', 4, 'token'],
];
const EXT_SCORE = { '.yaml': 9, '.yml': 9, '.json': 6, '.txt': 4 };
const SKIP_DIR = /^(\.github|\.git|\.gitlab|\.circleci|\.vscode|docs?|images?|img|assets|static|node_modules)$/i;
const SKIP_FILE = /^(readme|license|licence|changelog|contributing|code_of_conduct)(\.|$)/i;
// Anything not in this allow-list is skipped outright (images, archives, workflows...).
const DATA_EXT = /\.(txt|ya?ml|json)$/i;

// Code/fixture noise. A topic search for 'clash' happily returns *client applications*
// (v2rayNG, FlClash, Xray-core, clash-party...), whose trees are full of manifests and
// test fixtures that score as 'proxy'-ish names but contain zero nodes. Without this
// filter the picker spends 3 transports per junk file and the run publishes 2 nodes.
const SKIP_SEG = /^(release|packaging|windows|win32|macos|darwin|linux|android|ios|fastlane|electron|tauri|pkg|bundle|resources|locales?|i18n|translations?|langs?|tests?|testing|test\..*|specs?|__tests__|fixtures?|golden|mocks?|examples?|samples?|demo|demos|bench|benches|benchmarks?|src|libs?|internal|frontend|backend|apps?|packages|crates|plugins?|vendor|third[_-]party|node_modules|submodules?|icons?|build|dist|scripts?|deploy|docker|\.vscode|\.idea|\.github|\.gitlab|\.circleci|docs?|images?|img|assets|static)$/i;
// Manifests, lock files, linters, CI config: never node lists, but they sit at the repo
// root where the "must look like a list" hint rule cannot save us.
const SKIP_NAME = /^(readme|license|licence|changelog|contributing|code_of_conduct)(\.|$)|^(cmakelists\.txt|dockerfile|docker-compose\.ya?ml|pnpm-lock\.ya?ml|package-lock\.json|yarn\.lock|bun\.lockb|package\.json|go\.sum|go\.mod|pubspec\.(ya?ml|lock)|manifest\.json|project\.yml|electron-builder\.ya?ml|build\.ya?ml|\w*-builder\.ya?ml|biome\.json|lint_options\.ya?ml|analysis_options\.ya?ml|renovate\.json|dependabot\.ya?ml|tsconfig.*\.json|gradlew(\.bat)?|eslintrc.*|prettierrc.*|.*\.icon)$/i;

// Returns a numeric score, or null when the path is not a candidate at all.
export function scorePath(p, size) {
  const raw = String(p || '');
  const lower = raw.toLowerCase();
  const segs = lower.split('/');
  const base = segs[segs.length - 1];
  if (!base) return null;
  if (SKIP_FILE.test(base)) return null;
  if (SKIP_NAME.test(base)) return null;
  if (base.charAt(0) === '.') return null; // .pre-commit-config.yaml, .golangci.yml, ...
  for (const s of segs.slice(0, -1)) {
    if (SKIP_DIR.test(s) || SKIP_SEG.test(s)) return null;
  }
  const ext = path.posix.extname(base);
  const bytes = Number(size) || 0;
  // Extensions outside the allow-list are rejected, but an extension-less file such
  // as 'clash' or 'sub' is a normal subscription name and stays a candidate.
  if (ext && !DATA_EXT.test(base)) return null;
  const extScore = EXT_SCORE[ext] || 0;
  if (bytes < 400 || bytes > 8 * 1024 * 1024) return null;
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  const tokens = stem.split(/[^a-z0-9]+/).filter(Boolean);
  let score = extScore;
  let hinted = 0;
  for (const pair of NAME_HINTS) {
    const hint = pair[0];
    const weight = pair[1];
    const mode = pair[2];
    let hit = false;
    if (mode === 'token') hit = tokens.indexOf(hint) !== -1;
    else if (mode === 'first') hit = tokens.length > 0 && tokens[0].indexOf(hint) === 0;
    else hit = lower.indexOf(hint) !== -1;
    if (hit) { score += weight; hinted++; }
  }
  // The name has to look like a node list, at any depth. 'extension alone' is not
  // evidence: 'package.json', 'release/config/...json' and 'internal/sub/default.json'
  // are app configs that parse to zero nodes. A real list is 'sub', 'clash.yaml',
  // 'v2ray-nodes.txt', 'all.txt', ...
  if (!hinted) return null;
  if (score <= 0) return null;
  // prefer shallow paths, then the big aggregate files
  score -= Math.max(0, Math.min(3, segs.length - 1));
  if (bytes > 20 * 1024) score += 2;
  if (bytes > 200 * 1024) score += 2;
  return score;
}

// Same pick, but with the scores, so the caller can rank REPOS by "has a file that
// looks like a subscription" instead of trusting stars alone.
export function selectFiles(tree, opts) {
  const o = opts || {};
  const maxFiles = o.maxFiles || 3;
  const maxBytes = o.maxBytes || 8 * 1024 * 1024;
  const cands = [];
  for (const t of tree || []) {
    if (!t || t.type !== 'blob' || !t.path) continue;
    const size = Number(t.size) || 0;
    if (size < 400 || size > maxBytes) continue;
    const score = scorePath(t.path, size);
    if (score == null) continue;
    cands.push({ path: t.path, size, score });
  }
  cands.sort((a, b) => b.score - a.score || b.size - a.size || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const picked = cands.slice(0, maxFiles);
  // clash/yaml files carry the most metadata (cipher, network, reality keys), so make
  // sure one of them is inside the 3 picks when a plausible one exists.
  if (picked.length && !picked.some((c) => /\.ya?ml$/i.test(c.path))) {
    const y = cands.slice(maxFiles, maxFiles + 5).find((c) => /\.ya?ml$/i.test(c.path));
    if (y) {
      if (picked.length >= maxFiles) picked[maxFiles - 1] = y;
      else picked.push(y);
    }
  }
  return picked.map((c) => ({ path: c.path, size: c.size, score: c.score }));
}

export function selectPaths(tree, opts) {
  return selectFiles(tree, opts).map((c) => c.path);
}

// ---------- discovery ----------

function mergeItem(map, it, query) {
  const full = it.full_name;
  if (!full) return;
  let rec = map.get(full);
  if (!rec) {
    rec = {
      full_name: full,
      owner: (it.owner && it.owner.login) || full.split('/')[0],
      name: it.name || full.split('/')[1],
      stars: Number(it.stargazers_count) || 0,
      forks: Number(it.forks_count) || 0,
      pushed_at: it.pushed_at || null,
      updated_at: it.updated_at || null,
      created_at: it.created_at || null,
      archived: !!it.archived,
      disabled: !!it.disabled,
      fork: !!it.fork,
      default_branch: it.default_branch || null,
      description: it.description ? String(it.description).slice(0, 300) : '',
      size_kb: Number(it.size) || 0,
      parent: (it.parent && it.parent.full_name) || null,
      html_url: it.html_url || 'https://github.com/' + full,
      matched: [],
      listish: null,
      commit: null,
      files: [],
      drop_reason: null,
    };
    map.set(full, rec);
  }
  if (rec.listish == null) rec.listish = listishScore(rec);
  if (!rec.matched.includes(query)) rec.matched.push(query);
  // keep the freshest metadata we saw
  if (it.pushed_at && (!rec.pushed_at || it.pushed_at > rec.pushed_at)) rec.pushed_at = it.pushed_at;
}

// Cheap pre-rank signal for WHICH candidates deserve the ~25 commit checks allowed by the
// unauthenticated core quota (60/h). Sorting by stars alone spends the whole budget on the
// big *clients* (clash-verge-rev 153k*, v2rayNG 64k*, FlClash 57k*) whose trees contain no
// subscription file at all, so the list repos never get verified.
const LISTISH = /subscri|nodes?|clash|v2ray|vmess|vless|trojan|hysteria|shadowsocks|prox(y|ies)|free|configs?/i;
const CLIENTISH = /\b(client|gui|app|core|panel|server|agent|rule|adblock|vpn)\b/i;

export function listishScore(rec) {
  const hay = String(rec.full_name || '') + ' ' + String(rec.description || '');
  let s = 0;
  if (LISTISH.test(hay)) s += 2;
  if (/subscri/i.test(hay)) s += 2;
  if (/\bnodes?\b/i.test(hay)) s += 1;
  if (/\bfree\b/i.test(hay)) s += 1;
  if (CLIENTISH.test(String(rec.description || ''))) s -= 2;
  return s;
}

function preRank(a, b) {
  const as = a.listish == null ? listishScore(a) : a.listish;
  const bs = b.listish == null ? listishScore(b) : b.listish;
  if (bs !== as) return bs - as;
  if (b.stars !== a.stars) return b.stars - a.stars;
  const ap = a.pushed_at || '';
  const bp = b.pushed_at || '';
  if (ap !== bp) return ap < bp ? 1 : -1;
  return a.full_name < b.full_name ? -1 : a.full_name > b.full_name ? 1 : 0;
}

export function repoSummary(rec) {
  return {
    full_name: rec.full_name,
    stars: rec.stars,
    default_branch: rec.default_branch,
    pushed_at: rec.pushed_at,
    listish: rec.listish == null ? listishScore(rec) : rec.listish,
    commit: rec.commit ? { sha: rec.commit.sha, date: rec.commit.date } : null,
    files: rec.files ? rec.files.slice() : [],
    matched_queries: rec.matched ? rec.matched.slice() : [],
  };
}

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}

async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, p);
}

// The whole discovery unit. Returns a snapshot that is also what out/sources.json
// holds, so an --offline re-run can replay it byte for byte.
export async function discover(github, cfg) {
  const log = cfg.log || (() => {});
  const cacheFile = cfg.cacheFile;

  if (cfg.offline) {
    const saved = await readJson(cacheFile);
    if (!saved || !Array.isArray(saved.repos)) {
      throw new Error('offline mode needs a discovery snapshot at ' + cacheFile + ' (run once without --offline first)');
    }
    log('[1/8] offline: replaying discovery snapshot ' + cacheFile + ' (' + saved.generated_at + ', ' + saved.repos.length + ' repos)');
    // migrate a snapshot written before counts.recent became a number
    if (saved.counts && Array.isArray(saved.counts.recent)) {
      saved.recent_repos = saved.counts.recent.map(function (r) {
        return { full_name: r.full_name, stars: r.stars, commit_date: r.commit ? r.commit.date : null, best_score: r.best_score == null ? null : r.best_score, files: (r.files || []).slice(), drop_reason: r.drop_reason || null };
      });
      saved.counts.recent = saved.counts.recent.length;
    }
    return Object.assign({}, saved, { offline_replay: true });
  }

  const nowMs = Date.now();
  const cutoffMs = nowMs - cfg.recencyDays * 86400e3;
  const dateStr = cutoffDateString(cfg.recencyDays, nowMs);
  log('[1/8] discovery: ' + ALL_QUERIES.length + ' queries, pushed:>=' + dateStr + ', recency window ' + cfg.recencyDays + 'd');

  // ---- stage 1: searches ----
  const found = new Map();
  const queries = [];
  // Unauthenticated search is 10 requests/min, so paging deep is not affordable:
  // 12 queries x 3 pages would be 36 requests. One page per query keeps the whole
  // sweep inside a couple of minutes; MAX_PAGES still applies with a token.
  const pagesCap = github.token ? cfg.maxPages : Math.min(cfg.maxPages, 1);
  if (pagesCap < cfg.maxPages) {
    log('    unauthenticated: paging ' + pagesCap + ' page/query instead of ' + cfg.maxPages + ' (search rate limit 10/min)');
  }
  for (const q of ALL_QUERIES) {
    const qrec = { query: q, pages: 0, items: 0, total_count: null, error: null };
    for (let page = 1; page <= pagesCap; page++) {
      const qs = encodeQuery(q + ' pushed:>=' + dateStr);
      const res = await github.call(
        '/search/repositories?q=' + qs + '&per_page=100&page=' + page + '&sort=stars&order=desc',
        { search: true, ttlMs: 60 * 60 * 1000 },
      );
      qrec.pages++;
      if (res.status !== 200) { qrec.error = res.error || ('http ' + res.status); break; }
      const items = (res.json && res.json.items) || [];
      if (page === 1 && res.json && res.json.total_count != null) qrec.total_count = res.json.total_count;
      qrec.items += items.length;
      for (const it of items) mergeItem(found, it, q);
      if (items.length < 100) break; // results exhausted
    }
    queries.push(qrec);
    log('    search ' + JSON.stringify(q) + ' -> ' + qrec.items + ' items (' + qrec.pages + 'p)' + (qrec.error ? ' [' + qrec.error + ']' : ''));
    const searchStop = github.exhaustedFor('search');
    if (searchStop) { log('    search bucket stopped: ' + searchStop.reason); break; }
  }

  // ---- stage 1.4: seed the adopted-source registry ----
  // 花名册里的仓库必须每轮被重新验一遍，哪怕这轮搜索没把它带回来。否则「收录」就退化成
  // 「今天恰好搜到谁」：一个稳定产出节点的仓库会因为排名波动凭空消失，而它是否停更，
  // 恰恰只有真的去查一次默认分支才知道。
  let seeded = 0;
  for (const s of cfg.seedRepos || []) {
    const repo = typeof s === 'string' ? s : (s && s.repo);
    if (!repo || found.has(repo)) continue;
    found.set(repo, {
      full_name: repo,
      default_branch: (s && s.default_branch) || null,
      stars: (s && s.stars) || 0,
      from_registry: true,
    });
    seeded++;
  }
  if (seeded) log('    seeded ' + seeded + ' registry repos into the commit gate');

  // ---- stage 1.5: drop archived / disabled / fork duplicates ----
  const stage1 = { archived: 0, disabled: 0, fork_of_candidate: 0 };
  const eligible = [];
  const dropped = [];
  for (const rec of found.values()) {
    if (rec.archived) { rec.drop_reason = 'archived'; stage1.archived++; dropped.push(rec); continue; }
    if (rec.disabled) { rec.drop_reason = 'disabled'; stage1.disabled++; dropped.push(rec); continue; }
    if (rec.fork && rec.parent && found.has(rec.parent)) {
      rec.drop_reason = 'fork_of_candidate'; stage1.fork_of_candidate++; dropped.push(rec); continue;
    }
    eligible.push(rec);
  }
  log('[2/8] discovered ' + found.size + ' unique repos -> ' + eligible.length + ' eligible after stage 1 ' +
    '(archived ' + stage1.archived + ', disabled ' + stage1.disabled + ', forks ' + stage1.fork_of_candidate + ')');

  // ---- stage 2: default-branch commit recency gate ----
  // 在册的源排在最前面：commitCap 是有限资源，先保证「已经在看的」被验到，再看新候选。
  const ordered = eligible.slice().sort((a, b) =>
    (b.from_registry ? 1 : 0) - (a.from_registry ? 1 : 0) || preRank(a, b));
  const cap = Math.min(ordered.length, cfg.commitCap);
  let stale = 0;
  let verified = 0;
  let commitCacheHits = 0;
  // Default-branch commit verifications are cached on disk. Without a token the core API
  // allows 60 requests/hour, so a second local run inside that hour would otherwise burn
  // the entire budget re-checking repos it already checked a few minutes ago.
  const commitsFile = cfg.commitsFile || path.join(path.dirname(cfg.cacheFile), 'commits.json');
  const commitsTtlMs = cfg.commitsTtlMs == null ? 6 * 60 * 60 * 1000 : cfg.commitsTtlMs;
  let commitCache = {};
  try {
    const j = JSON.parse(await fs.readFile(commitsFile, 'utf8'));
    if (j && j.entries) commitCache = j.entries;
  } catch (e) { commitCache = {}; }
  for (const rec of ordered.slice(0, cap)) {
    const branch = rec.default_branch || 'HEAD';
    const hit = commitCache[rec.full_name];
    if (!cfg.refresh && hit && hit.branch === branch && hit.checked_at &&
        (Date.now() - Date.parse(hit.checked_at)) < commitsTtlMs) {
      commitCacheHits++;
      rec.commit = { sha: hit.sha || null, date: hit.date || null };
      rec.commit_cached = true;
      rec.commit_checked_at = hit.checked_at;
      verified++;
      const date = rec.commit.date;
      if (!date) { rec.drop_reason = 'commit_date_unknown'; dropped.push(rec); }
      else if (Date.parse(date) < cutoffMs) { rec.drop_reason = 'stale_default_branch'; stale++; dropped.push(rec); }
      else rec.drop_reason = null;
      continue;
    }
    const coreStop = github.exhaustedFor('core');
    if (coreStop) {
      rec.drop_reason = 'not_verified_api_stopped';
      dropped.push(rec);
      continue;
    }
    const res = await github.call(
      '/repos/' + rec.full_name + '/commits?per_page=1&sha=' + encodeURIComponent(branch),
      { ttlMs: 30 * 60 * 1000 },
    );
    if (res.status === 200 && Array.isArray(res.json) && res.json.length) {
      const c = res.json[0] || {};
      const date = (c.commit && c.commit.committer && c.commit.committer.date)
        || (c.commit && c.commit.author && c.commit.author.date)
        || null;
      rec.commit = { sha: c.sha || null, date: date };
      commitCache[rec.full_name] = {
        sha: c.sha || null, date: date, branch: branch, checked_at: new Date().toISOString(),
      };
      verified++;
      if (!date) { rec.drop_reason = 'commit_date_unknown'; dropped.push(rec); }
      else if (Date.parse(date) < cutoffMs) { rec.drop_reason = 'stale_default_branch'; stale++; dropped.push(rec); }
      else rec.drop_reason = null;
    } else if (res.status === 409) {
      rec.drop_reason = 'empty_repository'; dropped.push(rec);
    } else if (res.status === 404) {
      rec.drop_reason = 'not_found'; dropped.push(rec);
    } else {
      rec.drop_reason = res.error || ('http ' + res.status);
      dropped.push(rec);
    }
  }
  for (const rec of ordered.slice(cap)) {
    rec.drop_reason = 'not_verified_cap';
    dropped.push(rec);
  }
  const recent = ordered.filter((r) => r.commit && !r.drop_reason);
  log('[3/8] commit gate: verified ' + verified + '/' + cap + ' (cap ' + cap + '), recent ' + recent.length +
    ', stale(dropped) ' + stale + ', unverified ' + (ordered.length - cap) +
    ', from commit cache ' + commitCacheHits +
    (github.exhaustedFor('core') ? ' [core bucket stopped: ' + github.exhaustedFor('core').reason + ']' : ''));

  try {
    await writeTreeCache(commitsFile, { updated_at: new Date().toISOString(), entries: commitCache });
  } catch (e) { /* best effort */ }

  // ---- stage 3: tree -> file selection, then rank by "has a file that looks like a
  // subscription". Stars alone rank *clients* (v2rayNG, FlClash, Xray-core) above the
  // actual list repos, so the tree decides who is worth a fetch.
  const selected = [];
  const treeCacheDir = cfg.treeCacheDir || path.join(path.dirname(cfg.cacheFile), 'trees');
  let treeFetches = 0;
  const treeCap = Math.min(recent.length, Math.max(cfg.maxRepos * 2, cfg.maxRepos + 12));
  if (treeCap < recent.length) {
    log('    tree fetches capped at ' + treeCap + ' of ' + recent.length + ' recent repos (core budget)');
  }
  let treeCacheHits = 0;
  for (const rec of recent.slice(0, treeCap)) {
    const branch = rec.default_branch || 'HEAD';
    const cachePath = path.join(treeCacheDir, rec.full_name.replace('/', '__') + '.json');
    let tree = null;
    if (cfg.offline || github.exhaustedFor('core')) {
      const cached = await readTreeCache(cachePath);
      if (cached) { tree = cached; treeCacheHits++; rec.tree_from_cache = true; }
      else if (github.exhaustedFor('core')) break;
    }
    if (!tree) {
      const res = await github.call(
        '/repos/' + rec.full_name + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1',
        { ttlMs: 6 * 60 * 60 * 1000 },
      );
      treeFetches++;
      if (res.status !== 200 || !res.json || !Array.isArray(res.json.tree)) {
        rec.drop_reason = res.error || ('tree_http_' + res.status);
        dropped.push(rec);
        continue;
      }
      tree = res.json;
      await writeTreeCache(cachePath, {
        fetched_at: new Date().toISOString(),
        full_name: rec.full_name,
        branch,
        truncated: !!tree.truncated,
        tree: tree.tree,
      });
    }
    rec.tree_truncated = !!tree.truncated;
    const picked = selectFiles(tree.tree, { maxFiles: cfg.maxFiles, maxBytes: cfg.maxFileBytes });
    if (!picked.length) {
      rec.drop_reason = 'no_subscription_file';
      dropped.push(rec);
      continue;
    }
    rec.files = picked.map((c) => c.path);
    rec.file_scores = picked.map((c) => ({ path: c.path, score: c.score, bytes: c.size }));
    rec.best_score = picked.reduce((m, c) => Math.max(m, c.score), 0);
    selected.push(rec);
  }
  // rank the repos that actually carry list-like files: file score first, stars second
  selected.sort((a, b) => (b.best_score || 0) - (a.best_score || 0) || b.stars - a.stars ||
    (a.full_name < b.full_name ? -1 : a.full_name > b.full_name ? 1 : 0));
  while (selected.length > cfg.maxRepos) {
    const rec = selected.pop();
    rec.files = [];
    rec.drop_reason = 'max_repos_reached';
    dropped.push(rec);
  }
  for (const rec of recent) {
    if (!rec.files.length && !rec.drop_reason) {
      const coreStop = github.exhaustedFor('core');
      rec.drop_reason = coreStop ? ('api_stopped:' + coreStop.reason) : 'max_repos_reached';
      dropped.push(rec);
    }
  }

  log('[4/8] selected ' + selected.length + ' repos, ' + selected.reduce((n, r) => n + r.files.length, 0) + ' files' +
    ' (tree fetches ' + treeFetches + ', from tree cache ' + treeCacheHits + ')');

  const snapshot = {
    generated_at: new Date().toISOString(),
    recency_days: cfg.recencyDays,
    cutoff: isoDate(cutoffMs),
    cutoff_date: dateStr,
    authenticated: !!github.token,
    queries,
    api: github.stats(),
    counts: {
      discovered: found.size,
      eligible_stage1: eligible.length,
      commit_verified: verified,
      recent: recent.length,
      stale_dropped: stale,
      unverified_cap: ordered.length - cap,
      selected: selected.length,
      files: selected.reduce((n, r) => n + r.files.length, 0),
    },
    repos: selected.map(repoSummary),
    // every repo that PASSED the 5-day gate but did not make the cut (kept for debugging;
    // out/sources.json uses counts.recent for the number and this list for the detail)
    recent_repos: recent.map(function (r) {
      return { full_name: r.full_name, stars: r.stars, commit_date: r.commit ? r.commit.date : null, best_score: r.best_score == null ? null : r.best_score, files: (r.files || []).slice(), drop_reason: r.drop_reason || null };
    }),
    // every dropped repo keeps its reason and its default-branch commit date
    dropped: dropped.map((r) => ({
      full_name: r.full_name,
      stars: r.stars,
      pushed_at: r.pushed_at,
      reason: r.drop_reason || 'unknown',
      commit: r.commit ? { sha: r.commit.sha, date: r.commit.date } : null,
      commit_date: r.commit ? r.commit.date : null,
      matched_queries: r.matched ? r.matched.slice() : [],
    })),
  };
  if (cacheFile) await writeJson(cacheFile, snapshot);
  return Object.assign({}, snapshot, { offline_replay: false });
}
