#requires -version 7
<#
.SYNOPSIS
  官方上游服务端 × 本实现 的逐条 A/B 探测：既做一次性对照，也可当作**可复用守卫**。

.DESCRIPTION
  本仓库的兼容性主张有两类证据：套件里的黑盒断言（对照"我们读懂的协议"）与**真上游服务端**的实测对照。
  后者此前缺失，因为旧结论认为"本机无 .NET"。实际上：本机**没有 SDK**，但**有 ASP.NET Core 8 运行时**，
  而上游 release 直接提供了框架依赖型的服务端发布件 —— 于是可以直接把官方服务端跑起来做 A/B。

  准备（一次性）：
    gh release download v3.2.0 -R Jeric-X/SyncClipboard -p 'SyncClipboard.Server.zip' -D $env:TEMP\scsrv-upstream
    Expand-Archive $env:TEMP\scsrv-upstream\SyncClipboard.Server.zip -DestinationPath $env:TEMP\scsrv-upstream\app
    # run 目录里**先自写** appsettings.json：发布件默认绑 http://*:5033（所有网卡），务必改回环
    #   { "Kestrel": { "Endpoints": { "http": { "Url": "http://127.0.0.1:5033" } } },
    #     "AppSettings": { "UserName": "abtest", "Password": "…", "MaxSavedHistoryCount": 1000 } }
    $env:SYNCCLIPBOARD_USERNAME='abtest'; $env:SYNCCLIPBOARD_PASSWORD='…'
    dotnet $env:TEMP\scsrv-upstream\app\SyncClipboard.Server.dll --contentRoot $env:TEMP\scsrv-upstream\run

  本实现一侧：`npx wrangler dev --test-scheduled --port 8787 --ip 127.0.0.1`（凭据取自 .dev.vars）。

.OUTPUTS
  逐条打印两边状态码 / `Allow` / `WWW-Authenticate`，并分三类标注：
    [一致]     两边三者全同
    [已知偏离] 不同，但**已在 docs/protocol.md §10 登记**（脚本里 `known=$true`，注释给出登记理由）
    [差异]     不同且**未登记** ⇒ 计入退出码（非 0），这就是需要修的东西
  第二段"文本级对照"逐字比较 negotiate 的协商结果与错误串（响应体本身即契约）。

.NOTES
  **适用边界**：发布件是 `v3.2.0` 标签，比本项目迁移基线 `28c7e596` 早 14 个提交。这区间服务端只有两处
  改动（`Web.cs` 仅加 HistoryRetentionMinutes；`HistoryController.cs` 仅加一个 422 的 catch 分支），
  故**框架 / 路由 / 绑定层**的对照结论可直接迁移到基线。涉及 `GroupProfile` / `TextProfile` /
  `HistoryManagerHelper`（这区间改动最大的文件）的行为**不能**用发布件对照，需要 SDK 从基线源码构建。
#>
param(
  [string]$UpstreamBase = 'http://127.0.0.1:5033',
  [string]$UpstreamUser = 'abtest',
  [string]$UpstreamPass = 'abtest-only-local',
  [string]$LocalBase = 'http://127.0.0.1:8787',
  [string]$LocalUser = 'admin',
  [string]$LocalPass = 'admin'
)

$ErrorActionPreference = 'Stop'

function New-Basic([string]$u, [string]$p) {
  'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${u}:${p}"))
}

# 统一用 curl.exe 发请求：它能发 PROPFIND/MKCOL 这类自定义方法、能发 multipart，
# 且是独立于 PowerShell 的 HTTP 客户端（少一层实现差异）。
function Invoke-Curl {
  param([string]$Base, $Case, [string]$ValidAuth)

  $bodyFile = [IO.Path]::GetTempFileName()
  $hdrFile = [IO.Path]::GetTempFileName()
  try {
    $a = @('-s', '-o', $bodyFile, '-D', $hdrFile, '-w', '%{http_code}', '-X', $Case.method)
    if ($Case.auth -eq 'valid') { $a += @('-H', "Authorization: $ValidAuth") }
    elseif ($Case.auth -ne 'none') { $a += @('-H', "Authorization: $($Case.auth)") }
    if ($Case.ct) { $a += @('-H', "Content-Type: $($Case.ct)") }
    if ($Case.form) { foreach ($k in $Case.form.Keys) { $a += @('-F', "$k=$($Case.form[$k])") } }
    elseif ($null -ne $Case.body) { $a += @('--data-binary', $Case.body) }
    $a += "$Base$($Case.path)"

    $status = (& curl.exe @a) | Select-Object -Last 1
    $head = Get-Content $hdrFile -Raw
    $body = [string](Get-Content $bodyFile -Raw)
    # 上游的 ProblemDetails 是 UTF-8 JSON，但 curl 落盘后按 ANSI 读会变字节串 —— 统一按 UTF-8 重读
    if ($body -match '^\s*(\d+\s+){6,}') {
      $bytes = [byte[]](($body -split '\s+') | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [byte]$_ })
      $body = [Text.Encoding]::UTF8.GetString($bytes)
    }
    if ($body.Length -gt 180) { $body = $body.Substring(0, 180) + '…' }
    $body = ($body -replace '\s+', ' ')

    [pscustomobject]@{
      status  = [int]$status
      allow   = if ($head -match '(?im)^Allow:\s*(.+)$') { $Matches[1].Trim() } else { '' }
      wwwAuth = if ($head -match '(?im)^WWW-Authenticate:\s*(.+)$') { $Matches[1].Trim() } else { '' }
      ctype   = if ($head -match '(?im)^Content-Type:\s*(.+)$') { $Matches[1].Trim() } else { '' }
      body    = $body
    }
  }
  finally { Remove-Item $bodyFile, $hdrFile -Force -ErrorAction SilentlyContinue }
}

$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$text = "ab-probe-$stamp"
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))) -replace '-', '').ToUpper()

function C([string]$name, [string]$method, [string]$path, [string]$auth = 'valid', $body = $null, $ct = $null, $form = $null, [bool]$known = $false) {
  [pscustomobject]@{ name = $name; method = $method; path = $path; auth = $auth; body = $body; ct = $ct; form = $form; known = $known }
}

# ------------------------------------------------------------------ 用例表
# known=$true 的行必须在 docs/protocol.md §10 有对应登记（注释写明是哪一条）。
$cases = @(
  C '1  GET /api/version（无凭据）' 'GET' '/api/version' 'none'
  C '2  GET /api/version（Basic 后无空格）' 'GET' '/api/version' 'BasicYWJ0ZXN0' $null $null $null $true   # §10「畸形 Authorization 头」：上游 500 / 本实现 401
  C '3  GET /api/version（凭据无冒号）' 'GET' '/api/version' 'Basic YWJ0ZXN0' $null $null $null $true
  C '4  GET /api/version（非 base64）' 'GET' '/api/version' 'Basic !!!' $null $null $null $true
  C '5  HEAD /api/version' 'HEAD' '/api/version' 'valid' $null $null $null $true                          # §10「非 /file 路径上的 HEAD」：上游 405 / 本实现 200
  C '6  HEAD /' 'HEAD' '/' 'valid' $null $null $null $true
  C '7  POST /（方法不匹配）' 'POST' '/' 'valid' '' $null $null $true                                      # §10「方法不匹配」：上游 405+Allow / 本实现 404
  C '8  PROPFIND /' 'PROPFIND' '/' 'valid' $null $null $null $true                                         # §10「PROPFIND 响应」：上游 200 空体 / 本实现 207
  C '9  PUT /SyncClipboard.json（文本 profile）' 'PUT' '/SyncClipboard.json' 'valid' (@{ type = 'Text'; hash = $hash; text = $text; size = $text.Length; hasData = $false; version = 0; isDeleted = $false } | ConvertTo-Json -Compress) 'application/json'
  C '10 GET /SyncClipboard.json（回读第 9 条）' 'GET' '/SyncClipboard.json'
  C '11 POST /api/history（application/json）' 'POST' '/api/history' 'valid' '{"hash":"x"}' 'application/json'
  C '12 POST /api/history（无 Content-Type）' 'POST' '/api/history' 'valid' 'x'
  C '13 POST /api/history/query（urlencoded）' 'POST' '/api/history/query' 'valid' 'Page=1&PageSize=5' 'application/x-www-form-urlencoded'
  C '14 POST /api/history/query（JSON body）' 'POST' '/api/history/query' 'valid' '{"page":1}' 'application/json' $null $true   # §10「query 收到非表单媒体类型」：上游 200 默认页 / 本实现 400
  C '15 POST /api/history/query（multipart）' 'POST' '/api/history/query' 'valid' $null $null @{ Page = '2'; PageSize = '5' }
  C '16 GET /' 'GET' '/' 'valid'
  C '17 GET /api/time' 'GET' '/api/time' 'valid'
  C '18 PUT /file/abprobe.txt（暂存，客户端同路径）' 'PUT' '/file/abprobe.txt' 'valid' 'hello-ab' 'text/plain'
  C '19 GET /file/abprobe.txt（非历史文件 → 两边都应 404）' 'GET' '/file/abprobe.txt'
  C '20 DELETE /file/abprobe.txt' 'DELETE' '/file/abprobe.txt' 'valid' $null $null $null $true             # §10「DELETE /file/{name}」：上游无该路由（405+Allow）/ 本实现补全
  C '21 MKCOL /file' 'MKCOL' '/file' 'valid'
  C '22 POST /SyncClipboardHub/negotiate?negotiateVersion=2' 'POST' '/SyncClipboardHub/negotiate?negotiateVersion=2'
  C '23 POST /SyncClipboardHub/negotiate?negotiateVersion=-1' 'POST' '/SyncClipboardHub/negotiate?negotiateVersion=-1'
  C '24 POST /SyncClipboardHub/negotiate（无参数）' 'POST' '/SyncClipboardHub/negotiate'
  C '25 GET /api/history/statistics' 'GET' '/api/history/statistics'
  C '26 GET /api/history/Text-ABC（不存在的 hash）' 'GET' '/api/history/Text-ABC'
  C '27 GET /api/history/Text-<前缀>%（LIKE 通配符）' 'GET' "/api/history/Text-$($hash.Substring(0, 8))%25" 'valid' $null $null $null $true   # §10「hash 的匹配方式」：上游 LIKE 误命中 / 本实现等值
  C '28 POST /api/history（multipart 种子）' 'POST' '/api/history' 'valid' $null $null @{ hash = $hash; type = 'Text'; text = $text; size = "$($text.Length)"; version = '0'; isDeleted = 'false' }
  C '29 GET /api/history/{种子 hash}' 'GET' "/api/history/Text-$hash"
  C '30 POST /api/history（version/size 非数字 → TryParse 语义）' 'POST' '/api/history' 'valid' $null $null @{ hash = "TRY$stamp"; type = 'Text'; text = 'tryparse'; size = '1e999'; version = '3abc'; isDeleted = 'false' }
  C '31 GET /api/history/Statistics（大小写变体）' 'GET' '/api/history/Statistics' 'valid'                        # 路径字面段归一（src/pathCase.ts）：上游 200 / 本实现现亦 200
  C '32 GET /API/version（大小写变体）' 'GET' '/API/version' 'valid'
  C '33 GET /SyncClipboard.JSON（大小写变体）' 'GET' '/SyncClipboard.JSON' 'valid'
  C '34 GET /api/history/Unknown-ABC（非法类型枚举）' 'GET' '/api/history/Unknown-ABC'
)

# --------------------------------------------- 文本级对照：响应体即契约的用例
# negotiate 的协商结果与错误串是**响应体本身**，必须逐字比较；这里单列一段用精确比较。
$negoValues = @(
  '1', '0', '2', 'abc', '1.5', '1,5', '+1', '01', '-0', '-1', '2147483647', '2147483648',
  '-2147483648', '-2147483649', '99999999999', '%20abc%20', '%201%20', '%2B'
)

$upAuth = New-Basic $UpstreamUser $UpstreamPass
$locAuth = New-Basic $LocalUser $LocalPass

function Describe($r) {
  if ($r.body -match '"error"') {
    $m = [regex]::Match($r.body, '"error":"(?<e>[^"]*)"')
    "error=$($m.Groups['e'].Value)"
  }
  else {
    $v = [regex]::Match($r.body, '"negotiateVersion":(?<v>\d+)').Groups['v'].Value
    $t = if ($r.body -match '"connectionToken"') { '有' } else { '无' }
    "v=$v token=$t"
  }
}

Write-Host "上游（官方 v3.2.0 发布件）: $UpstreamBase      本实现（wrangler dev）: $LocalBase" -ForegroundColor Cyan
Write-Host "种子文本 = $text    hash = $hash" -ForegroundColor DarkGray
Write-Host ''

# ============================== 第一段：状态码级对照 ==============================
$known = 0; $unknown = 0
foreach ($c in $cases) {
  $u = Invoke-Curl -Base $UpstreamBase -Case $c -ValidAuth $upAuth
  $l = Invoke-Curl -Base $LocalBase -Case $c -ValidAuth $locAuth
  $same = ($u.status -eq $l.status) -and ($u.allow -eq $l.allow) -and ($u.wwwAuth -eq $l.wwwAuth)
  $tag = if ($same) { '一致' } elseif ($c.known) { '已知偏离' } else { '差异' }
  if ($same) { }
  elseif ($c.known) { $known++ } else { $unknown++ }
  $color = switch ($tag) { '一致' { 'Green' } '已知偏离' { 'DarkGray' } default { 'Yellow' } }
  Write-Host "[$tag] $($c.name)" -ForegroundColor $color
  if (-not $same) {
    Write-Host ("    上游   : {0}  allow='{1}'  www-auth='{2}'" -f $u.status, $u.allow, $u.wwwAuth)
    Write-Host ("    本实现 : {0}  allow='{1}'  www-auth='{2}'" -f $l.status, $l.allow, $l.wwwAuth)
    if ($u.body -ne $l.body -and $u.body.Length + $l.body.Length -gt 0) {
      Write-Host ("    上游体 : {0}" -f $u.body) -ForegroundColor DarkGray
      Write-Host ("    本实现体: {0}" -f $l.body) -ForegroundColor DarkGray
    }
  }
}

# ============================== 第二段：文本级对照（negotiate） ==============================
Write-Host ''
Write-Host '=== negotiate 协商结果 / 错误串逐字对照 ===' -ForegroundColor Cyan
$negoUnknown = 0
foreach ($v in $negoValues) {
  $c = C "negotiateVersion=$v" 'POST' "/SyncClipboardHub/negotiate?negotiateVersion=$v"
  $u = Invoke-Curl -Base $UpstreamBase -Case $c -ValidAuth $upAuth
  $l = Invoke-Curl -Base $LocalBase -Case $c -ValidAuth $locAuth
  $ud = Describe $u; $ld = Describe $l
  $same = ($u.status -eq $l.status) -and ($ud -eq $ld)
  if (-not $same) { $negoUnknown++ }
  $mark = if ($same) { '  ' } else { '≠ ' }
  $col = if ($same) { 'Green' } else { 'Yellow' }
  Write-Host ("{0}{1,-16} 上游: {2,-58} 本实现: {3}" -f $mark, $v, $ud, $ld) -ForegroundColor $col
}

Write-Host ''
Write-Host ("状态码级：一致 {0} / 已知偏离 {1} / **未登记差异 {2}**（共 {3} 例）" -f ($cases.Count - $known - $unknown), $known, $unknown, $cases.Count) -ForegroundColor Cyan
Write-Host ("negotiate 文本级：未登记差异 {0}（共 {1} 例）" -f $negoUnknown, $negoValues.Count) -ForegroundColor Cyan
if (($unknown + $negoUnknown) -eq 0) {
  Write-Host '⇒ 没有未登记差异：两边在探测到的边界行为上一致（或差异都已登记）。' -ForegroundColor Green
}
exit ($unknown + $negoUnknown)
