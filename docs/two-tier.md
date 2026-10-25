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
