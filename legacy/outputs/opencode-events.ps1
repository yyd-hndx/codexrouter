param(
    [ValidateSet('Start', 'Status', 'Probe')][string]$Action = 'Status',
    [string]$ProbeSession
)
$ErrorActionPreference = 'Stop'
$eventWork = Join-Path (Split-Path $PSScriptRoot -Parent) 'work\opencode-bridge'
$runtimeFile = Join-Path $eventWork 'event-runtime.json'
$eventScript = Join-Path $PSScriptRoot 'opencode-events.cjs'
function Get-ListenerState {
    $result = @{ status = 'not_running' }
    if (Test-Path -LiteralPath $runtimeFile) {
        $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $($runtime.pid)" -ErrorAction SilentlyContinue
        if ($existing -and $existing.CommandLine -like "*$eventScript*") {
            $result = @{ pid = $runtime.pid; status = $runtime.status; pollIntervalMs = $runtime.pollIntervalMs; updatedAt = $runtime.updatedAt }
        }
    }
    $ledgerFile = Join-Path $eventWork 'event-delivery.json'
    if (Test-Path -LiteralPath $ledgerFile) {
        $ledger = Get-Content -LiteralPath $ledgerFile -Raw | ConvertFrom-Json
        $result.deliveryBlocked = [bool]($ledger.pending -or $ledger.deliveryUncertain)
    }
    foreach ($lockName in @('listener.lock', 'dispatch.lock')) {
        $lockPath = Join-Path $eventWork $lockName
        if (Test-Path -LiteralPath $lockPath) { $result[$lockName] = Get-Content -LiteralPath $lockPath -Raw }
    }
    return $result
}
if ($Action -eq 'Status') { Get-ListenerState | ConvertTo-Json -Depth 6; return }
$startMutex = [Threading.Mutex]::new($false, 'Local\CodexOpenCodeBridgeListenerStart')
$ownsMutex = $false
$oldAuth = $env:OPENCODE_BRIDGE_AUTH
$oldCli = $env:OPENCODE_BRIDGE_CODEX
try {
    try { $ownsMutex = $startMutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another listener startup is in progress.' }
    $state = Get-ListenerState
    $cycleForMode = Get-Content -LiteralPath (Join-Path $eventWork 'review-cycle.json') -Raw | ConvertFrom-Json
    if ($state.deliveryBlocked -and $Action -eq 'Start' -and $cycleForMode.deliveryMode -ne 'direct') { throw 'Notification delivery is uncertain. Reconcile event-delivery.json before another callback.' }
    if ($Action -eq 'Start' -and (!$cycleForMode.deliveryMode -or $cycleForMode.deliveryMode -eq 'async')) {
        $notifyScript = Join-Path $PSScriptRoot '../../scripts/owner-notify.cjs'
        $probe = & (Get-Command node -ErrorAction Stop).Source $notifyScript probe
        if ($LASTEXITCODE -ne 0) { throw 'Owner callback channel unavailable; configure explicit background fallback before dispatch.' }
        $channel = $probe | ConvertFrom-Json
        if (-not $channel.available) { throw 'Owner callback channel readiness was not confirmed.' }
    }
    if ($state.status -in @('starting', 'connected', 'reconnecting')) { $state | ConvertTo-Json -Depth 6; return }
    if (Test-Path -LiteralPath (Join-Path $eventWork 'listener.lock')) {
        throw 'Listener lock remains. Inspect its PID and process command line before removing an abandoned lock.'
    }
    if ($Action -eq 'Start') {
        $cycle = Get-Content -LiteralPath (Join-Path $eventWork 'review-cycle.json') -Raw | ConvertFrom-Json
        if ($cycle.status -eq 'complete' -or $cycle.status -like 'paused*') { throw 'Cycle is complete or paused; listener was not started.' }
        if (-not $cycle.codexThreadId -or -not $cycle.sessionId -or -not $cycle.directory) { throw 'Cycle owner/session/directory missing.' }
    }
    $credential = Import-Clixml -LiteralPath (Join-Path $eventWork 'credential.xml')
    $env:OPENCODE_BRIDGE_AUTH = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('opencode:' + $credential.GetNetworkCredential().Password))
    $env:OPENCODE_BRIDGE_CODEX = if ($cycleForMode.deliveryMode -eq 'events') { (Get-Command codex -ErrorAction Stop).Source } else { $null }
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
    if ($Action -eq 'Probe') {
        if (-not $ProbeSession) { throw 'ProbeSession required.' }
        & $nodeExe $eventScript --probe-session $ProbeSession
        if ($LASTEXITCODE -ne 0) { throw 'Listener probe failed.' }
    } else {
        $listenerProcess = Start-Process -FilePath $nodeExe -ArgumentList @(('"' + $eventScript + '"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $eventWork 'events.stdout.log') -RedirectStandardError (Join-Path $eventWork 'events.stderr.log')
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            Start-Sleep -Milliseconds 200
            $listenerProcess.Refresh()
            if ($listenerProcess.HasExited) { throw 'Listener exited during startup. Inspect events.stderr.log.' }
            if (Test-Path -LiteralPath $runtimeFile) {
                $ready = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
                if ($ready.pid -eq $listenerProcess.Id -and $ready.status -in @('starting', 'connected', 'reconnecting')) {
                    $ready | ConvertTo-Json; return
                }
            }
        }
        throw 'Listener readiness not confirmed; no Grok request should be sent.'
    }
} finally {
    $env:OPENCODE_BRIDGE_AUTH = $oldAuth
    $env:OPENCODE_BRIDGE_CODEX = $oldCli
    if ($ownsMutex) { $startMutex.ReleaseMutex() }
    $startMutex.Dispose()
}
