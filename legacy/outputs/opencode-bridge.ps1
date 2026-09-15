param(
    [ValidateSet('Start', 'Health', 'Sessions', 'Send', 'Wait', 'Reconcile', 'Read', 'Status', 'Snapshot', 'Api')]
    [string]$Action = 'Health',
    [string]$SessionId,
    [string]$PromptFile,
    [string]$Prompt,
    [string]$ApiPath = '/global/health',
    [string]$Method = 'GET',
    [string]$BodyFile,
    [string]$Variant,
    [string]$DispatchId,
    [ValidateRange(1,60)][int]$TimeoutSeconds = 45,
    [string]$Directory = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
if ($Action -eq 'Send' -and -not $PromptFile -and [string]::IsNullOrWhiteSpace($Prompt)) { throw 'Send requires Prompt or PromptFile.' }
$bridgeWork = Join-Path (Split-Path $PSScriptRoot -Parent) 'work\opencode-bridge'
$credentialPath = Join-Path $bridgeWork 'credential.xml'
$projectPath = $Directory
$baseUrl = if ($env:OPENCODE_REVIEW_URL) { $env:OPENCODE_REVIEW_URL.TrimEnd('/') } else { 'http://127.0.0.1:4096' }
$serverUri = [Uri]$baseUrl
if ($serverUri.Scheme -ne 'http' -or $serverUri.Host -notin @('127.0.0.1', 'localhost') -or $serverUri.AbsolutePath -ne '/' -or $serverUri.UserInfo -or $serverUri.Query -or $serverUri.Fragment) { throw 'OpenCode bridge requires a loopback HTTP origin.' }
$serverPort = $serverUri.Port

if ($Action -eq 'Start') {
    New-Item -ItemType Directory -Path $bridgeWork -Force | Out-Null
    if (-not (Test-Path $credentialPath)) {
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $secure = ConvertTo-SecureString ([Convert]::ToBase64String($bytes)) -AsPlainText -Force
        [PSCredential]::new('opencode', $secure) | Export-Clixml -LiteralPath $credentialPath
    }
}
if (-not (Test-Path $credentialPath)) { throw 'Run with -Action Start first.' }
$credential = Import-Clixml -LiteralPath $credentialPath
$authBytes = [Text.Encoding]::UTF8.GetBytes('opencode:' + $credential.GetNetworkCredential().Password)
$headers = @{ Authorization = 'Basic ' + [Convert]::ToBase64String($authBytes) }
$directoryQuery = '?directory=' + [Uri]::EscapeDataString($projectPath)

function Invoke-Bridge([string]$Path, [string]$Verb = 'GET', $Body = $null) {
    $options = @{
        Uri = $baseUrl + $Path + $directoryQuery
        Method = $Verb
        Headers = $headers
        TimeoutSec = 30
    }
    if ($null -ne $Body) {
        $options.ContentType = 'application/json; charset=utf-8'
        $options.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 50 -Compress))
    }
    Invoke-RestMethod @options
}

switch ($Action) {
    'Wait' {
        if (-not $SessionId -or -not $DispatchId -or -not $env:CODEX_THREAD_ID) { throw 'Wait requires SessionId, DispatchId and the owning CODEX_THREAD_ID.' }
        $oldWaitAuth = $env:OPENCODE_BRIDGE_AUTH
        try {
            $env:OPENCODE_BRIDGE_AUTH = $headers.Authorization
            @{ sessionId=$SessionId; dispatchId=$DispatchId; directory=$Directory; timeoutSeconds=$TimeoutSeconds } | ConvertTo-Json -Compress | & (Get-Command node -ErrorAction Stop).Source (Join-Path $PSScriptRoot 'opencode-wait.cjs')
            if ($LASTEXITCODE -ne 0) { throw 'Wait failed; inspect state. No prompt was sent or retried.' }
        } finally { $env:OPENCODE_BRIDGE_AUTH = $oldWaitAuth }
    }
    'Start' {
        try { $health = Invoke-Bridge '/global/health' } catch { $health = $null }
        if ($health.healthy) { $health | ConvertTo-Json; break }
        if (Get-NetTCPConnection -LocalPort $serverPort -State Listen -ErrorAction SilentlyContinue) {
            throw 'Configured port is occupied by a different service; no process was stopped.'
        }
        $cli = if ($env:OPENCODE_REVIEW_CLI) { $env:OPENCODE_REVIEW_CLI } else { (Get-Command opencode.exe -ErrorAction Stop).Source }
        if (-not (Test-Path $cli)) { throw 'OpenCode CLI executable is missing.' }
        $oldPassword = $env:OPENCODE_SERVER_PASSWORD
        $oldUsername = $env:OPENCODE_SERVER_USERNAME
        try {
            $env:OPENCODE_SERVER_PASSWORD = $credential.GetNetworkCredential().Password
            $env:OPENCODE_SERVER_USERNAME = 'opencode'
            $server = Start-Process -FilePath $cli -ArgumentList @('serve', '--hostname', '127.0.0.1', '--port', [string]$serverPort, '--cors', 'oc://renderer') -WorkingDirectory $projectPath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $bridgeWork 'server.stdout.log') -RedirectStandardError (Join-Path $bridgeWork 'server.stderr.log')
            $server.Id | Set-Content -LiteralPath (Join-Path $bridgeWork 'server.pid')
        } finally {
            $env:OPENCODE_SERVER_PASSWORD = $oldPassword
            $env:OPENCODE_SERVER_USERNAME = $oldUsername
        }
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 500
            try { $health = Invoke-Bridge '/global/health'; break } catch { }
        }
        if (-not $health.healthy) { throw 'Server did not become healthy. Inspect work/opencode-bridge logs.' }
        $health | ConvertTo-Json
    }
    'Health' { Invoke-Bridge '/global/health' | ConvertTo-Json }
    'Sessions' {
        $sessions = Invoke-Bridge '/session'
        ConvertTo-Json -InputObject @($sessions | Select-Object id, title, directory) -Depth 5
    }
    { $_ -in @('Send', 'Reconcile') } {
        if ($PromptFile) { $Prompt = Get-Content -LiteralPath $PromptFile -Raw -Encoding UTF8 }
        if (-not $SessionId) { throw 'Explicit verified SessionId required. Create and bind a fresh session before Send.' }
        if (-not $env:CODEX_THREAD_ID) { throw 'CODEX_THREAD_ID is required to verify cycle ownership.' }
        $oldDispatchAuth = $env:OPENCODE_BRIDGE_AUTH
        $oldDispatchPwsh = $env:OPENCODE_BRIDGE_PWSH
        try {
            $env:OPENCODE_BRIDGE_AUTH = $headers.Authorization
            $env:OPENCODE_BRIDGE_PWSH = (Get-Command pwsh -ErrorAction Stop).Source
            $dispatchInput = @{ action = $Action.ToLowerInvariant(); sessionId = $SessionId; directory = $Directory; prompt = $Prompt }
            if ($PSBoundParameters.ContainsKey('Variant')) { $dispatchInput.variant = $Variant }
            $dispatchInput = $dispatchInput | ConvertTo-Json -Compress
            $dispatchInput | & (Get-Command node -ErrorAction Stop).Source (Join-Path $PSScriptRoot 'opencode-dispatch.cjs')
            if ($LASTEXITCODE -ne 0) { throw 'Dispatch helper failed. Inspect state and use Reconcile; do not resend blindly.' }
        } finally {
            $env:OPENCODE_BRIDGE_AUTH = $oldDispatchAuth
            $env:OPENCODE_BRIDGE_PWSH = $oldDispatchPwsh
        }
    }
    'Read' {
        if (-not $SessionId) { throw 'SessionId is required.' }
        Invoke-Bridge ('/session/' + $SessionId + '/message') | ConvertTo-Json -Depth 50
    }
    'Status' { Invoke-Bridge '/session/status' | ConvertTo-Json -Depth 10 }
    'Snapshot' {
        if (-not $SessionId) { throw 'SessionId is required.' }
        $session = Invoke-Bridge ('/session/' + $SessionId)
        $messages = Invoke-Bridge ('/session/' + $SessionId + '/message')
        $permissions = Invoke-Bridge '/permission'
        $questions = Invoke-Bridge '/question'
        $statuses = Invoke-Bridge '/session/status'
        $lastUser = @($messages | Where-Object { $_.info.role -eq 'user' } | Select-Object -Last 1)
        $lastMessage = @($messages | Select-Object -Last 1)
        $pendingPermissions = @($permissions | Where-Object { $_.sessionID -eq $SessionId })
        $pendingQuestions = @($questions | Where-Object { $_.sessionID -eq $SessionId })
        $status = $statuses.$SessionId
        $snapshotInput = @{ last = if ($lastMessage.Count) { $lastMessage[0] } else { $null }; status = $status; permissions = $pendingPermissions; questions = $pendingQuestions }
        $state = $snapshotInput | ConvertTo-Json -Depth 100 -Compress | & (Get-Command node -ErrorAction Stop).Source (Join-Path $PSScriptRoot 'opencode-snapshot.cjs')
        if ($LASTEXITCODE -ne 0) { throw 'Snapshot classification failed; completion is unverified.' }
        $latestText = if ($lastMessage.Count) {
            ($lastMessage[0].parts | Where-Object type -eq 'text' | ForEach-Object { $_.text }) -join "`n"
        } else { '' }
        [ordered]@{
            sessionId = $SessionId
            title = $session.title
            directory = $session.directory
            state = $state
            status = $status
            lastUserMessageId = if ($lastUser.Count) { $lastUser[0].info.id } else { $null }
            lastMessageId = if ($lastMessage.Count) { $lastMessage[0].info.id } else { $null }
            lastMessageTime = if ($lastMessage.Count) { $lastMessage[0].info.time } else { $null }
            error = if ($lastMessage.Count) { $lastMessage[0].info.error } else { $null }
            latestText = $latestText.Substring(0, [Math]::Min(4000, $latestText.Length))
            pendingPermissions = $pendingPermissions
            pendingQuestions = $pendingQuestions
        } | ConvertTo-Json -Depth 20
    }
    'Api' {
        $body = if ($BodyFile) { Get-Content -LiteralPath $BodyFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
        Invoke-Bridge $ApiPath $Method $body | ConvertTo-Json -Depth 100
    }
}
