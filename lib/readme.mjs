// lib/readme.mjs - generates README.md (Chinese) from the live report.
import fs from 'node:fs/promises';
import path from 'node:path';

const B = String.fromCharCode(96);
function c(s) { return B + s + B; }

// 订阅地址里的仓库 slug：CI 里自动取 GITHUB_REPOSITORY，本地可用环境变量覆盖。
// 这个仓库固定发布在 qwqlemon2333/pussies_fucker 下，所以默认值就是它，
// 不再是 <owner>/<repo> 那种谁都得手改的占位符。
const SLUG = process.env.NODEPOOL_SLUG || process.env.GITHUB_REPOSITORY || 'qwqlemon2333/pussies_fucker';

export async function writeReadme(root, report) {
  const t = report.totals;
  const fastest = report.fastest || [];
  const badSources = (report.sources || []).filter((s) => s.error);
  const okSources = (report.sources || []).filter((s) => !s.error);

  const L = [];
  L.push('# nodepool — 公共免费节点订阅聚合器');
  L.push('');
  L.push('从 GitHub 上**主动公开**的免费节点订阅仓库抓取节点，做供应链安全过滤与存活性预筛，');
  L.push('输出一份 Mihomo/Clash 的 provider 文件，并配套一份**含本地绕行规则**的配置片段。');
  L.push('');
  L.push('> 本工具只抓取仓库作者主动公开、供任何人使用的订阅，不做任何破解或私密抓取。');
  L.push('> 免费节点仍然是**陌生人的服务器**，请务必读完文末「局限与风险」。');
  L.push('');
  L.push('## 快速开始');
  L.push('');
  L.push(B + B + B + 'bat');
  L.push('git clone https://github.com/' + SLUG + '.git');
  L.push('cd ' + SLUG.split('/')[1]);
  L.push('node pipeline.mjs');
  L.push(B + B + B);
  L.push('');
  L.push('一条命令跑完整个流水线。依赖：Node >= 18 + Windows 自带的 ' + c('curl.exe') + '。');
  L.push('不需要 ' + c('npm install') + '，没有任何第三方 JS 依赖（只用 Node 标准库）。');
  L.push('');
  L.push('## 目录与产物');
  L.push('');
  L.push('| 路径 | 内容 |');
  L.push('| --- | --- |');
  L.push('| ' + c('out/nodepool.yaml') + ' | **主产物**：以 proxies 开头的 provider 文件（CI 每 6 小时重生成并发布） |');
  L.push('| ' + c('out/nodepool.patch.yaml') + ' | 配置片段：provider + POOL 组 + 本地绕行规则 + ' + c('MATCH,POOL') + ' 兜底 |');
  L.push('| ' + c('out/nodes.txt') + ' | 同样的节点导出为 URI 列表，给 v2rayN / NekoBox 等客户端 |');
  L.push('| ' + c('out/sources.json') + ' | 本次发现的数据源证据：命中的仓库、默认分支最新提交时间、**每个被丢弃仓库的原因与提交日期** |');
  L.push('| ' + c('out/report.json') + ' | 本次运行的真实统计（抓了多少、解析多少、丢弃原因、TCP/真实代理验证数） |');
  L.push('| ' + c('registry/sources.json') + ' | **源花名册**：被收录的仓库、每轮验证结果、被除名的原因（随 commit 一起回写，git 历史即审计日志） |');
  L.push('| ' + c('out/local.yaml') + ' | 本地轻量优选（local-pick.mjs）的产物：只含幸存者的 provider 片段，给 Clash Verge 当 proxy-provider 用 |');
  L.push('| ' + c('out/local-report.json') + ' | 本地优选的每阶段数字 + 每个节点每轮的通过情况 |');
  L.push('| ' + c('raw/') + ' | 抓取到的原始订阅字节（不修改，便于复现） |');
  L.push('| ' + c('cache/') + ' | GitHub API 响应 / 发现快照 / 存活探测缓存的磁盘缓存（CI 里由 actions/cache 保存） |');
  L.push('');
  L.push('## 粘进 Clash Verge / mihomo');
  L.push('');
  L.push('1. 把 ' + c('mihomo/providers/nodepool.yaml') + ' 拷到你的 mihomo 配置目录下的 ' + c('providers/') + ' 里。');
  L.push('   Clash Verge Rev 一般是右键托盘配置 → 打开文件夹，路径类似 %APPDATA%\\io.github.clash-verge-rev.clash-verge-rev\\。');
  L.push('2. 打开 ' + c('mihomo/nodepool.patch.yaml') + '，把 proxy-providers / proxy-groups / rules 三段');
  L.push('   分别粘进你的 config.yaml 对应段落（已有同名段就合并，不要整段覆盖）。');
  L.push('3. 重载配置。策略组里出现 POOL（url-test，每 300 秒用 https://api.github.com/ 测延迟）。');
  L.push('4. 规则结尾是 ' + c('MATCH,POOL') + '：**POOL 现在是全部流量的默认出口**，');
  L.push('   整机上网速度/稳定性 = 当前最快的那一个免费节点。');
  L.push('');
  L.push('> **请先想清楚再启用。** ' + c('MATCH,POOL') + ' 意味着你打开的任何站点都走陌生人的服务器：');
  L.push('> HTTPS 内容仍有机密性，但 SNI、DNS、流量特征、以及你访问了哪些站点对节点运营者完全可见，');
  L.push('> 且节点可以随时断流或注入数据。**不要用它登录网银/公司系统/重要账号。**');
  L.push('> 如果你只想要「开发者域名走 POOL、其余直连」，把最后一行 ' + c('MATCH,POOL') + ' 改成 ' + c('MATCH,DIRECT') + '。');
  L.push('');
  L.push('> ' + c('MATCH,POOL') + ' 之前保留了一组本地绕行规则（127/8、10/8、172.16/12、192.168/16、');
  L.push('> 169.254/16、100.64/10、::1、fc00::/7、fe80::/10、' + c('DOMAIN-SUFFIX,local') + ' 等）。');
  L.push('> 没有它们，回环和局域网流量也会被塞进代理，本地 NAS/打印机/调试端口会直接坏掉。');
  L.push('> 其中 ' + c('GEOIP,PRIVATE') + ' / ' + c('GEOIP,LAN') + ' 需要 mihomo 的 geoip 数据库；');
  L.push('> 若你的构建里没有 geoip.metadb，删掉这两条即可，CIDR 规则仍然覆盖同样的地址段。');
  L.push('');
  L.push('## CI 模式');
  L.push('');
  L.push('这个工具现在由 **GitHub Actions 驱动**：不需要你开着电脑，workflow 每 6 小时自己跑一遍');
  L.push('「发现 → 抓取 → 解析 → 安全过滤 → 去重 → 存活/TCP 预筛 → 真实代理验证 → 发布」。');
  L.push('');
  L.push('### 5 天新鲜度闸门（硬性要求）');
  L.push('');
  L.push('一个源仓库只有在**默认分支最近 5 天内有提交**时才会被采用，这是两道真实的检查，不是摆设：');
  L.push('');
  L.push('1. 第一道：GitHub 搜索接口带 ' + c('pushed:>=YYYY-MM-DD') + '，按 ' + c('full_name') + ' 去重，');
  L.push('   并且丢掉 archived / disabled / 只是别人 fork 的重复仓。');
  L.push('2. 第二道：对候选仓再请求 ' + c('GET /repos/{owner}/{repo}/commits?per_page=1') + '（**默认分支**），');
  L.push('   拿到真实的最新提交 ' + c('{sha, date}') + '。如果这个日期比 5 天前更早，**直接丢弃**——');
  L.push('   哪怕 ' + c('pushed_at') + ' 看起来很新。原因：往侧分支推一次代码也会刷新 ' + c('pushed_at') + '，');
  L.push('   但默认分支可能已经几个月没动了，那种仓库里的订阅基本都是死的。');
  L.push('');
  L.push('窗口可以用环境变量 ' + c('RECENCY_DAYS') + ' 覆盖（默认 ' + c('5') + '），');
  L.push('workflow_dispatch 也提供了同名输入。每个被丢弃的仓库及其默认分支提交日期，都写在 ' + c('out/sources.json') + ' 的 ' + c('dropped') + ' 数组里。');
  L.push('');
  L.push('### 定时任务');
  L.push('');
  L.push('' + c('.github/workflows/nodepool.yml') + '：');
  L.push('');
  L.push('- 触发：' + c("schedule: '0 */6 * * *'") + '（每 6 小时）＋ 手动 ' + c('workflow_dispatch') + '（可传 ' + c('recency_days') + '、' + c('max_repos') + '）');
  L.push('- 权限：' + c('permissions: contents: write') + '（要提交 ' + c('out/') + '、要发 release）');
  L.push('- 并发：' + c('concurrency: {group: nodepool, cancel-in-progress: false}') + '（两次跑不会互相踩）');
  L.push('- 运行环境：' + c('ubuntu-latest') + ' + Node 22，' + c('cache/') + ' 用 ' + c('actions/cache') + ' 恢复');
  L.push('- 提交：' + c('git add out/') + '，只有 ' + c('git diff --quiet') + ' 说「有变化」时才 commit，避免空提交');
  L.push('- 发布：把 ' + c('out/nodepool.yaml') + ' 作为 release asset 上传到滚动 tag ' + c('nodepool-latest') + '（' + c('gh release upload --clobber') + '）');
  L.push('');
  L.push('### 订阅地址：候选 与 可用');
  L.push('');
  L.push('第一级（runner 产出，只是**候选**：数量多，但大部分在你那条线路上是死的）：');
  L.push('');
  L.push('1. 仓库文件，随 commit 更新：');
  L.push('   ' + c('https://raw.githubusercontent.com/' + SLUG + '/main/out/nodepool.yaml'));
  L.push('2. release 资产（滚动 tag）：');
  L.push('   ' + c('https://github.com/' + SLUG + '/releases/download/nodepool-latest/nodepool.yaml'));
  L.push('');
  L.push('第二级（大陆实测后**真的能用**的那一小撮，日常就该订这个）：');
  L.push('');
  L.push('3. ' + c('https://github.com/' + SLUG + '/releases/download/nodepool-latest/nodepool-cn.yaml'));
  L.push('   大陆直连 GitHub 打不开时，用镜像前缀取同一个文件：');
  L.push('   ' + c('https://gh-proxy.com/https://github.com/' + SLUG + '/releases/download/nodepool-latest/nodepool-cn.yaml'));
  L.push('');
  L.push('> 上面这些地址指向本仓库 ' + c(SLUG) + '。fork 到别处时把 slug 换掉即可：');
  L.push('> CI 里由 ' + c('GITHUB_REPOSITORY') + ' 自动决定，本地可用环境变量 ' + c('NODEPOOL_SLUG') + ' 覆盖。');
  L.push('');
  L.push('### 在本地跑');
  L.push('');
  L.push(B + B + B + 'bat');
  L.push('node pipeline.mjs                                   # 本地：自动发现 + 抓取 + 输出到 out/');
  L.push('node pipeline.mjs --ci --max-repos 12 --max-live 600 # 和 CI 一样的路径，只是范围小');
  L.push('node pipeline.mjs --offline                          # 完全离线：重放 cache/discovery.json，不碰 GitHub API');
  L.push('node pipeline.mjs --offline --reuse-raw --reuse-liveness');
  L.push('                                                    # 确定性自检：同一批输入重跑，out/nodepool.yaml 必须逐字节相同');
  L.push('node pipeline.mjs --no-probe                         # 跳过真实代理验证（proxy_verified 记为 null）');
  L.push('node pipeline.mjs --drop-port-110                    # 额外丢弃 110 端口的节点（中间盒伪装，默认关闭）');
  L.push('node pipeline.mjs --allow-plaintext                  # 允许 http/socks5 明文代理（默认丢弃，风险自担）');
  L.push('');
  L.push('node local-pick.mjs --url <粗筛订阅>                # 本地轻量优选：分块 headless mihomo，产出 out/local.yaml');
  L.push('node local-pick.mjs --file out/nodepool.yaml --max 400 --chunk 40');
  L.push('node local-pick.mjs --url <粗筛订阅> --tcp-only      # 只做 TCP 预筛，最快，但不验证能不能翻出去');
  L.push(B + B + B);
  L.push('');
  L.push('没有任何 ' + c('GITHUB_TOKEN') + ' 也能跑：这时搜索接口限 10 次/分钟、核心接口 60 次/小时，');
  L.push('所以脚本会先用搜索把候选收敛，再只对排名前 ~25 个候选做默认分支提交校验，');
  L.push('并在配额耗尽时体面地停下来（把已完成的发现结果写进 ' + c('cache/discovery.json') + '，');
  L.push('下次 ' + c('--offline') + ' 还能继续用）。设置 ' + c('GITHUB_TOKEN') + ' 后配额是 5000 次/小时，可以校验更多候选。');
  L.push('');
  L.push('### 关于免费的 Actions 额度');
  L.push('');
  L.push('**公开仓库（public repo）的 GitHub Actions 分钟数是完全免费的**，本 workflow 每天 4 次、');
  L.push('单次几分钟，公开仓库上不会产生任何账单。私有仓库则会消耗你自己的免费额度（每月 2000 分钟），');
  L.push('所以建议把这个仓库设为 public。');
  L.push('');
  // 两级验证整段是静态文档，放在 docs/tier2.md 里，生成器只负责把它整段搬进来
  try {
    const tier2 = await fs.readFile(path.join(root, 'docs', 'tier2.md'), 'utf8');
    for (const line of tier2.replace(/\n$/, '').split('\n')) L.push(line);
  } catch (e) {
    L.push('> 缺少 docs/tier2.md（' + (e.code || e.message) + '），本节内容暂缺');
  }
  L.push('');
  // 两步走（CI 花名册 + 本地轻量优选）同样是静态文档，放在 docs/two-tier.md
  try {
    const twoTier = await fs.readFile(path.join(root, 'docs', 'two-tier.md'), 'utf8');
    for (const line of twoTier.replace(/\n$/, '').split('\n')) L.push(line);
  } catch (e) {
    L.push('> 缺少 docs/two-tier.md（' + (e.code || e.message) + '），本节内容暂缺');
  }
  L.push('');
  L.push('## 本次运行的真实数据');
  L.push('');
  const rc = report.recency || {};
  const dc = (report.discovery && report.discovery.counts) || {};
  const pr = report.probe || {};
  L.push('- 生成时间：' + c(report.generated_at) + '，模式 ' + c(report.mode || 'local') + '，耗时 ' + report.duration_s + ' 秒');
  L.push('- 新鲜度闸门：窗口 ' + (rc.days == null ? '?' : rc.days) + ' 天，截止 ' + c(String(rc.cutoff_date || rc.cutoff || '?')) +
    '；搜索命中 ' + (dc.discovered == null ? '?' : dc.discovered) + ' 个仓库 → 一筛后 ' + (dc.eligible_stage1 == null ? '?' : dc.eligible_stage1) +
    ' → 默认分支校验 ' + (dc.commit_verified == null ? '?' : dc.commit_verified) + ' → 5 天内活跃 ' + (dc.recent == null ? '?' : dc.recent) +
    ' → 最终采用 ' + (dc.selected == null ? '?' : dc.selected) + ' 个仓库 / ' + (dc.files == null ? '?' : dc.files) + ' 个文件');
  L.push('- 因默认分支太旧而丢弃：' + (dc.stale_dropped == null ? '?' : dc.stale_dropped) + ' 个仓库（明细+提交日期见 ' + c('out/sources.json') + '）');
  L.push('- 原始文件：' + t.raw_files + ' 个（' + (t.raw_bytes / 1024 / 1024).toFixed(2) + ' MiB）');
  L.push('- 节点：解析 ' + t.raw + ' → 去重 ' + t.unique + ' → TCP 存活 ' + (t.alive_tcp == null ? t.kept : t.alive_tcp) +
    ' → 真实代理验证 ' + (report.proxy_verified == null ? '跳过（null，未验证）' : report.proxy_verified) + ' → 最终写入 ' + t.kept);
  L.push('- 真实代理验证：' + (pr.ran
    ? ('mihomo 逐节点测 ' + String(pr.tested) + ' 个，通过 ' + String(pr.verified) + ' 个，耗时 ' + String(pr.seconds) + ' 秒' + (pr.partial ? '（**触到时间上限，未测完的按丢弃处理**）' : '') + (pr.cached ? '（本次读取缓存）' : ''))
    : ('**跳过**，原因 ' + c(String(pr.reason || 'unknown')) + '；' + c('proxy_verified') + ' 记为 ' + c('null') + '，不假装验证过')));
  L.push('- 丢弃大类：不安全 ' + t.insecure_dropped + '，内网/回环 ' + t.private_dropped + '，端口非法 ' + t.invalid_dropped + '，重复 ' + t.duplicates_dropped + '，TCP 不通 ' + t.dead_dropped);
  L.push('- 逐项丢弃原因（report.json 的 ' + c('drop_reasons') + ' 有完整计数）：' + Object.entries(report.drop_reasons || {}).sort(function (a, b) { return b[1] - a[1]; }).map(function (kv) { return kv[0] + '=' + kv[1]; }).join('、'));
  L.push('- 存活节点按类型：' + Object.entries(report.by_type || {}).map(function (kv) { return kv[0] + '=' + kv[1]; }).join(', '));
  const v = report.verify || {};
  L.push('- 真机自检：' + (v.ran ? (v.ok ? 'mihomo -t 通过' : 'mihomo -t 失败 — ' + v.message) : '跳过（' + (v.reason || '未找到 mihomo') + '）'));
  const pt = report.provider_test || {};
  const ptDropped = (pt.dropped || []).map(function (d) { return d.name + '：' + d.reason; }).join('；');
  L.push('- 发布前加载测试：' + (pt.ran
    ? (pt.ok
      ? ('整份 provider 被 mihomo 逐条解析通过（' + pt.nodes + ' 条）' + (ptDropped ? '，其中丢弃 ' + pt.dropped.length + ' 条 mihomo 拒收的条目（' + ptDropped + '）' : ''))
      : ('**失败** — ' + pt.message + '（这份文件可能无法被客户端加载）'))
    : '跳过（未找到 mihomo）'));
  const g = report.geodata || {};
  L.push('- GEOIP：' + (g.found ? '检测到 ' + c(g.file) + '，片段中含 GEOIP,PRIVATE / GEOIP,LAN' : '未检测到 geoip 数据库，片段中**不含** GEOIP 规则（只保留等价的 IP-CIDR 规则）'));
  L.push('');
  if (fastest.length) {
    L.push('最快 5 个（仅 TCP 握手 RTT，不代表真实下载速度）：');
    L.push('');
    L.push('| 名称 | 类型 | 服务器 | 端口 | RTT |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const f of fastest) L.push('| ' + f.name + ' | ' + f.type + ' | ' + f.server + ' | ' + f.port + ' | ' + f.rtt_ms + ' ms |');
    L.push('');
  }
  L.push('## 各阶段做了什么');
  L.push('');
  L.push('1. **fetch**：每个文件 20 秒超时。先用一个小文件把各下载通道各测一次');
  L.push('   （raw 直连 / 本地 7897 代理 / ghproxy.net / gh-proxy.com / jsdelivr），按实测延迟排序，');
  L.push('   失败的自动降级，原始字节落到 raw/。');
  L.push('2. **parse**：三种形态——base64 块、明文 URI 列表、Clash/Mihomo YAML。');
  L.push('   YAML 不写通用解析器，只按缩进切出 proxies 下的序列项，原文透传（只重写 name 行保证唯一）；');
  L.push('   URI 支持 vmess / vless / ss（SIP002 两种写法）/ trojan / hysteria2 / hy2 / tuic。');
  L.push('3. **供应链安全过滤**（任一命中即丢弃，每项都有独立计数器）：');
  L.push('   - 出现 skip-cert-verify / allowInsecure / allow-insecure / insecure 等键（**只要出现就算，值写 false 也算**），');
  L.push('     或 URI 里带 allowInsecure=1 / insecure=true / skip-cert-verify=true');
  L.push('   - trojan 没有 tls:true（trojan 不带 TLS 等于明文传密码）');
  L.push('   - vless 既无 TLS 也无 REALITY；REALITY 存在但 public-key 为空');
  L.push('   - ss/ssr 用了未认证/已破的加密：none、plain、table、rc4、rc4-md5、des-cfb、bf-cfb、chacha20（非 poly1305），');
  L.push('     以及 AES 的 CFB/CTR 模式——它们有加密但没有任何完整性校验，中间人可以任意篡改比特而不被发现，');
  L.push('     shadowsocks 早在 2017 年就把它们和 RC4 一起废弃、只保留 AEAD。ssr 以前完全没检查加密方式，');
  L.push('     结果真的发布过一条 rc4-md5 的 SSR 节点（2026-10-26 的 nodepool-latest），现在两者共用同一份名单。');
  L.push('   - vmess 的 cipher/security/scy 为 none 或 zero');
  L.push('   - sni / servername / Host 直接写成裸 IP（无法做证书校验，正是把人逼去关校验的元凶）');
  L.push('   - **明文代理**：type 是 http / socks5 / socks4 / socks4a / http-connect 的一律丢弃。');
  L.push('     这类中继自身不做任何加密：运营者能读改写你所有 http:// 内容、能看到你访问了哪些域名，');
     L.push('     它们也正是开放中继与蜜罐的重灾区。确实需要时用 ' + c('--allow-plaintext') + ' 显式放开。');
  L.push('   - 服务器落在 10/8、127/8、169.254/16、172.16/12、192.168/16、100.64/10、::1、fc00::/7、fe80::/10、localhost');
  L.push('   - 端口不在 1..65535，或 (type, server, port) 重复');
  L.push('   - 去重两道键：先按 ' + c('(type, server, port)') + ' 折叠端点，再按内容 ' + c('(type, server, port, uuid/password)') + ' 折叠完全相同的副本；');
  L.push('     排序在去重之前完成，所以「留下哪一个」只由数据决定，与抓取顺序无关。');
  L.push('3b. **格式兼容性预检（' + c('lib/adapter.mjs') + '，不是安全策略，而是「mihomo 的解析器能不能读」）**：');
  L.push('   安全过滤回答「这个节点该不该发布」，这一步回答「这个条目会不会让 mihomo 拒绝整份配置」。');
  L.push('   两者必须分开：mihomo 遇到第一个致命字段就整份失败，**一个坏节点能拖垮整个测速阶段和发布**');
  L.push('   （真实事故：' + c('ss … cipher: null') + ' 让 fidelity probe 每次启动即退出，30 次重试预算全烧在剔节点上；');
  L.push('   ' + c('POOL: \'14\' not found') + ' 让第 9 阶段的 provider 载入测试直接 FATAL）。');
  L.push('   规则全部是**实测**出来的，不是猜的：把单节点配置喂给本仓库固定的 mihomo 二进制（v1.19.33）跑 ' + c('-t') + '，');
  L.push('   记录它接受/拒绝哪些写法（见 ' + c('.verify/methodprobe*.mjs') + '、测试用例在 ' + c('test/adapter.test.mjs') + '）：');
  L.push('   - ss 加密方法白名单（大小写敏感！' + c('AES-256-GCM') + ' 会被判为 unknown method）；');
  L.push('   - 2022-blake3 的密钥必须是**带 padding 的标准 base64**、长度等于算法要求（16/32 字节），');
  L.push('     且 ' + c('serverkey:userkey') + ' 多段形式每一段都要合法——这是真实节点最常见的写法，只验证整串会误杀；');
  L.push('   - REALITY 的 ' + c('public-key') + ' 必须是 **unpadded base64url** 的 32 字节（用标准 base64 会被判 invalid）；');
  L.push('     ' + c('short-id') + ' 必须是偶数长度的十六进制、2~16 位；');
  L.push('   - ss 插件的必填项（obfs 需要 mode=tls/http；v2ray-plugin、gost-plugin 需要 mode=websocket；');
  L.push('     shadow-tls 需要 host；restls 需要 password + version-hint）；');
  L.push('   - 各类型的必填字段（ss: cipher+password、vmess: uuid+alterId、vless: uuid、trojan: password、anytls: password…）；');
  L.push('   - 字段形状：' + c('alpn') + ' 写成字符串会被判 not a slice，' + c('ws-opts.headers') + ' 写成字符串会被判 expected a map；');
  L.push('   - 未知代理类型（unsupport proxy type）。');
  L.push('   每条丢弃都进 ' + c('drop_reasons') + ' 的 ' + c('adapter_*') + ' 桶，**能证明致命才丢**：');
  L.push('   无从证明的写法一律放行，宁可让第 9 阶段的真机载入测试兜底，也不凭猜想丢掉一个可用节点。');
  L.push('4. **存活性预筛（TCP）**：TCP connect，2000 ms 超时，150 并发，最多 4000 个候选，记录 RTT（失败重试一次）。');
  L.push('   名额按类型轮转分配（' + c('stratifyByType') + '）：直接截断排序后的列表会让字母序靠前的 http/socks5 吃光全部名额，');
  L.push('   最终池子变成清一色明文代理——这正是早期版本真实发生过的偏差。');
  L.push('   这一步只证明「有人在这个端口上接电话」，**不证明它能当代理用**。');
  L.push('5. **真实代理验证（fidelity probe，CI 的核心价值）**：TCP 通过后，用一份临时配置起一个私有 mihomo，');
  L.push('   把全部存活节点塞进去（外加一个 ' + c('url-test') + ' 组），通过 ' + c('external-controller: 127.0.0.1:9090') + ' 的 REST 接口');
  L.push('   逐个向 ' + c('https://www.gstatic.com/generate_204') + ' 测延迟，**只保留返回 delay > 0 的节点**。');
  L.push('   二进制来源依次是 ' + c('MIHOMO_BIN') + ' 环境变量 / 本目录 ' + c('bin/') + ' / 按 runner 架构下载最新 release。');
  L.push('   如果 mihomo 不可用、或 API 在超时内没有任何响应，**整个阶段跳过**，报告里 ' + c('proxy_verified') + ' 写 ' + c('null') + ' 并在日志里大声说明——');
  L.push('   绝不用「TCP 通」冒充「验证过」。');
  L.push('6. **输出**：' + c('out/nodepool.yaml') + '（provider YAML，2 空格缩进、UTF-8、LF）、' + c('out/nodes.txt') + '、');
  L.push('   ' + c('out/nodepool.patch.yaml') + '、' + c('out/sources.json') + '、' + c('out/report.json') + '、本 README。');
  L.push('   输出按 ' + c('(type, server, port, name)') + ' 排序、名字去重成 ' + c('name') + ' / ' + c('name-2') + ' / …，');
  L.push('   所以同样的输入两次运行会产出**逐字节相同**的文件（git 不会看到无意义的抖动）。');
  L.push('7. **自检（真机验证）**：如果本机装了 mihomo / Clash Verge，就在临时目录里用 ' + c('-t') + ' 把');
  L.push('   生成的片段连同 provider 一起真正加载一遍（跑完删掉临时目录），结果记在 report.json 的 ' + c('verify') + '。');
  L.push('   同时会检测机器上是否存在 geoip 数据库：有才写 GEOIP 规则，没有就不写——');
  L.push('   因为 mihomo 遇到 GEOIP 规则但找不到 mmdb 时会整份配置加载失败（' + c('can\'t download MMDB') + '）。');
  L.push('   注意 ' + c('-t') + ' 对 ' + c('providers:') + ' 是**惰性**的：它只证明配置本身能读，不证明 provider 里的条目能读。');
  L.push('   所以还会把 provider 整份内联进一份临时配置再 ' + c('-t') + ' 一遍，把 mihomo 明确拒收的条目剔掉再发布，');
  L.push('   结果记在 ' + c('provider_test') + '。实测抓到过三类真实故障：裸横杠标量（' + c('path: -') + '，整份 YAML 解析失败）、');
  L.push('   字符串布尔（' + c('tls: "true"') + '）、REALITY 公钥/短 ID 非法——任何一条都足以让客户端拒绝加载整份文件。');
  L.push('');
  L.push('## 局限与风险（请务必读完）');
  L.push('');
  L.push('- **节点是别人的服务器。** 免费公共节点由陌生人运营，随时可能抓包、篡改或下线。');
  L.push('- **寿命很短。** 通常几小时到几天就失效；输出只是一次性快照，需要定时重跑。');
  L.push('- **TCP 预筛可能被中间盒欺骗。** 部分运营商/防火墙会对任意目标端口立即回 SYN-ACK');
  L.push('  （实测本机对几个境外 IP 的 110 端口在 1~2 ms 内就"握手成功"），因此 RTT 极低的节点');
  L.push('  未必真的可达，更不代表能跑代理协议。');
  L.push('- **速度不可预测。** RTT 低不等于带宽高，TCP 通也不等于能跑代理。');
  L.push('  CI 模式下会做真实的一次 ' + c('generate_204') + ' 代理测速（' + c('proxy_verified') + '），但那只是「此刻能连上」；');
  L.push('  本地跑且没有 mihomo 时该阶段会被跳过，报告里是 ' + c('null') + ' 而不是 0。');
  L.push('- **POOL 是默认出口，这是刻意的取舍。** 当前片段以 ' + c('MATCH,POOL') + ' 结尾，');
  L.push('  所以所有流量（包括你的日常浏览）都会经过陌生人的服务器：能保证的是内容有 HTTPS 加密，');
  L.push('  不能保证的是节点不记录 SNI/DNS、不注入内容、不随时断线。想收回控制权就改回 ' + c('MATCH,DIRECT') + '。');
  L.push('- **速度上限就是单个免费节点。** url-test 只会挑当前延迟最低的那个，不会做多节点聚合，');
  L.push('  所以整机带宽/并发受制于一台很可能被上百人共用的机器。');
  L.push('- **没有任何节点被验证为安全。** 过滤只是排除了「明示跳过证书校验 / 弱加密 / SNI 是裸 IP / 指向内网」这些');
  L.push('  可以从文本上判定的坏味道，**不等于节点可信**，也不保证它没有在做中间人。');
  L.push('  这不等于节点可信。不要在 POOL 上登录任何账号。');
  L.push('- **合规提醒。** 请遵守你所在地区的法律法规与所用服务的条款。');
  L.push('');
  L.push('## 数据源状态（本次运行）');
  L.push('');
  for (const s of okSources) {
    L.push('- ' + c((s.canonical || s.repo) + (s.path ? ' :: ' + s.path : '')) + ' — HTTP ' + s.status + '，' + s.bytes + ' B，解析 ' + (s.parsed || 0) + ' 个' + (s.transport ? '（通道 ' + s.transport + '）' : ''));
  }
  if (badSources.length) {
    L.push('');
    L.push('失败 / 跳过：');
    L.push('');
    for (const s of badSources) L.push('- ' + c((s.canonical || s.repo) + (s.path ? ' :: ' + s.path : '')) + ' — ' + (s.error || ('HTTP ' + s.status)));
  }
  L.push('');
  await fs.writeFile(path.join(root, 'README.md'), L.join('\n') + '\n', 'utf8');
}
