# tier2-cn.ps1 - 在大陆这台机器上跑第二级验证（配合 Windows 计划任务）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\tier2-cn.ps1
#   ... -Rounds 3 -Interval 15 -Throughput 10 -Candidates out\nodepool.yaml
#   ... -Release <owner>/<repo>      # 没给 -Candidates 时，从 release 拉候选（走 gh-proxy 镜像）
#
# 计划任务（每 2 小时）：
#   schtasks /Create /TN nodepool-tier2 /SC HOURLY /MO 2 /F /RL LIMITED \
#     /TR "powershell -ExecutionPolicy Bypass -File C:\UGit\nodepool\scripts\tier2-cn.ps1 -Release <owner>/<repo>"
param(
  [int]$Rounds = 3,
  [int]$Interval = 15,
  [int]$Throughput = 10,
  [string]$Candidates = '',
  [string]$Release = '',
  [string]$Out = 'out\nodepool-cn.yaml',
  [string]$Report = 'out\cn-report.json'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path out, .verify | Out-Null
$log = Join-Path '.verify' ('tier2-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

function Log($m) { $line = (Get-Date -Format 'HH:mm:ss') + ' ' + $m; Write-Host $line; Add-Content -Path $log -Value $line -Encoding utf8 }

try {
  if (-not $Candidates) {
    if (-not $Release) { throw 'need -Candidates <file> or -Release <owner>/<repo>' }
    $Candidates = 'out\nodepool.yaml'
    $url = 'https://gh-proxy.com/https://github.com/' + $Release + '/releases/download/nodepool-latest/nodepool.yaml'
    Log ('fetching candidates via mirror: ' + $url)
    curl.exe -sSL --retry 3 --max-time 120 -o $Candidates $url
    if ($LASTEXITCODE -ne 0) { throw ('curl failed: ' + $LASTEXITCODE) }
  }
  if (-not (Test-Path $Candidates)) { throw ('no candidate file: ' + $Candidates) }

  Log 'running verify-cn (this takes 2-4 minutes)'
  $args = @('verify-cn.mjs', '--input', $Candidates, '--out', $Out, '--report', $Report,
            '--rounds', $Rounds, '--interval', ($Interval * 1000), '--throughput', $Throughput)
  & node @args 2>&1 | ForEach-Object { Log $_ }
  $code = $LASTEXITCODE
  if ($code -eq 4) { Log 'no node passed from this vantage point (exit 4)'; exit 4 }
  if ($code -ne 0) { throw ('verify-cn exit ' + $code) }
  Log ('done: ' + $Out + ' / ' + $Report)
  # keep the last 20 logs
  Get-ChildItem .verify\tier2-*.log | Sort-Object LastWriteTime -Descending | Select-Object -Skip 20 | Remove-Item -Force -ErrorAction SilentlyContinue
  exit 0
} catch {
  Log ('FAILED: ' + $_.Exception.Message)
  exit 1
}