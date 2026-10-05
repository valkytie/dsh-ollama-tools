# dsh-restart-web.ps1
# 由 dsh-ollama-tools 安裝流程觸發：等待一段時間後重啟 dsh web，
# 讓新插件（dsh-ollama-tools）生效，並把結果寫進 dsh-restart-result.txt。
# 若新插件導致開機失敗，會自動以停用該插件的 patch 再啟動一次，確保 GUI 不會開不起來。

$ErrorActionPreference = 'Continue'
$ResultFile = 'D:\dsh use\dsh-restart-result.txt'
$ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$HomeDir = Join-Path $env:USERPROFILE '.dsh'
$WorkDir = 'D:\dsh use'
$Port = 3080
$DelaySeconds = 100
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$NpxCli = 'C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js'

# --- DSH 版本 pin（2026-10-05）------------------------------------------------
# 原本用 `npx --yes @deepseek-ai/dsh`（不帶版號），npx 每次啟動都會去 registry
# 問 latest 並在必要時「默默升級」。2026-10-05 上游把 latest 指向 0.2.0-rc.2，
# 那次重啟就等於在未告知使用者的情況下把 runtime 升級了，而 0.2.0 改了 settings
# 服務介面（settings.yaml 廢除、值改住 profile patch），導致外掛的設定面板失效。
#
# 因此改為固定版號啟動：不再浮動、不再被動升級。
# 要主動升級時，把下面的 $DshVersion 改成新版號（或設環境變數 DSH_VERSION 覆寫）。
$DshVersion = '0.2.0-rc.2'
if ($env:DSH_VERSION) { $DshVersion = $env:DSH_VERSION }
$DshPackage = "@deepseek-ai/dsh@$DshVersion"
$FallbackPatch = Join-Path $HomeDir 'dsh-fallback-disable-ollama-tools.yml'

function Say([string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $ResultFile -Value $line -Encoding UTF8
}

function Test-PortUp([int]$p) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $p)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

function Read-LogSafe([string]$Path) {
    try { if (Test-Path -LiteralPath $Path) { return (Get-Content -Raw -LiteralPath $Path) } } catch { }
    return ''
}

function Stop-DshWeb {
    $pids = New-Object System.Collections.Generic.List[int]
    foreach ($candidate in 29612, 15012) {
        $info = Get-CimInstance Win32_Process -Filter "ProcessId=$candidate" -ErrorAction SilentlyContinue
        if ($info -and $info.CommandLine -and ($info.CommandLine -match '@deepseek-ai') -and ($info.CommandLine -match 'dsh')) {
            $pids.Add($candidate)
        }
    }
    foreach ($proc in Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue) {
        $cl = $proc.CommandLine
        if (-not $cl) { continue }
        if ($cl -match '@deepseek-ai[\\/]dsh' -and $cl -match '(^|\s)web(\s|$|")') { $pids.Add([int]$proc.ProcessId) }
    }
    foreach ($id in ($pids | Select-Object -Unique)) {
        try {
            Stop-Process -Id $id -Force -ErrorAction Stop
            Say "stopped dsh web pid $id"
        } catch {
            Say "could not stop pid ${id}: $($_.Exception.Message)"
        }
    }
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Test-PortUp $Port)) { return $true }
    }
    return $false
}

function Start-DshWeb([string[]]$ExtraArgs, [string]$OutLog, [string]$ErrLog) {
    # --yes 只用來略過 npx 的安裝確認；版號已固定，不會浮動升級。
    $args = @("`"$NpxCli`"", '--yes', $DshPackage, 'web', '--no-open') + $ExtraArgs
    Say "starting with pinned package $DshPackage"
    $p = Start-Process -FilePath $NodeExe -ArgumentList $args -WorkingDirectory $WorkDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
    Say "launched dsh web (pid $($p.Id))"
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 2
        if ((Read-LogSafe $OutLog) -match 'dsh web: http') { return $true }
        if ($p.HasExited) { break }
    }
    return $false
}

Set-Content -LiteralPath $ResultFile -Value ("[{0}] restart requested; waiting {1}s before touching the running dsh web" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $DelaySeconds) -Encoding UTF8
Say 'script is alive (this line proves the detached launcher works)'

# 備份 profile 設定，出問題可一鍵還原
try {
    Copy-Item (Join-Path $ProfileDir 'package.json') (Join-Path $ProfileDir 'package.json.bak-restart') -Force
    Copy-Item (Join-Path $ProfileDir 'pnpm-lock.yaml') (Join-Path $ProfileDir 'pnpm-lock.yaml.bak-restart') -Force
    Say 'backed up package.json and pnpm-lock.yaml (*.bak-restart)'
} catch {
    Say "backup failed: $($_.Exception.Message)"
}

Start-Sleep -Seconds $DelaySeconds

Say 'stopping the running dsh web...'
$stopped = Stop-DshWeb
if (-not $stopped) { Say "warning: port $Port still answering after 30s" }

$outLog = Join-Path $HomeDir 'dsh-web.stdout.log'
$errLog = Join-Path $HomeDir 'dsh-web.stderr.log'
Say 'starting dsh web with the new plugin set...'
$ok = Start-DshWeb -ExtraArgs @() -OutLog $outLog -ErrLog $errLog

if ($ok) {
    $urlLine = ((Read-LogSafe $outLog) -split "`r?`n" | Where-Object { $_ -match 'dsh web: http' } | Select-Object -First 1)
    Say "OK: dsh web is up again -> $urlLine"
} else {
    Say 'first boot attempt FAILED; retrying with dsh-ollama-tools disabled'
    Say "--- stdout tail ---"
    Say ((Read-LogSafe $outLog) -split "`r?`n" | Select-Object -Last 25 | Out-String)
    Say "--- stderr tail ---"
    Say ((Read-LogSafe $errLog) -split "`r?`n" | Select-Object -Last 40 | Out-String)
    Stop-DshWeb | Out-Null
    $fbOut = Join-Path $HomeDir 'dsh-web-fallback.stdout.log'
    $fbErr = Join-Path $HomeDir 'dsh-web-fallback.stderr.log'
    $ok2 = Start-DshWeb -ExtraArgs @('--patch', "`"$FallbackPatch`"") -OutLog $fbOut -ErrLog $fbErr
    if ($ok2) {
        $urlLine = ((Read-LogSafe $fbOut) -split "`r?`n" | Where-Object { $_ -match 'dsh web: http' } | Select-Object -First 1)
        Say "FALLBACK OK: dsh web is up WITHOUT dsh-ollama-tools -> $urlLine"
        Say 'investigate dsh-web.stderr.log and the plugin, then re-enable it.'
    } else {
        Say 'FALLBACK FAILED too. Manual recovery: restore package.json.bak-restart / pnpm-lock.yaml.bak-restart, then run: dsh web'
    }
}
Say 'restart script finished'
