# nodepool — 公共免费节点订阅聚合器

从 GitHub 上**主动公开**的免费节点订阅仓库抓取节点，做供应链安全过滤与存活性预筛，
输出一份 Mihomo/Clash 的 provider 文件，并配套一份**含本地绕行规则**的配置片段。

> 本工具只抓取仓库作者主动公开、供任何人使用的订阅，不做任何破解或私密抓取。
> 免费节点仍然是**陌生人的服务器**，请务必读完文末「局限与风险」。

## 快速开始

```bat
git clone https://github.com/qwqlemon2333/pussies_fucker.git
cd pussies_fucker
node pipeline.mjs
```

一条命令跑完整个流水线。依赖：Node >= 18 + Windows 自带的 `curl.exe`。
不需要 `npm install`，没有任何第三方 JS 依赖（只用 Node 标准库）。

## 目录与产物

| 路径 | 内容 |
| --- | --- |
| `out/nodepool.yaml` | **主产物**：以 proxies 开头的 provider 文件（CI 每 6 小时重生成并发布） |
| `out/nodepool.patch.yaml` | 配置片段：provider + POOL 组 + 本地绕行规则 + `MATCH,POOL` 兜底 |
| `out/nodes.txt` | 同样的节点导出为 URI 列表，给 v2rayN / NekoBox 等客户端 |
| `out/sources.json` | 本次发现的数据源证据：命中的仓库、默认分支最新提交时间、**每个被丢弃仓库的原因与提交日期** |
| `out/report.json` | 本次运行的真实统计（抓了多少、解析多少、丢弃原因、TCP/真实代理验证数） |
| `registry/sources.json` | **源花名册**：被收录的仓库、每轮验证结果、被除名的原因（随 commit 一起回写，git 历史即审计日志） |
| `out/local.yaml` | 本地轻量优选（local-pick.mjs）的产物：只含幸存者的 provider 片段，给 Clash Verge 当 proxy-provider 用 |
| `out/local-report.json` | 本地优选的每阶段数字 + 每个节点每轮的通过情况 |
| `raw/` | 抓取到的原始订阅字节（不修改，便于复现） |
| `cache/` | GitHub API 响应 / 发现快照 / 存活探测缓存的磁盘缓存（CI 里由 actions/cache 保存） |

## 粘进 Clash Verge / mihomo

1. 把 `mihomo/providers/nodepool.yaml` 拷到你的 mihomo 配置目录下的 `providers/` 里。
   Clash Verge Rev 一般是右键托盘配置 → 打开文件夹，路径类似 %APPDATA%\io.github.clash-verge-rev.clash-verge-rev\。
2. 打开 `mihomo/nodepool.patch.yaml`，把 proxy-providers / proxy-groups / rules 三段
   分别粘进你的 config.yaml 对应段落（已有同名段就合并，不要整段覆盖）。
3. 重载配置。策略组里出现 POOL（url-test，每 300 秒用 https://api.github.com/ 测延迟）。
4. 规则结尾是 `MATCH,POOL`：**POOL 现在是全部流量的默认出口**，
   整机上网速度/稳定性 = 当前最快的那一个免费节点。

> **请先想清楚再启用。** `MATCH,POOL` 意味着你打开的任何站点都走陌生人的服务器：
> HTTPS 内容仍有机密性，但 SNI、DNS、流量特征、以及你访问了哪些站点对节点运营者完全可见，
> 且节点可以随时断流或注入数据。**不要用它登录网银/公司系统/重要账号。**
> 如果你只想要「开发者域名走 POOL、其余直连」，把最后一行 `MATCH,POOL` 改成 `MATCH,DIRECT`。

> `MATCH,POOL` 之前保留了一组本地绕行规则（127/8、10/8、172.16/12、192.168/16、
> 169.254/16、100.64/10、::1、fc00::/7、fe80::/10、`DOMAIN-SUFFIX,local` 等）。
> 没有它们，回环和局域网流量也会被塞进代理，本地 NAS/打印机/调试端口会直接坏掉。
> 其中 `GEOIP,PRIVATE` / `GEOIP,LAN` 需要 mihomo 的 geoip 数据库；
> 若你的构建里没有 geoip.metadb，删掉这两条即可，CIDR 规则仍然覆盖同样的地址段。

## CI 模式

这个工具现在由 **GitHub Actions 驱动**：不需要你开着电脑，workflow 每 6 小时自己跑一遍
「发现 → 抓取 → 解析 → 安全过滤 → 去重 → 存活/TCP 预筛 → 真实代理验证 → 发布」。

### 5 天新鲜度闸门（硬性要求）

一个源仓库只有在**默认分支最近 5 天内有提交**时才会被采用，这是两道真实的检查，不是摆设：

1. 第一道：GitHub 搜索接口带 `pushed:>=YYYY-MM-DD`，按 `full_name` 去重，
   并且丢掉 archived / disabled / 只是别人 fork 的重复仓。
2. 第二道：对候选仓再请求 `GET /repos/{owner}/{repo}/commits?per_page=1`（**默认分支**），
   拿到真实的最新提交 `{sha, date}`。如果这个日期比 5 天前更早，**直接丢弃**——
   哪怕 `pushed_at` 看起来很新。原因：往侧分支推一次代码也会刷新 `pushed_at`，
   但默认分支可能已经几个月没动了，那种仓库里的订阅基本都是死的。

窗口可以用环境变量 `RECENCY_DAYS` 覆盖（默认 `5`），
workflow_dispatch 也提供了同名输入。每个被丢弃的仓库及其默认分支提交日期，都写在 `out/sources.json` 的 `dropped` 数组里。

### 定时任务

`.github/workflows/nodepool.yml`：

- 触发：`schedule: '0 */6 * * *'`（每 6 小时）＋ 手动 `workflow_dispatch`（可传 `recency_days`、`max_repos`）
- 权限：`permissions: contents: write`（要提交 `out/`、要发 release）
- 并发：`concurrency: {group: nodepool, cancel-in-progress: false}`（两次跑不会互相踩）
- 运行环境：`ubuntu-latest` + Node 22，`cache/` 用 `actions/cache` 恢复
- 提交：`git add out/`，只有 `git diff --quiet` 说「有变化」时才 commit，避免空提交
- 发布：把 `out/nodepool.yaml` 作为 release asset 上传到滚动 tag `nodepool-latest`（`gh release upload --clobber`）

### 订阅地址：候选 与 可用

第一级（runner 产出，只是**候选**：数量多，但大部分在你那条线路上是死的）：

1. 仓库文件，随 commit 更新：
   `https://raw.githubusercontent.com/qwqlemon2333/pussies_fucker/main/out/nodepool.yaml`
2. release 资产（滚动 tag）：
   `https://github.com/qwqlemon2333/pussies_fucker/releases/download/nodepool-latest/nodepool.yaml`

第二级（大陆实测后**真的能用**的那一小撮，日常就该订这个）：

3. `https://github.com/qwqlemon2333/pussies_fucker/releases/download/nodepool-latest/nodepool-cn.yaml`
   大陆直连 GitHub 打不开时，用镜像前缀取同一个文件：
   `https://gh-proxy.com/https://github.com/qwqlemon2333/pussies_fucker/releases/download/nodepool-latest/nodepool-cn.yaml`

> 上面这些地址指向本仓库 `qwqlemon2333/pussies_fucker`。fork 到别处时把 slug 换掉即可：
> CI 里由 `GITHUB_REPOSITORY` 自动决定，本地可用环境变量 `NODEPOOL_SLUG` 覆盖。

### 在本地跑

```bat
node pipeline.mjs                                   # 本地：自动发现 + 抓取 + 输出到 out/
node pipeline.mjs --ci --max-repos 12 --max-live 600 # 和 CI 一样的路径，只是范围小
node pipeline.mjs --offline                          # 完全离线：重放 cache/discovery.json，不碰 GitHub API
node pipeline.mjs --offline --reuse-raw --reuse-liveness
                                                    # 确定性自检：同一批输入重跑，out/nodepool.yaml 必须逐字节相同
node pipeline.mjs --no-probe                         # 跳过真实代理验证（proxy_verified 记为 null）
node pipeline.mjs --drop-port-110                    # 额外丢弃 110 端口的节点（中间盒伪装，默认关闭）
node pipeline.mjs --allow-plaintext                  # 允许 http/socks5 明文代理（默认丢弃，风险自担）

node local-pick.mjs --url <粗筛订阅>                # 本地轻量优选：分块 headless mihomo，产出 out/local.yaml
node local-pick.mjs --file out/nodepool.yaml --max 400 --chunk 40
node local-pick.mjs --url <粗筛订阅> --tcp-only      # 只做 TCP 预筛，最快，但不验证能不能翻出去
```

没有任何 `GITHUB_TOKEN` 也能跑：这时搜索接口限 10 次/分钟、核心接口 60 次/小时，
所以脚本会先用搜索把候选收敛，再只对排名前 ~25 个候选做默认分支提交校验，
并在配额耗尽时体面地停下来（把已完成的发现结果写进 `cache/discovery.json`，
下次 `--offline` 还能继续用）。设置 `GITHUB_TOKEN` 后配额是 5000 次/小时，可以校验更多候选。

### 关于免费的 Actions 额度

**公开仓库（public repo）的 GitHub Actions 分钟数是完全免费的**，本 workflow 每天 4 次、
单次几分钟，公开仓库上不会产生任何账单。私有仓库则会消耗你自己的免费额度（每月 2000 分钟），
所以建议把这个仓库设为 public。

## 两级验证：runner 只证「还在」，大陆才证「能用」

这条分界线值得先说清楚：

> **GitHub Actions 的 runner 只能证明节点还活着，不能证明你能用它。**

runner 跑在 Azure 的海外机房，到中国大陆这一段路由**根本不在它的测量范围内**。
一个节点可以给 runner 一个 90ms 的握手，同时在你家宽带上 100% 超时——
被阻断、被 QoS、被运营商重置，全都发生在最后这一跳。所以验证必须分两级：

| 级别 | 在哪跑 | 证明什么 | 产物 |
| --- | --- | --- | --- |
| 第一级 | GitHub runner（海外机房） | 进程活着、能完成握手、类型与参数合法 | `out/nodepool.yaml`（候选，通常几十到上千条） |
| 第二级 | 中国大陆的一台机器 | 从大陆出发，**多轮**都能连通你真正要访问的目标 | `out/nodepool-cn.yaml`（少而真，通常 20~40 条） |

第一级的价值是「把候选范围从几万条压到几百条」，不是「告诉你哪些能用」。
日常订阅应该用第二级的产物。

### 第二级怎么跑

```bat
node verify-cn.mjs                                    # 读 out/nodepool.yaml，本机实测，写 out/nodepool-cn.yaml
node verify-cn.mjs --rounds 5 --interval 30000        # 更严格：5 轮、间隔 30s（抗抖动）
node verify-cn.mjs --throughput 10                    # 顺便对前 10 名做真实下载测速
node verify-cn.mjs --throughput-only --throughput 20  # 只测速，不重跑轮次
node verify-cn.mjs --url https://gh-proxy.com/https://github.com/qwqlemon2333/pussies_fucker/releases/download/nodepool-latest/nodepool.yaml
                                                      # 直接从 release 拉候选（走大陆可达的镜像前缀）
```

判定规则是故意做得比「通一次」严格的：

- 必须目标默认 `https://www.gstatic.com/generate_204`，**每一轮**都要通，且最差 RTT ≤ `--max-rtt`（默认 3000ms）；
- 轮数默认 3、间隔 15s，**过半轮次**都过才算通过（`--min-pass` 可改），抖动型节点在这一步被淘汰；
- 参考目标另外记录 `api.github.com` 与 `raw.githubusercontent.com` 的延迟——这两个才是这个池子存在的理由；
- `--throughput` 会把 selector 切到该节点，用 curl 真下载几 MB，量的是「拉 GitHub」的能力，不是握手速度。

### 实测数字（本机，大陆线路，2026-10-25）

同一天两次 3 轮实测：**24/29** 与 **25/29** 通过（`out/nodepool-cn.yaml` 25 条），中位 RTT 192ms ~ 1.9s。
但把「拉 GitHub」单独量出来之后，画面完全变了：

- codeload tarball：`0.01 ~ 0.71 MiB/s`，多数节点在 **1.25 MB 前后被掐断**（反复出现的 1253 KiB 不是巧合，是单流限速/重置）；
- GitHub Release 资产（302 → `objects.githubusercontent.com`）：`0.02 ~ 0.21 MiB/s`，比 codeload 还差一档；
- 同一批节点对 Cloudflare 2MB 测速：`0.26 ~ 0.67 MiB/s`。

结论：**同一个节点，换个目标就换命**。「延迟 192ms 排第一」不等于「下 GitHub 快」。
RTT 不能当带宽用，速度必须按目标分别量——这也是为什么 `--throughput-url` 可以重复传多个地址。

### 引导循环怎么破

第二级要读第一级的产物，而那份产物放在 github.com 上——大陆这边可能正好打不开。
实测可用的破法是镜像前缀：`https://gh-proxy.com/https://github.com/...`，raw 文件与 release 资产都返回 200、1 秒内到。
本机直连 `raw.githubusercontent.com` 是超时的，经此前缀能取到文件，所以第二级**不需要先有一个能用的节点**就能自举。

### 两种落地方式

1. **自托管 runner（推荐）**：在大陆那台机器上注册一个 label 为 `china` 的 self-hosted runner，
   然后在仓库 Settings → Variables 加 `CN_SELF_HOSTED=true`（可选 `MIHOMO_BIN` 指到 mihomo 可执行文件）。
   workflow 里的 `verify-cn` job 会在第一级跑完后自动接力，并把 `nodepool-cn.yaml` 传回同一个 release。
   没有这个 runner 时该 job 直接 skip（不会挂在那里排队），第一级照常发布候选。
2. **Windows 计划任务**：不想弄 runner 就在自己电脑上定时跑，脚本已带日志轮转：

```bat
schtasks /Create /TN nodepool-tier2 /SC HOURLY /MO 2 /F /RL LIMITED ^
  /TR "powershell -ExecutionPolicy Bypass -File C:\UGit\pussies_fucker\scripts\tier2-cn.ps1 -Release qwqlemon2333/pussies_fucker"
```

计划任务里的脚本会先用镜像前缀把候选拉到 `out/nodepool.yaml`，再调 `verify-cn.mjs`，
日志写到 `.verify/tier2-<时间戳>.log`（只保留最近 20 份）。

## 两步走：CI 维护「源花名册」，本地做「轻量优选」

> 这一节是**当前推荐的用法**。前面「两级验证」里那套自托管 runner 仍然可用，但它需要一台
> 常开的大陆机器（或付费 runner），属于可选项，不是默认路径。

### 为什么拆成两步

| 问题 | 事实 |
| --- | --- |
| GitHub hosted runner 的位置 | 在境外。它能证明「节点的服务器还活着、mihomo 能连上」，证明不了「你这条线路上能用」。 |
| 自托管 runner 的成本 | 要一台常开的机器 + 公网可达的 runner，等于持续花钱或占一台机器。 |
| 把粗筛订阅直接导进 Clash Verge | Verge 的「测可用性」会对**全部**节点同时发探测。几千条一起测，UI 卡死、进程吃满，而其中九成以上本来就是死的。 |
| 两次运行的漂移 | discovery 每轮都是「当场搜一遍」。没有持久化，稳定产出的仓库会因为排名波动消失，停更的仓库反而可能靠缓存复活一轮。 |

于是分工是：

1. **CI（免费，GitHub 托管的 runner，每 6 小时）**：只负责「发现—收录—去重—自动淘汰超时源」，
   维护一份有状态的源花名册 `registry/sources.json`，产出候选列表 `out/nodepool.yaml`。
2. **本地（一条命令，几十秒到几分钟）**：只负责「优选」。分块调 headless mihomo，把几千条压成几十条，
   只有幸存者进 Clash Verge。

### 第一步：源花名册（CI，免费）

花名册把「收录」从「今天恰好搜到谁」变成一个集合：在册的仓库每轮都会被**强制**送进 5 天提交闸门，
哪怕这轮的搜索结果没把它带回来；不合格的则当场出局，并留一条原因。

| 情形 | 处理 | 记在哪 |
| --- | --- | --- |
| 默认分支最新提交早于 5 天 | 删除 | `removed[].reason = stale_default_branch` |
| 仓库 404 / archived / disabled / 是候选的 fork | 删除 | `not_found` / `archived` / `disabled` / `fork_of_candidate` |
| 连续 6 轮都没被验证到（搜索没返回、也没轮到闸门） | 删除 | `forgotten_unverified` |
| 超过 `--max-repos` 上限 | 淘汰上轮产出节点最少的 | `evicted_max_sources` |
| 只是这轮没被选中（名额不够 / 没有订阅文件） | **保留**，`unverified_runs` +1 | 不删 |

几个细节：

- `registry/sources.json` 和 `out/` 一起被 workflow 提交回仓库，所以每次运行的
  「谁进了、谁走了、为什么」在 git 历史里就是审计日志；删除记录只保留最近 200 条，避免文件无限膨胀。
- `node pipeline.mjs --no-registry` 可以关掉结算（纯观察模式）；`--registry-forget-after N`
  （或环境变量 `REGISTRY_FORGET_AFTER`）改「连续多少轮没验到就除名」，默认 6。
- `--offline` 回放模式下**不结算**花名册：重放必须可复现，不能顺手改写状态。

### 第二步：本地轻量优选

```bat
node local-pick.mjs --url https://example.com/sub              # 粗筛订阅（yaml / base64 / 链接列表都行）
node local-pick.mjs --file out/nodepool.yaml --max 400 --chunk 40
node local-pick.mjs --url <sub> --tcp-only                     # 只做 TCP：最快，不验证能不能翻出去
node local-pick.mjs --url <sub> --no-tcp --rounds 3            # 跳过 TCP，直接让 mihomo 判
```

管道是：解析 → 安全过滤（丢明文代理 / 关校验 / 内网地址）→ 去重 → 按类型轮转取 `--max`
→ TCP 预筛 → 每块先做**加载测试**（把整块内联进一份临时配置跑 `mihomo -t`，把 mihomo 明确拒收的条目剔掉）
→ **分块**进 headless mihomo → 只有幸存者被写进 `out/local.yaml`。

加载测试这一步不是可选的：一条坏条目就足以让 mihomo 拒绝**整份**配置，于是整块 40 条全军覆没。
实测上游列表里真实出现过三种：裸横杠标量（`path: -`，YAML 语法直接崩）、字符串布尔（`tls: "true"`）、
REALITY 公钥/短 ID 非法。现在这些条目在发出之前就被丢弃并记在日志里。

为什么这样就不卡了：一次只让**一个** mihomo 拿 `--chunk` 条（默认 40），全部测完
（默认 2 轮、轮间隔 8 秒）就退出，再换下一块。实测 27 条节点、分 2 块、共 70 秒，得到 24 条幸存者；
同样的量如果塞进 Verge，界面会先卡住十几秒。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--url` / `--file` | — | 可重复；先直连拉取，失败再走环境代理 |
| `--max` | 300 | 去重后进入优选的**名额**上限（按类型轮转分配，不偏袒先出现的类型） |
| `--chunk` | 40 | 每块节点数。机器弱就调小，网络差就调大 |
| `--rounds` | 2 | 探测轮数。1 轮只够排除完全死的；3 轮更稳但更慢 |
| `--timeout` | 5000 | 单次延迟探测超时（毫秒） |
| `--concurrency` | 4 | 单块内并发。别开太大，会把本机出口打满 |
| `--min-pass` | 1 | 至少通过几轮才算幸存 |
| `--max-rtt` | 3000 | 首目标最差延迟上限（毫秒） |
| `--require` | generate_204 | 必须打通的目标，可重复 |
| `--throughput` | 0 | 只给前 N 个幸存者测速（要额外时间，默认不测） |

产物：

- `out/local.yaml`：mihomo **provider 片段**（只含幸存者），在 Verge 里作为 `proxy-provider` 用；
- `out/local-nodes.txt`：幸存者的分享链接，一行一条，方便贴到别处；
- `out/local-report.json`：每个阶段的真实数字 + 每个节点每轮的通过情况（排查「为什么这个节点没了」看这个）。

> 关键一点：**不要**把原始订阅导进 Clash Verge。导入的应该是 `out/local.yaml`。
> 如果你想让别人也用你这份优选结果，跑完后 `gh release upload <tag> out/local.yaml --clobber`
> 传上去，再把 `release` 里的地址当订阅用即可（这步需要你自己有仓库和 `gh` 登录状态）。

### 和「两级验证」的关系

- 没有自托管 runner：按这一节的两步走。第一级（CI）给候选，第二级（本地 `local-pick.mjs`）给可用。
- 有自托管 runner（或愿意付费）：可以继续用前面「两级验证」里的 `verify-cn` job，它会把
  大陆实测结果发布成 `nodepool-cn.yaml`，省掉手动这一步。两条路不冲突，`local-pick.mjs`
  的判定标准（多轮通过 + 延迟上限）和 `verify-cn.mjs` 是同一套内核（`lib/cnverify.mjs`）。

## 本次运行的真实数据

- 生成时间：`2026-10-25T18:01:27.755Z`，模式 `ci`，耗时 176.4 秒
- 新鲜度闸门：窗口 5 天，截止 `2026-10-20`；搜索命中 361 个仓库 → 一筛后 361 → 默认分支校验 25 → 5 天内活跃 24 → 最终采用 14 个仓库 / 28 个文件
- 因默认分支太旧而丢弃：1 个仓库（明细+提交日期见 `out/sources.json`）
- 原始文件：28 个（11.93 MiB）
- 节点：解析 25817 → 去重 4247 → TCP 存活 1149 → 真实代理验证 14 → 最终写入 14
- 真实代理验证：mihomo 逐节点测 400 个，通过 14 个，耗时 44 秒
- 丢弃大类：不安全 3273，内网/回环 0，端口非法 0，重复 16988，TCP 不通 2851
- 逐项丢弃原因（report.json 的 `drop_reasons` 有完整计数）：tls_disabled=1678、insecure=1595、plaintext_proxy=724、sni_ip_literal=390、weak_ss_cipher=142、trojan_no_tls=42、vmess_weak_cipher=4、adapter_ss_method=4、reality_no_pubkey=2、adapter_reality_pubkey=1
- 存活节点按类型：ss=8, vmess=6
- 真机自检：mihomo -t 通过
- 发布前加载测试：整份 provider 被 mihomo 逐条解析通过（14 条）
- GEOIP：检测到 `C:\Program Files\Clash Verge\resources\Country.mmdb`，片段中含 GEOIP,PRIVATE / GEOIP,LAN

最快 5 个（仅 TCP 握手 RTT，不代表真实下载速度）：

| 名称 | 类型 | 服务器 | 端口 | RTT |
| --- | --- | --- | --- | --- |
| vmess-1827155985 | vmess | 112.132.215.108 | 50002 | 13.8 ms |
| vmess-1883518786 | vmess | 120.48.133.162 | 10086 | 32.9 ms |
| vmess-1884298776 | vmess | 39.108.113.127 | 10086 | 36.2 ms |
| [www.v2nodes.com]-ss-IT-1602...-#2 | ss | 202.50.253.72 | 19999 | 187.6 ms |
| By-EbraSha-24 | vmess | 172.67.187.145 | 80 | 194.2 ms |

## 各阶段做了什么

1. **fetch**：每个文件 20 秒超时。先用一个小文件把各下载通道各测一次
   （raw 直连 / 本地 7897 代理 / ghproxy.net / gh-proxy.com / jsdelivr），按实测延迟排序，
   失败的自动降级，原始字节落到 raw/。
2. **parse**：三种形态——base64 块、明文 URI 列表、Clash/Mihomo YAML。
   YAML 不写通用解析器，只按缩进切出 proxies 下的序列项，原文透传（只重写 name 行保证唯一）；
   URI 支持 vmess / vless / ss（SIP002 两种写法）/ trojan / hysteria2 / hy2 / tuic。
3. **供应链安全过滤**（任一命中即丢弃，每项都有独立计数器）：
   - 出现 skip-cert-verify / allowInsecure / allow-insecure / insecure 等键（**只要出现就算，值写 false 也算**），
     或 URI 里带 allowInsecure=1 / insecure=true / skip-cert-verify=true
   - trojan 没有 tls:true（trojan 不带 TLS 等于明文传密码）
   - vless 既无 TLS 也无 REALITY；REALITY 存在但 public-key 为空
   - ss 用了未认证/已破的加密：none、plain、table、rc4、rc4-md5、des-cfb、bf-cfb、chacha20（非 poly1305）
   - vmess 的 cipher/security/scy 为 none 或 zero
   - sni / servername / Host 直接写成裸 IP（无法做证书校验，正是把人逼去关校验的元凶）
   - **明文代理**：type 是 http / socks5 / socks4 / socks4a / http-connect 的一律丢弃。
     这类中继自身不做任何加密：运营者能读改写你所有 http:// 内容、能看到你访问了哪些域名，
     它们也正是开放中继与蜜罐的重灾区。确实需要时用 `--allow-plaintext` 显式放开。
   - 服务器落在 10/8、127/8、169.254/16、172.16/12、192.168/16、100.64/10、::1、fc00::/7、fe80::/10、localhost
   - 端口不在 1..65535，或 (type, server, port) 重复
   - 去重两道键：先按 `(type, server, port)` 折叠端点，再按内容 `(type, server, port, uuid/password)` 折叠完全相同的副本；
     排序在去重之前完成，所以「留下哪一个」只由数据决定，与抓取顺序无关。
3b. **格式兼容性预检（`lib/adapter.mjs`，不是安全策略，而是「mihomo 的解析器能不能读」）**：
   安全过滤回答「这个节点该不该发布」，这一步回答「这个条目会不会让 mihomo 拒绝整份配置」。
   两者必须分开：mihomo 遇到第一个致命字段就整份失败，**一个坏节点能拖垮整个测速阶段和发布**
   （真实事故：`ss … cipher: null` 让 fidelity probe 每次启动即退出，30 次重试预算全烧在剔节点上；
   `POOL: '14' not found` 让第 9 阶段的 provider 载入测试直接 FATAL）。
   规则全部是**实测**出来的，不是猜的：把单节点配置喂给本仓库固定的 mihomo 二进制（v1.19.33）跑 `-t`，
   记录它接受/拒绝哪些写法（见 `.verify/methodprobe*.mjs`、测试用例在 `test/adapter.test.mjs`）：
   - ss 加密方法白名单（大小写敏感！`AES-256-GCM` 会被判为 unknown method）；
   - 2022-blake3 的密钥必须是**带 padding 的标准 base64**、长度等于算法要求（16/32 字节），
     且 `serverkey:userkey` 多段形式每一段都要合法——这是真实节点最常见的写法，只验证整串会误杀；
   - REALITY 的 `public-key` 必须是 **unpadded base64url** 的 32 字节（用标准 base64 会被判 invalid）；
     `short-id` 必须是偶数长度的十六进制、2~16 位；
   - ss 插件的必填项（obfs 需要 mode=tls/http；v2ray-plugin、gost-plugin 需要 mode=websocket；
     shadow-tls 需要 host；restls 需要 password + version-hint）；
   - 各类型的必填字段（ss: cipher+password、vmess: uuid+alterId、vless: uuid、trojan: password、anytls: password…）；
   - 字段形状：`alpn` 写成字符串会被判 not a slice，`ws-opts.headers` 写成字符串会被判 expected a map；
   - 未知代理类型（unsupport proxy type）。
   每条丢弃都进 `drop_reasons` 的 `adapter_*` 桶，**能证明致命才丢**：
   无从证明的写法一律放行，宁可让第 9 阶段的真机载入测试兜底，也不凭猜想丢掉一个可用节点。
4. **存活性预筛（TCP）**：TCP connect，2000 ms 超时，150 并发，最多 4000 个候选，记录 RTT（失败重试一次）。
   名额按类型轮转分配（`stratifyByType`）：直接截断排序后的列表会让字母序靠前的 http/socks5 吃光全部名额，
   最终池子变成清一色明文代理——这正是早期版本真实发生过的偏差。
   这一步只证明「有人在这个端口上接电话」，**不证明它能当代理用**。
5. **真实代理验证（fidelity probe，CI 的核心价值）**：TCP 通过后，用一份临时配置起一个私有 mihomo，
   把全部存活节点塞进去（外加一个 `url-test` 组），通过 `external-controller: 127.0.0.1:9090` 的 REST 接口
   逐个向 `https://www.gstatic.com/generate_204` 测延迟，**只保留返回 delay > 0 的节点**。
   二进制来源依次是 `MIHOMO_BIN` 环境变量 / 本目录 `bin/` / 按 runner 架构下载最新 release。
   如果 mihomo 不可用、或 API 在超时内没有任何响应，**整个阶段跳过**，报告里 `proxy_verified` 写 `null` 并在日志里大声说明——
   绝不用「TCP 通」冒充「验证过」。
6. **输出**：`out/nodepool.yaml`（provider YAML，2 空格缩进、UTF-8、LF）、`out/nodes.txt`、
   `out/nodepool.patch.yaml`、`out/sources.json`、`out/report.json`、本 README。
   输出按 `(type, server, port, name)` 排序、名字去重成 `name` / `name-2` / …，
   所以同样的输入两次运行会产出**逐字节相同**的文件（git 不会看到无意义的抖动）。
7. **自检（真机验证）**：如果本机装了 mihomo / Clash Verge，就在临时目录里用 `-t` 把
   生成的片段连同 provider 一起真正加载一遍（跑完删掉临时目录），结果记在 report.json 的 `verify`。
   同时会检测机器上是否存在 geoip 数据库：有才写 GEOIP 规则，没有就不写——
   因为 mihomo 遇到 GEOIP 规则但找不到 mmdb 时会整份配置加载失败（`can't download MMDB`）。
   注意 `-t` 对 `providers:` 是**惰性**的：它只证明配置本身能读，不证明 provider 里的条目能读。
   所以还会把 provider 整份内联进一份临时配置再 `-t` 一遍，把 mihomo 明确拒收的条目剔掉再发布，
   结果记在 `provider_test`。实测抓到过三类真实故障：裸横杠标量（`path: -`，整份 YAML 解析失败）、
   字符串布尔（`tls: "true"`）、REALITY 公钥/短 ID 非法——任何一条都足以让客户端拒绝加载整份文件。

## 局限与风险（请务必读完）

- **节点是别人的服务器。** 免费公共节点由陌生人运营，随时可能抓包、篡改或下线。
- **寿命很短。** 通常几小时到几天就失效；输出只是一次性快照，需要定时重跑。
- **TCP 预筛可能被中间盒欺骗。** 部分运营商/防火墙会对任意目标端口立即回 SYN-ACK
  （实测本机对几个境外 IP 的 110 端口在 1~2 ms 内就"握手成功"），因此 RTT 极低的节点
  未必真的可达，更不代表能跑代理协议。
- **速度不可预测。** RTT 低不等于带宽高，TCP 通也不等于能跑代理。
  CI 模式下会做真实的一次 `generate_204` 代理测速（`proxy_verified`），但那只是「此刻能连上」；
  本地跑且没有 mihomo 时该阶段会被跳过，报告里是 `null` 而不是 0。
- **POOL 是默认出口，这是刻意的取舍。** 当前片段以 `MATCH,POOL` 结尾，
  所以所有流量（包括你的日常浏览）都会经过陌生人的服务器：能保证的是内容有 HTTPS 加密，
  不能保证的是节点不记录 SNI/DNS、不注入内容、不随时断线。想收回控制权就改回 `MATCH,DIRECT`。
- **速度上限就是单个免费节点。** url-test 只会挑当前延迟最低的那个，不会做多节点聚合，
  所以整机带宽/并发受制于一台很可能被上百人共用的机器。
- **没有任何节点被验证为安全。** 过滤只是排除了「明示跳过证书校验 / 弱加密 / SNI 是裸 IP / 指向内网」这些
  可以从文本上判定的坏味道，**不等于节点可信**，也不保证它没有在做中间人。
  这不等于节点可信。不要在 POOL 上登录任何账号。
- **合规提醒。** 请遵守你所在地区的法律法规与所用服务的条款。

## 数据源状态（本次运行）

- `MustafaBaqer/VestraNet-Nodes :: subscriptions/mix-normal.txt` — HTTP 200，2885858 B，解析 8440 个（通道 ghproxy.net）
- `MustafaBaqer/VestraNet-Nodes :: protocols/vmess.txt` — HTTP 200，2193003 B，解析 6314 个（通道 jsdelivr-proxied）
- `Au1rxx/free-vpn-subscriptions :: output/protocol/vmess/clash-0001.yaml` — HTTP 200，237066 B，解析 822 个（通道 jsdelivr-proxied）
- `Au1rxx/free-vpn-subscriptions :: output/protocol/vless/clash-0002.yaml` — HTTP 200，762042 B，解析 2000 个（通道 jsdelivr-proxied）
- `Au1rxx/free-vpn-subscriptions :: output/protocol/vless/clash-0001.yaml` — HTTP 200，761474 B，解析 2000 个（通道 jsdelivr-proxied）
- `Thordata/awesome-free-proxy-list :: proxies/clash/all.yaml` — HTTP 200，90315 B，解析 361 个（通道 jsdelivr-proxied）
- `Thordata/awesome-free-proxy-list :: proxies/clash/high-anon.yaml` — HTTP 200，77233 B，解析 293 个（通道 jsdelivr-proxied）
- `chenzhihan1751-cyber/node-sub-zixf :: sub/v2ray.txt` — HTTP 200，419810 B，解析 1885 个（通道 jsdelivr-proxied）
- `chenzhihan1751-cyber/node-sub-zixf :: sub/base64.txt` — HTTP 200，535557 B，解析 1818 个（通道 jsdelivr-proxied）
- `zhangdunlong/free-v2ray-nodes :: nodes_base64.txt` — HTTP 200，17336 B，解析 60 个（通道 jsdelivr-proxied）
- `zhangdunlong/free-v2ray-nodes :: unique_nodes.txt` — HTTP 200，12914 B，解析 50 个（通道 jsdelivr-proxied）
- `vincent20240707/free-v2ray-nodes :: nodes.txt` — HTTP 200，8273 B，解析 50 个（通道 jsdelivr-proxied）
- `LalatinaHub/LatinaSub :: result/clash.yaml` — HTTP 200，199587 B，解析 398 个（通道 jsdelivr-proxied）
- `LalatinaHub/LatinaSub :: result/nodes` — HTTP 200，101084 B，解析 463 个（通道 jsdelivr-proxied）
- `LalatinaHub/LatinaSub :: result/sub` — HTTP 200，134780 B，解析 463 个（通道 jsdelivr-proxied）
- `xifan001-lab/clash-sub :: clash.yaml` — HTTP 200，53593 B，解析 100 个（通道 jsdelivr-proxied）
- `owenlee3/my-nodes :: output/clash.yaml` — HTTP 200，45603 B，解析 150 个（通道 jsdelivr-proxied）
- `shifeiquan520/shifeiquan3 :: output/clash.yaml` — HTTP 200，12135 B，解析 33 个（通道 jsdelivr-proxied）
- `longyang1233/free-nodes-sub :: clash.yaml` — HTTP 200，13929 B，解析 60 个（通道 jsdelivr-proxied）
- `sunmiao4458/free-proxy-airport :: output/clash.yaml` — HTTP 200，16360 B，解析 44 个（通道 jsdelivr-proxied）
- `Pawdroid/Free-servers :: sub` — HTTP 200，4760 B，解析 13 个（通道 jsdelivr-proxied）

失败 / 跳过：

- `MustafaBaqer/VestraNet-Nodes :: subscriptions/mix-base64.txt` — fetched but parsed 0 nodes
- `Thordata/awesome-free-proxy-list :: proxies/subscriptions.json` — fetched but parsed 0 nodes
- `chenzhihan1751-cyber/node-sub-zixf :: sub/stats.json` — fetched but parsed 0 nodes
- `zhangdunlong/free-v2ray-nodes :: subscription.txt` — fetched but parsed 0 nodes
- `vincent20240707/free-v2ray-nodes :: subscriptions.txt` — fetched but parsed 0 nodes
- `shifeiquan520/shifeiquan3 :: output/nodes.json` — fetched but parsed 0 nodes
- `SnapdragonLee/SystemProxy :: clash.config.template.yaml` — fetched but parsed 0 nodes

