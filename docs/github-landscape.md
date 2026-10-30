# GitHub 代理订阅仓库调研：批量抓取 + Actions 定时发布

调研日期 2026-10-26（星数取自同一天的搜索快照，会随时间浮动）。

目标：搞清楚「最高星、且真的在 GitHub Actions 里批量抓代理并定时发布」的仓库是怎么做的，
哪些做法值得移植到本仓库（`pipeline.mjs` 九段式流水线），哪些是必须避开的坑。

---

## 0. 结论先行

1. **星数不等于工程实现。** 43k / 19.6k / 17.1k / 14.5k / 7.0k 这五个最头部的仓库，
   默认分支上**没有任何公开流水线**，其中 43k 那个已经停更、19.6k 那个只有 README 和订阅文件。
   真正在跑的工程集中在 **1.5k–9.4k** 这一段。
2. **自动化成熟度可以分四档（见 §3），多数仓库停在 L1「合并即发布」。**
   只有 3 个仓库做到了「配置引擎级验证」这一档：awesome-vpn、ClashX-V2Ray-TopFreeProxy，
   以及本仓库。
3. **最值得抄的三件事**：
   ① 发布前用**真实引擎**校验产物 + 「本次产出太小就不发布、保留上一版」（`health.json` / `min_retained_ratio`）；
   ② **每源健康台账**，连续空跑自动禁用（awesome-vpn 的 `MAX_CONSECUTIVE_FAILURES = 3`）；
   ③ 对外分发走 CDN 时，提交后**批量 purge**（jsDelivr 默认缓存 12 小时）。
4. **最该避的三件事**：
   ① 零验证的高频提交（15–17 分钟一次）；
   ② 孤儿分支强推（省体积但丢掉「上一版」，不可回滚、不可审计）；
   ③ 把「发布」和「任务成败」绑死——一个坏节点让整轮白跑（我们 CI 日志里的
   `provider load test failed, refusing to publish` 就是这种耦合的极端形式，所以
   ClashX 的「**先发布好数据、再让 job 失败**」值得抄）。
5. **本仓库在 L4 一档**，且有两个别人没有的东西：**格式预检**（`lib/adapter.mjs`，在探测前
   把 mihomo 解析不了的字段挡掉）与**双通道**（mihomo `-t` 整份配置 + provider load test）。
   我们缺的是「**可观测性**」（health.json）与「**防缩水**」（min_retained_ratio）。

---

## 1. 方法与数据

- 数据来源：GitHub 搜索 API（`topic:proxy-list`、`v2ray configs`、`proxy subscriptions` 等），
  结果快照落地在 `.verify/gh5.json`、`.verify/gh6.json`。
- **匿名 API 限额是 60 次/小时**，几分钟就会 403（`API rate limit exceeded for 198.2.214.3`）。
  所以看代码不靠 API，靠**无 blob 克隆**：

  ```bash
  git clone -q --depth 1 --filter=blob:none --no-checkout --branch <branch> \
    https://github.com/<owner>/<repo>.git .verify/research/gh-lead/<owner>_<repo>
  git -C <dir> ls-tree -r --name-only HEAD          # 文件树（不下载内容）
  git -C <dir> cat-file -p HEAD:.github/workflows/main.yml   # 按需取单个文件
  ```

  一个仓库几秒钟，几十个仓库也不吃 API 配额。
- 反面教材：**GitHub 的仓库目录页不再内联文件列表**（react 的 `embeddedData` 里没有 items），
  抓 HTML 拿不到目录树，只能拿到 README 渲染结果。
- 队友下载的完整 tarball 留在 `.verify/research/gh-a/`（Pawdroid / clashfree / v2rayfree）
  与 `.verify/research/gh-b/`（chengaopan / SubCrawler / proxypool），作为交叉验证。

---

## 2. 对比总表

| 仓库 | ★ | 更新节奏 | 公开流水线 | 验证深度 | 发布通道 |
| --- | ---: | --- | --- | --- | --- |
| freefq/free | 43.0k | 2024-02 后停更 | 无 | — | 2 个文件 |
| Pawdroid/Free-servers | 19.6k | 每日 | **无** | — | 订阅文件 |
| free-nodes/clashfree | 17.1k | 每日 | **无** | — | `clashYYYYMMDD.yml` |
| free-nodes/v2rayfree | 14.5k | 每日 | **无** | — | `vYYYYMMDD` |
| ermaozi/get_subscribe | 9.4k | 12h | 有 | L1.5 TCP + 三档分类 | 提交 `subscribe/`、`log/` |
| chengaopan/AutoMergePublicNodes | 8.3k | 3h | 有 | L1 合并即发布 | 提交 + jsDelivr purge |
| proxifly/free-proxy-list | 7.0k | — | **无** | — | 按国家切片的 csv/json/txt |
| awesome-vpn/awesome-vpn | 6.8k | 每日 | 有 | **L4** sing-box check + 双引擎实测 + 质量分 | 提交 + release + 多格式 |
| VPN-Subcription-Links/ClashX-V2Ray-TopFreeProxy | 5.7k | 8h | 有 | **L4** 固定版 mihomo + 防缩水 | 提交 + release + health |
| Epodonios/v2ray-configs | 3.3k | 17 分钟 | 有 | L0 零验证 | 提交 |
| barry-far/V2ray-Config | 2.6k | 15 分钟 | 有 | L0 零验证 | 提交 |
| snakem982/proxypool | 2.2k | 每日 4 次 | **代码未公开** | — | 孤儿分支 |
| Leon406/SubCrawler | 1.6k | 5h | 有 | L2 Kotlin 协程 TCP + 负缓存 | 提交 |
| mfuu/FreeProxies | 930 | 每日 3 次 | 有 | L1 subconverter 合并 | 孤儿分支强推 |
| **本仓库 pussies_fucker** | — | 6h | 有 | **L4** adapter 预检 + probe + provider test | 提交 + release + 大陆实测 |

---

## 3. 成熟度分级

| 档位 | 判据 | 代表 |
| --- | --- | --- |
| **L0** 数据仓库 | 只有数据，没有可复现的生成过程 | freefq/free、clashfree、v2rayfree、proxifly |
| **L1** 抓取合并 | 抓 → 解析 → 去重 → 提交，**不验证可达性** | chengaopan、mfuu、Epodonios、barry-far |
| **L2** TCP 存活 | `socket.connect` 掉不可达的，但「端口通」≠「能用」 | SubCrawler、ermaozi（分类而非删除） |
| **L3** 真实连通 | 起代理进程，真的发一次 HTTP 请求（`generate_204`） | awesome-vpn（单节点独立进程） |
| **L4** 配置引擎 + 真实连通 | 先让**目标客户端引擎**解析整份配置，再实测 | awesome-vpn、ClashX、**本仓库** |

关键区别在 L3→L4：L3 能证明「这个节点能上网」，但不能证明「我们生成的这份配置能被 mihomo
加载」。CI 里 `POOL: '14' not found`、`cipher: null`、`invalid REALITY public key`
都属于「节点本身没问题、配置写错了」——只有 L4 拦得住。

---

## 4. 逐仓库档案

### 4.1 无公开实现的一组（最反常识）

| 仓库 | 事实 |
| --- | --- |
| `freefq/free` 43.0k | 仓库只有 2 个文件，最后提交 `2024-02-07`，实质停更。 |
| `Pawdroid/Free-servers` 19.6k | 只有 `README.md` + 28 种语言 `docs/` + `static/` + `sub`；`ls -a` 确认无 `.github/workflows`。 |
| `free-nodes/clashfree` 17.1k | 每日一个 `clashYYYYMMDD.yml` + `sub.yml`，无代码。 |
| `free-nodes/v2rayfree` 14.5k | `sub` + 每日 `vYYYYMMDD`，无代码。 |
| `proxifly/free-proxy-list` 7.0k | 只有 `proxies/`（按国家切片 `data.csv/json/txt`）+ README，**无 workflow**；生成器不在公开仓库里。 |
| `snakem982/proxypool` 2.2k | 默认分支只有 `source/`（`clash-meta-2.yaml`、`sing-box-2.json` 等产物）与 `reset_repo.sh`（孤儿分支强推脚本）；README 声明每日 8/12/18/22:15 更新，但代码未公开。 |

教训：这些仓库的高星来自「订阅链接好用」，与流水线质量无关。**评估同类项目别看星，看有没有
`.github/workflows` 和产物校验步骤。**

### 4.2 chengaopan/AutoMergePublicNodes 8.3k —— 跟上游代码、留自己的调度

`.github/workflows/fetch.yml`
- cron `17 */3 * * *`；`push.paths` 只盯 `sources.list`、`config.yml`、`abpwhite.txt`、`**.py`、
  `snippets/_*`——改配置就自动重跑，改 README 不会。
- 流程：`python ./fetch.py`（1564 行，**每个源一个线程**，`join(timeout=FETCH_TIMEOUT[1])`）→
  `git pull origin master` → `git add list* snippets/` → commit `$(date '+%Y-%m-%d %H:%M:%S') 抓取节点`
  → `ad-m/github-push-action`。
- 提交后**批量 purge jsDelivr**：拼 `{"path":[url,...]}` 一次 POST `https://purge.jsdelivr.net/`，
  `continue-on-error: true`，注释写明「清除失败可忽略，jsDelivr 12 小时内会自动刷新」。

`.github/workflows/sync.yml`
- cron `23 3 * * *`（刻意与抓取错开）；`git fetch --depth=1 upstream master`
  （上游 `peasoft/NoMoreWalls` 历史极大，只取最新快照）；`git checkout upstream/master -- <白名单文件>`
  只覆盖代码/规则/源列表；随后 `git diff --quiet -- .github/workflows/fetch.yml` 不通过就 `exit 1`
  （**防止上游改掉我们自己的 cron**）；最后 `git pull --rebase origin master || true` 再 push。

`fetch_config.yml`：`stop` 总开关、`name_show_src`（节点名带来源编号）、`abfurls`（AdGuard 系
adblock 列表，兼做钓鱼落地页过滤）、`abfwhite` 白名单、`categories`（redir/JP/US/TW/CN…关键词
→ 生成分地区 snippet）。

可抄点：① 代码与调度分离（fork 上游、只保自己的 cron）；② 12h CDN 缓存必须主动 purge；
③ 用 AdGuard 黑名单同时过滤广告域名和钓鱼落地页。

### 4.3 ermaozi/get_subscribe 9.4k —— 分类而不是丢弃

`.github/workflows/main.yml`：cron `0 */12 * * *`，`TZ=Asia/Shanghai`，`timeout-minutes: 20`；
先 `python -m unittest discover -s tests` 和 `node --test worker/sub.test.mjs`，再 `main.py`、
`check_nodes.py`，最后只提交 `subscribe/` 与 `log/`（`git diff --cached --quiet && exit 0`）。

`check_nodes.py`：
- `TIMEOUT = 3`、`WORKERS = 24`；`UDP_TYPES = {hysteria, hysteria2, hy2, tuic, wireguard, mieru}`
  ——UDP 协议**不打 TCP**（打了必然「不可达」，误杀）。
- `endpoint()` 解 vmess（base64 JSON 的 add/port）、ssr、ss（无 `@` 时 base64 解）。
- `tcp_status()` 只探测 `ipaddress.ip_address(...).is_global` 的地址——**防内网/云元数据 SSRF**。
- 输出三档：`subscribe/{reachable,unreachable,untested}/clash.yml`。

可抄点：① 三档输出比「删掉」信息量大，下游可以自己选信任级别；② 探测前先 `is_global` 过滤；
③ 每次运行留 `log/YYYY-MM.log`，几个月后还能查「这个源什么时候开始不稳」。

### 4.4 VPN-Subcription-Links/ClashX-V2Ray-TopFreeProxy 5.7k —— 发布门禁最细

`.github/workflows/update.yml`
- cron `0 */8 * * *`；`if: github.event_name == 'workflow_dispatch' || github.repository == '…'`
  ——**只有本仓库能发布**，fork 跑一次不会往任何地方推。
- 顺序：单测 → `python -m combine.install_engine` 装**固定版本** mihomo →
  `python -m combine.refresh --mihomo …`（`continue-on-error: true`）→ health 工件 `if: always()` 上传 →
  只 `git add` 8 个产物文件，有变化才 commit → `publish.sh` → 最后一步
  `if: steps.refresh.outcome == 'failure'` 执行 `exit 1`。
- **「先发布好数据、再让 job 红」** 是这里最值钱的一条：坏源不会打断发布，但问题依然可见。

`combine/health.json`（机器可读的健康档案）
```json
{ "checked_at": "...", "published": false,
  "last_successful_publication": "...", "connectivity_tested": false,
  "errors": ["Mihomo configuration test failed (exit 1); previous subscriptions retained"],
  "engine_validation": { "engine": "mihomo", "status": "failed" },
  "merged_entries": { "clash": 2555, "v2ray": 1461 },
  "previous_entries": { "...": "..." },
  "min_retained_ratio": 0.5,
  "sources": [ { "id": "...", "status": "failed", "parsed_entries": 0,
                 "last_valid_url": "...", "attempts": [ { "status": "fetch_failed" } ] } ] }
```
- `published: false` + `errors` 说明这一轮**故意没发**，旧文件还在——这就是「保留上一版」。
- `min_retained_ratio: 0.5`：新合并量不到上一次的 50% 就拒绝发布（防上游崩一半把订阅发空）。

`combine/refresh.py resolve_feed()`：日期模板源按 day-0 → day-1 → day-2 依次试，再退到
`last_valid_url`，再退到配置里的 URL；每次尝试都记 `status: parsed | fetch_failed | unusable`。

`check.yml`（push/PR）：对**已提交的产物**跑一遍引擎校验——防止有人手改产物直接进主干。

可抄点：① 防缩水比例门禁；② health.json 既是给人看的徽章数据，也是给脚本用的状态；
③ 固定版引擎（版本漂移会让「昨天能过的配置今天过不了」）。

### 4.5 awesome-vpn/awesome-vpn 6.8k —— 工程完成度最高

`.github/workflows/daily.yml`
- cron 每日 00:00；`concurrency: group: daily-crawler, cancel-in-progress: false`；
  先 `pytest` 再 crawl（`needs: test`），`timeout-minutes: 60`。
- 二进制缓存：`bin/` + key `sing-box-${{ runner.os }}-${{ runner.arch }}-${{ env.SING_BOX_VERSION }}`；
  GeoLite2 **按月缓存**（key 带 `month`），下载失败 `|| echo "… will use ipinfo.io fallback"` 降级。
- 验证步：产物非空 → `sing-box check -c sing-box.json` → python 断言 tag 唯一 →
  节点数 <10 或 >50 报警 → REALITY/WS 抽样审计；工件 `if: always()`。
- 提交：`git diff --staged --quiet || git commit -m "update: … [skip ci]"`。

`core/` 架构
- `harvesters/`：Telegram 频道走 `t.me/s/<channel>` 网页版（不用 API、不用 token）+ 顺着频道
  互相转发的提及扩展拓扑；GitHub 雷达走 `raw.githubusercontent.com` 并记录每仓健康度
  （`consecutive_failures`、`total_yielded`、`last_success_at`，`MAX_CONSECUTIVE_FAILURES = 3`
  后自动禁用并写 `disabled_reason`）；静态 feed 支持日期模板 + `max=N` / `ignore=protocol` 参数。
- `filters/prescreen.py`：协议权重 `{hysteria2:100, hy2:100, tuic:90, vless:80, trojan:70, ss:50, vmess:40}`，
  UDP 协议跳过 TCP 预筛，400 个验证候选上限。
- `filters/honeypot.py`：私网/保留段（`10/8`、`127/8`、`169.254/16`、`100.64/10`…）、
  公共 DNS 假 IP（`8.8.8.8`、`1.1.1.1`、`114.114.114.114`…）、大厂域名
  （`.google.com`、`.github.com`、`.baidu.com`、`localhost`…）一律判蜜罐。
- `dual_validator.py`：**每个节点一个进程**——`bind 127.0.0.1:0` 取空闲端口、
  `Popen` 起引擎、`wait_for_port(3s)`、真 GET `generate_204`；线程池并发；
  还做了 `detect_physical_interface()` 绕开 TUN。
- `quality.py`：端口加权（443 +10、常见 8443/2053/2083 +6、>10000 −2）、无 TLS −5、
  有 SNI +4、热门 SNI +3、REALITY +12、utls +3，最后按分取 Top-N。
- `node_ledger.py`：节点台账，`MAX_RETENTION_SECONDS = 14*86400`，连续存活有加成。
- `matrix/exporter.py`：一次产出 sing-box.json / clash.yaml / raw / 按协议 / base64 五种格式。

可抄点：① 每节点独立进程验证（我们是一条配置批量 probe，快但「一个坏节点整份 parse 失败」，
   我们已用 adapter 预检兜住）；② 质量分排序取 Top-N（我们目前只按 rtt）；③ 节点台账。

### 4.6 Leon406/SubCrawler 1.6k —— Kotlin 的兜底方案

`.github/workflows/ci.yml`：cron `0 0/5 * * *`，缓存 `~/.gradle`、`~/.m2`；
把抓取写成 Gradle 测试执行：`./gradlew :test --tests "me.leon.NodeCrawler.crawl"`，然后 `up.sh` 提交。

`src/main/java/me/leon/support/Net.kt`
- `Socket().connect(InetSocketAddress(host, port), timeout=1000)`；`passes`/`fails` 内存集合 +
  `FAIL_IPS` 文件级**永久负缓存**（失败过的 `ip:port` 以后不再试）。
- `ConnectTest.kt` 用协程 `async(DISPATCHER)` 并发 `quickConnect(2000)`。
- `GeoParser.kt` + 内置 `GeoLite2-Country.mmdb`（不打网络，出国家名/旗帜）。

坑：`up.sh` 直接 `git add . && git commit && git push`——没有变更时 `git commit` 非零退出，
整个 job 变红。我们的 workflow 用 `git diff --cached --quiet` 判断，天然躲开。
（负缓存也要配 TTL，否则误杀已恢复的节点。）

### 4.7 吞吐型：Epodonios/v2ray-configs 3.3k、barry-far/V2ray-Config 2.6k

同源模板：`Files/app.py`（requests 拉源 + pybase64 解码，`TIMEOUT=15`）+ `Files/sort.py`
（把全量切成固定条数的文件），`EndBug/add-and-commit@v7` 提交；cron 分别是 `*/17` 与 `*/15` 分钟。
**零验证**，价值只在「切分文件」便于客户端增量拉取。

### 4.8 mfuu/FreeProxies 930

每日 3 次；下载 subconverter 二进制，`nohup` 后台起本地 HTTP 服务，`utils/sub_merge.py`
把各源转成统一订阅；第二个 job 用孤儿分支
（`git checkout --orphan latest_branch && git branch -D master && git branch -m master && git push -f`）
保持仓库只有一次提交。零验证；孤儿分支的代价是**没有上一版**，出问题无法回滚、无法对比。

---

## 5. 反模式清单

1. **高频零验证**（15 分钟一提交）：仓库膨胀，用户拿到一堆死节点，验证成本转嫁给下游。
2. **孤儿分支强推**：省体积，但丢掉「上一版」，出问题无法回滚/对比审计。
3. **无变更也 commit**：`git commit` 无内容会非零退出，把整条 job 弄红（SubCrawler `up.sh`）。
4. **拿 GitHub Search API 做发现**：匿名 60 次/小时，一跑就 403（我们本地已踩到）。
5. **每次运行都下载引擎二进制**：版本漂移 + 上游 API 403 就把流水线带崩（我们 CI 日志里
   `no mihomo binary … trying the latest release download` 后接 API 403 正是这条路径）。
6. **只判「进程起来了」不判「配置能加载」**：`POOL: '14' not found`、`cipher: null`、
   `invalid REALITY public key` 会一路漏到用户。
7. **raw.githubusercontent 分发却不 purge CDN**：12 小时内用户拿旧文件。

---

## 6. 对本仓库的落地建议

现状（本地 `node pipeline.mjs --ci` 跑通的一轮，2026-10-26 11:32Z）：
28 个文件 / 25,817 条原始 → 去重 4,242 → 适配过滤后 TCP 存活 1,149 → probe 候选 400 →
实测通过 14 → provider test OK（14 条全部可被 mihomo 加载）。

### 6.1 我们已经领先的地方

- **格式预检**（`lib/adapter.mjs`）：在探测之前把 mihomo 解析不了的字段挡掉——避免 30 次
  重试预算被一个 `cipher: null` 的节点烧光（这正是最初 CI 失败的根因之一）。
- **双通道校验**：`mihomo -t`（整份配置结构）之后还有 provider load test（作为 provider 再解析
  一次），两步都过才发布（`pipeline.mjs:673-718`）。
- **失败即拒绝发布** + 原子写（`writeTextAtomic`）：不会留下半写文件。
- **中国大陆实测第二档**（`verify-cn` + self-hosted runner）：调研的所有仓库里没人这么做。

### 6.2 建议采纳（按优先级）

**P0-1 防缩水门禁**（ClashX `min_retained_ratio`）
发布前读上一版 `out/nodepool.yaml` 的条数，本次 kept < 50% 时直接失败并保留旧产物，
在 `report.json` 里写明 `retention_ratio`。防的是「上游大面积失效 → 发出一份 3 条节点的订阅」。

**P0-2 `out/health.json`**（ClashX `health.json`）
每次运行落盘：
```json
{ "checked_at": "...", "published": true, "engine": "mihomo v1.19.33",
  "last_successful_publication": "...", "counts": { "kept": 14, "tcp": 1149, "probe": 14 },
  "probe": { "tested": 400, "verified": 14, "skipped": false },
  "provider_test": { "ok": true, "dropped": [] },
  "retention_ratio": 0.87 }
```
workflow 里跟 `out/` 一起提交；README 徽章和故障排查都读它。

**P1-1 源健康台账**（awesome-vpn `github_radar`）
`registry/` 每条源加 `ok / empty / error` 计数、`last_success_at`、`disabled_reason`；
连续 3 次空/抓取失败自动禁用并记录原因（我们现在只记 `added/removed/unverified`）。

**P1-2 引擎二进制缓存 + 固定 URL**（awesome-vpn / ClashX）
把 mihomo 下载改成 `https://github.com/MetaCubeX/mihomo/releases/download/v1.19.33/<固定资产名>`，
workflow 加 `actions/cache`（key 带版本 + `runner.os`）；GeoLite2 按月缓存。
**直接断掉**「匿名 API 403 → 无二进制 → 跳过 probe」这条我们真实踩过的失败路径。

**P1-3 分档输出**（ermaozi 三档思路）
`out/nodes.txt`（实测通过）+ `out/nodes-tcp.txt`（仅 TCP 可达、未实测），
订阅方按需取；同时在 `report.json` 标注每档条数。

**P2-1 节点台账**
`cache/probe.json` 已有历史（本地缓存年龄 63,036s 的一轮直接复用了 14/400），
再加「连续 N 轮存活」加权排序，优先留长寿节点（awesome-vpn `node_ledger`）。

**P2-2 质量分**
在 `rtt_ms` 之外加入：443 端口加分、TLS/REALITY/热门 SNI/utls 加分，用于 Top-N 取舍。

**P2-3 jsDelivr purge**
若对外提供 `cdn.jsdelivr.net/gh/<repo>@main/out/nodes.txt` 这类链接，每次提交后批量 POST
`https://purge.jsdelivr.net/`（一次请求清所有文件，失败忽略，12h 兜底）。

**P3 仓库体积**
`out/` 每天提交会让 master 膨胀；可选「产物只进 release + 定期 squash」，但**不建议**孤儿分支
（会丢掉我们刻意保留的 `registry/` 审计历史）。

### 6.3 不建议照抄

- **每节点起独立进程**（awesome-vpn `dual_validator`）：400 节点 × 进程启动在 Actions 上太贵；
  我们「一份配置 + `/proxies/<name>/delay`」已经够用，且有 adapter 兜底。
- **15 分钟级刷新**：新颖度收益极低，代价是 GitHub 用量与死节点比例。
- **subconverter 中转**：多一层外部依赖与信任面；我们的 `lib/emit.mjs` 已经直接产出 provider 格式。
- **孤儿分支强推**：与「registry 审计历史」目标冲突。

---

## 7. 复现命令

```bash
# 1) 看某个仓库的文件树与某个文件（不耗 API 配额）
git clone -q --depth 1 --filter=blob:none --no-checkout https://github.com/awesome-vpn/awesome-vpn.git /tmp/av
git -C /tmp/av ls-tree -r --name-only HEAD | head -50
git -C /tmp/av cat-file -p HEAD:core/dual_validator.py | head -80

# 2) 看 stars 排序（会消耗 API 配额）
curl -s 'https://api.github.com/search/repositories?q=topic:proxy-list+stars:>500&sort=stars&per_page=100' | jq '.items[]|{full_name,stargazers_count}'

# 3) 本仓库跑一轮
node pipeline.mjs --offline --reuse-raw --reuse-liveness --max-probe 120
```

---

## 8. 数据来源

| 内容 | 位置 |
| --- | --- |
| 搜索结果快照 | `.verify/gh5.json`、`.verify/gh6.json`、`.verify/gh-proxy.json` |
| 无 blob 克隆（12 个仓库） | `.verify/research/gh-lead/` |
| 队友 tarball（交叉验证） | `.verify/research/gh-a/`、`.verify/research/gh-b/` |
| 本仓库最近一轮报告 | `out/report.json` |
