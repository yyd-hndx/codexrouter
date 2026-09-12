[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Project,
    [Parameter(Mandatory = $true)][string]$Config
)
$ErrorActionPreference = 'Stop'
try {
    $projectItem = Get-Item -LiteralPath $Project
    if (-not $projectItem.PSIsContainer -or ($projectItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Project must be an existing non-reparse directory.'
    }
    $configuration = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
    $backend = $configuration.backends.'deepseek-harness'
    if (-not $backend -or -not (Test-Path -LiteralPath $backend.command -PathType Leaf)) {
        throw 'Configured DeepSeek Node executable is unavailable.'
    }
    $runtimeEntries = @($backend.args | Where-Object { $_ -match '[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$' })
    if ($runtimeEntries.Count -ne 1 -or -not (Test-Path -LiteralPath $runtimeEntries[0] -PathType Leaf)) {
        throw 'Cannot identify one installed official DeepSeek runtime entry.'
    }
    $nodeProbe = @'
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs');
const path=require('node:path');
const dns=require('node:dns').promises;
(async()=>{
  const project=fs.realpathSync.native(process.argv[1]);
  const entry=path.resolve(process.argv[2]);
  const runtimeRequire=createRequire(entry);
  const sandboxEntry=runtimeRequire.resolve('@deepseek-ai/dsh-sandbox-windows-acl');
  const api=await import(pathToFileURL(sandboxEntry).href);
  const sandboxVersion=JSON.parse(fs.readFileSync(path.join(path.dirname(sandboxEntry),'../package.json'),'utf8')).version;
  const runtimeVersion=JSON.parse(fs.readFileSync(path.join(path.dirname(entry),'../package.json'),'utf8')).version;
  const deadline=(promise)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Object.assign(new Error('DNS probe timeout'),{code:'TIMEOUT'})),5000);timer.unref();})]);
  const diagnostic=async(promise)=>{try{return {answers:await deadline(promise)}}catch(error){return {errorCode:error.code||error.name}}};
  const [cached,fresh]=await Promise.all([diagnostic(dns.lookup('api.deepseek.com',{all:true})),diagnostic(dns.resolve4('api.deepseek.com'))]);
  console.log(JSON.stringify({project,runtimeVersion,sandboxVersion,capabilitySid:api.workspaceWriteSid(project),dns:{cached,fresh}}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
'@
    $probeOutput = & $backend.command -e $nodeProbe $projectItem.FullName $runtimeEntries[0]
    if ($LASTEXITCODE -ne 0) { throw 'Official runtime probe failed.' }
    $probe = $probeOutput | ConvertFrom-Json
    $acl = Get-Acl -LiteralPath $probe.project
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $ownerSid = if ($acl.Owner -match '^S-1-') { $acl.Owner } else {
        ([Security.Principal.NTAccount]::new($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
    }
    $grant = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | Where-Object {
        $_.IdentityReference.Value -eq $probe.capabilitySid -and [int]$_.FileSystemRights -eq 1114454 -and
        [int]$_.InheritanceFlags -eq 3 -and [int]$_.PropagationFlags -eq 0 -and
        $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
    })
    $ownerMatches = $ownerSid -eq $identity.User.Value
    $versionVerified = $probe.sandboxVersion -eq '0.1.5-rc.1'
    [ordered]@{
        readOnly = $true
        project = $probe.project
        runtimeVersion = $probe.runtimeVersion
        sandboxVersion = $probe.sandboxVersion
        provider = $backend.provider
        model = $backend.model
        effort = $backend.effort
        owner = $acl.Owner
        currentUser = $identity.Name
        ownerMatchesCurrentUser = $ownerMatches
        capabilitySid = $probe.capabilitySid
        grantShapeVersionVerified = $versionVerified
        exactStandingGrantPresent = ($grant.Count -gt 0)
        aclReady = ($versionVerified -and ($ownerMatches -or $grant.Count -gt 0))
        dns = $probe.dns
        note = 'Read-only diagnostics. No session, model call or ACL change. aclReady is conservative; it does not replace effective-rights or shell/API verification. Recheck grant shape after runtime upgrades.'
    } | ConvertTo-Json -Depth 6
} catch {
    @{ readOnly = $true; error = $_.Exception.Message } | ConvertTo-Json
    exit 1
}
