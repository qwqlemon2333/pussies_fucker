// lib/patch.mjs - mihomo config fragment (NOT a full config).
export const POOL_DOMAINS = [
  'github.com', 'api.github.com', 'codeload.github.com', 'raw.githubusercontent.com',
  'gist.github.com', 'gist.githubusercontent.com', 'objects.githubusercontent.com',
  'ghcr.io', 'pkg-containers.githubusercontent.com', 'githubassets.com',
  'android.googlesource.com', 'dl.google.com', 'storage.googleapis.com',
  'crates.io', 'index.crates.io', 'static.crates.io', 'registry.npmjs.org',
  'pypi.org', 'files.pythonhosted.org',
];
export const POOL_SUFFIXES = ['githubusercontent.com', 'github.io', 'googlesource.com'];

// Bypass rules that MUST precede the catch-all: without them POOL (and its health
// checks) would also swallow loopback / LAN / link-local traffic and break local services.
export const BYPASS_RULES = [
  'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
  'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
  'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
  'IP-CIDR,100.64.0.0/10,DIRECT,no-resolve',
  'IP-CIDR6,::1/128,DIRECT,no-resolve',
  'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
  'IP-CIDR6,fe80::/10,DIRECT,no-resolve',
  'DOMAIN-SUFFIX,local,DIRECT',
  'DOMAIN-SUFFIX,localhost,DIRECT',
  'DOMAIN-SUFFIX,lan,DIRECT',
];

// Only emitted when the target mihomo build can resolve GEOIP: without a geodata file
// mihomo refuses to load the whole config ('can't download MMDB'), so these are opt-in.
export const GEOIP_RULES = ['GEOIP,PRIVATE,DIRECT,no-resolve', 'GEOIP,LAN,DIRECT,no-resolve'];

function header(geoip) {
  const h = [
    '# ============================================================================',
    '# nodepool.patch.yaml - mihomo / Clash Verge 配置片段（不是完整配置！）',
    '#',
    '# 用法：把下面三段（proxy-providers / proxy-groups / rules）分别粘贴进你的',
    '# mihomo config.yaml 对应位置。若已有同名段，请合并而不是整体覆盖。',
    '# 本片段假设 provider 文件位于 ./providers/nodepool.yaml（相对配置目录）。',
    '#',
    '# ★ 注意：本片段的最后一条规则是 MATCH,POOL —— POOL 会成为全部流量的默认出口，',
    '#   整台机器的上网速度/稳定性由“当前最快的那一个免费节点”决定。这些节点由陌生人运营、',
    '#   寿命通常只有几小时到几天，随时可能变慢、断流。请只把它当作开发/抓取用途的备用出口，',
    '#   不要用它登录网银、公司系统或任何重要账号（详见 README 的「局限与风险」）。',
    '#',
    '# ★ MATCH,POOL 之前是本地/内网绕行规则：没有它们，回环、局域网、链路本地地址也会被',
    '#   塞进代理，本地服务（NAS、打印机、127.0.0.1 调试端口……）会直接坏掉。这些 CIDR 规则',
    '#   不依赖任何地理数据库，任何 mihomo 构建都能用。',
  ];
  if (geoip) {
    h.push('# ★ 另一组 GEOIP,PRIVATE / GEOIP,LAN 规则需要 geoip 数据库（geoip.metadb / Country.mmdb）；');
    h.push('#   本次生成时在机器上检测到了这类文件，所以保留。若你的构建缺这个文件，mihomo 会拒绝加载整份');
    h.push('#   配置并提示 "can\'t download MMDB"，此时删掉这两条即可——上面的 IP-CIDR 规则覆盖同样的地址段。');
  } else {
    h.push('# ★ 本次生成时没有在机器上找到 geoip 数据库，所以这里【没有】写 GEOIP,PRIVATE / GEOIP,LAN 规则：');
    h.push('#   mihomo 遇到 GEOIP 规则却找不到 mmdb 时会直接加载失败（"can\'t download MMDB"）。');
    h.push('#   如果你的 mihomo 有 geoip.metadb / Country.mmdb，可以自行在这组 IP-CIDR 规则后补两行：');
    h.push('#     - GEOIP,PRIVATE,DIRECT,no-resolve');
    h.push('#     - GEOIP,LAN,DIRECT,no-resolve');
  }
  h.push('#',
    '# ★ 如果你不想要“全流量走 POOL”，把最后一行 MATCH,POOL 换成 MATCH,DIRECT，',
    '#   只保留上面对开发者域名的分流即可。',
    '# ============================================================================',
    '',
  );
  return h;
}

export function buildPatch(opts) {
  const geoip = !opts || opts.geoip !== false;
  const lines = header(geoip);
  lines.push('proxy-providers:');
  lines.push('  nodepool:');
  lines.push('    type: file');
  lines.push('    path: ./providers/nodepool.yaml');
  lines.push('    interval: 3600');
  lines.push('    health-check:');
  lines.push('      enable: true');
  lines.push('      url: https://api.github.com/');
  lines.push('      interval: 300');
  lines.push('');
  lines.push('proxy-groups:');
  lines.push('  - name: POOL');
  lines.push('    type: url-test');
  lines.push('    use: [nodepool]');
  lines.push('    url: https://api.github.com/');
  lines.push('    interval: 300');
  lines.push('    tolerance: 50');
  lines.push('');
  lines.push('rules:');
  // 1) developer domains that are known to need the pool first (kept, still useful)
  for (const d of POOL_DOMAINS) lines.push('  - DOMAIN,' + d + ',POOL');
  for (const s of POOL_SUFFIXES) lines.push('  - DOMAIN-SUFFIX,' + s + ',POOL');
  // 2) local / private bypass so the proxy cannot break LAN traffic
  for (const r of BYPASS_RULES) lines.push('  - ' + r);
  if (geoip) for (const r of GEOIP_RULES) lines.push('  - ' + r);
  // 3) everything else also goes through the pool
  lines.push('  - MATCH,POOL');
  return lines.join('\n') + '\n';
}
