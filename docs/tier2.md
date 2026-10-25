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
node verify-cn.mjs --url https://gh-proxy.com/https://github.com/<owner>/<repo>/releases/download/nodepool-latest/nodepool.yaml
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
  /TR "powershell -ExecutionPolicy Bypass -File C:\UGit\nodepool\scripts\tier2-cn.ps1 -Release <owner>/<repo>"
```

计划任务里的脚本会先用镜像前缀把候选拉到 `out/nodepool.yaml`，再调 `verify-cn.mjs`，
日志写到 `.verify/tier2-<时间戳>.log`（只保留最近 20 份）。
