# DeepSeek environment checks

Use for a new Windows workspace or a demonstrated executor failure. Preserve the
selected official provider/model/effort. These checks do not start a cycle, consume
a feature dispatch, or authorize unrelated machine changes. Skip repeated checks
when the same workspace/runtime/configuration already has valid evidence.

## Read-only preflight

Run with PowerShell and the installed bridge configuration:

```powershell
& '<skill>/scripts/native-review/deepseek-preflight.ps1' -Project $project -Config $config
```

The script reports canonical workspace/owner, the official runtime-derived
capability SID, exact standing grant, current-user ownership, runtime/sandbox versions,
configured provider/model/effort and cached versus fresh DNS addresses. It does
not grant permissions, create a session, write files or send a model request.
`aclReady` is a conservative known-good condition, not a complete Windows
effective-access calculation; other existing WRITE_DAC grants may also suffice.
DNS results are diagnostics, not an API health verdict.

`init` returning `ready` proves fresh ACP/model binding only. Reading files or
writing a file through the agent's file tool does not prove its PowerShell sandbox
can start. A successful probe in another directory/provider route is not portable
evidence; record exact workspace, runtime version, endpoint, model and tool used.

## Windows tool authorization

`SetNamedSecurityInfoW ... Win32 5 ... grantWrite(workspace)` means root DACL
provisioning failed before the shell command started. ACP `allow_once` cannot
repair this OS condition. Being able to edit files is not the same as WRITE_DAC.

The official `@deepseek-ai/dsh-sandbox-windows-acl` public `workspaceWriteSid`
derives the SID from the actual canonical project root. A matching explicit
standing Allow ACE with the installed runtime's exact mask/inheritance lets
`grantWrite` skip reapplying it. Check the installed version's public API/source;
do not hardcode a SID from a previous project. On Windows, canonicalize using
`fs.realpathSync.native(project)` BEFORE calling `workspaceWriteSid` or constructing
the sandbox. The SID helper hashes its input; it does not normalize slashes.
A forward-slash path and the native backslash path can generate different SIDs
for the same directory. A probe using the wrong path can pass while ACP still fails.
Use the exact canonical root that the installed executor uses. The tested 0.1.5-rc.1 shape is
mask 1114454, object/container inheritance, no propagation modifier.

When a repair is authorized, prepare a reviewable helper restricted to the
verified non-reparse project root. Save its current ACL, then provision only the
official capability grant using the normal Windows administrator/UAC flow when
needed. Preserve owner and existing ACEs. Do not disable the sandbox, take over
an entire drive, grant Everyone FullControl or reset a tree's ACL to make it run.
Reusing prior authorization for the same repair does not require another chat
permission question; an actual Windows UAC prompt can still require user action.
For projects intentionally outside the caller's ACL authority, a permitted,
caller-owned isolated checkout can be preferable to changing ownership.

Validate with the public `AclSandbox` API under the ordinary runtime user:
workspace shell execution/write succeeds, a disposable file outside the workspace
is denied, and read-only mode still denies writes. Use synthetic files in a
task-specific checks/private-temp directory. A root-only ACL inspection is not a
replacement for these behavioral checks after a repair. Record the canonical
path and SID, and verify an actual successful ACP PowerShell tool result when
claiming end-to-end executor recovery; a file-tool-created marker is insufficient.

The current restricted token does not support WMI/CIM commands. Prefer normal
process/file tools for executor scripts; a failed Get-CimInstance is not proof
that the whole shell is broken.

## API transport errors

`TRANSPORT` alone does not identify credentials, quota, input size or provider
outage. Inspect the native turn error and actual fetch cause, excluding headers,
tokens, bodies and user document contents. `ETIMEDOUT`/`ECONNREFUSED` during
connect differs from an HTTP authentication or rate-limit response.

For suspected stale Windows resolution, compare `dns.lookup(host, {all:true})`
with `dns.resolve4(host)` and connection failures. Different answers alone are
normal for a CDN and do not prove corruption. An unauthenticated /models 401
proves only endpoint connectivity; it does not test generation or key validity.

Use a minimal authorized real generation test only when diagnosing/validating
the request path: synthetic input, same provider/model/effort, small output cap.
Include a representative bounded larger input when size/path behavior matters.
Record HTTP/SSE completion and sanitized nested error codes. Do not submit the
whole feature task as a connectivity test or silently switch to the old gateway.

When evidence confirms an address-resolution problem, a provider-process-local
resolver/dispatcher can be appropriate. Preserve hostname/TLS validation, use
fresh real DNS answers, scope to the exact provider origin and keep unrelated
origins on their original dispatcher. Avoid fixed-IP hosts entries, global DNS
changes, certificate bypasses and hidden fallback providers. DNS errors must
remain errors. The optional preload below implements this workaround; do not
impose it on machines that do not exhibit this problem.

Validate changed resolver code's routing/error boundaries and the previously
failing request shape; component success is not whole-task acceptance. Keep
configuration backups and rollback notes without secrets. Updating an installed
config affects future processes, not an already-running worker.

### Optional DeepSeek DNS preload

The repository includes `scripts/native-review/deepseek-network.cjs` and
`deepseek-dns.cjs`. The preload resolves `undici` from the selected installed
DeepSeek runtime. It changes only connections to `https://api.deepseek.com`;
other origins retain their original dispatcher. No dependency or private config
from the author's installation is bundled.

After diagnosing the same stale-address failure and obtaining any required
authorization, back up the local bridge configuration. In that configuration's
DeepSeek backend `args`, insert `--require` and the absolute path of
`scripts/native-review/deepseek-network.cjs` immediately before the runtime
entrypoint. Keep the entrypoint, profile, patch, provider, model and effort.
For example, the argument order is:

```text
--require <absolute-skill-path>/scripts/native-review/deepseek-network.cjs <absolute-dsh-entry> --profile acp --patch <existing-patch-path>
```

This is optional and is not enabled by `configure`. Verify the exact failing
request with a fresh, authorized runtime process; do not restart an active
worker to install it. Restore the saved configuration to roll back. If the
runtime cannot resolve `undici`, the preload fails rather than silently falling
back to the original resolver.

## Failure recovery

Match owner, cycle, dispatch, original request and native end before acting.
Inspect actual files against the saved baseline and distinguish failed tool
startup from executed mutations. A partial assistant message is not a completed
response; never manufacture `responseId` or a successful review.

An uncertain submission, crash, unclosed compaction or ambiguous receipt requires
read-only reconciliation, not another Send. A conclusively settled API error with
known side effects is different: the bridge currently has no Send/Review path
from `paused_reconcile`. If the original task remains authorized, a scoped fresh
session may follow diagnosis and verified shutdown of the failed owned processes.
Preserve the original cycle/report, start empty, and subtract prior dispatches
from the task's remaining allowance. Do not revive a user-cancelled task.

Do not loop fresh sessions on the same unresolved failure. Repeated failures
need an environment diagnosis and a concrete fix, not a reset round counter.
An environment-repair request permits that repair; it does not silently add
feature implementation rounds or change the selected executor. Keep active
implementation work separate from a skill-documentation update, and never stop
or reconfigure its live worker just to validate this skill.
