# Configuration and runtime setup

Run commands from this repository root. `npm run configure -- ...` generates machine-specific files which must remain untracked. Neither configure nor doctor sends model prompts. Put API key values in environment variables or the executor's documented credential store, never in shared JSON or shell history.

The native bridge accepts a version-1 JSON file with `backends` keyed by `grok-build` and/or `deepseek-harness`. Each backend sets an absolute Node `command`, JavaScript entrypoint and arguments, non-secret `env`, exact `modelSelector`, expected `model`, and `effort`. DeepSeek also requires `provider`. Generated `requiredEnv` metadata tells doctor which variables to check; it never prints their values. Existing hand-written configs may use the native credential-file adapter; do not publish those private paths or values.

Use `node scripts/configure.cjs --backend <backend> --runtime <entry.js> --model <model> --effort <effort>`; DeepSeek additionally needs `--provider`. Optional `--output` changes the output JSON path, and `--home` selects the executor home. Grok also accepts `--base-url` and `--key-env`. Configure refuses to replace an existing backend or runtime settings file. Inspect it and back it up before manually reconfiguring. A clean home prevents importing unrelated sessions/settings.

Grok accepts `--idle-timeout-seconds` (1–86400, default 300). This upstream inference-stream idle timeout is independent of the bridge's no-progress warning and total runtime limit. Configure it for models that remain silent while reasoning; a larger bridge runtime does not override a shorter upstream idle timeout.

For DeepSeek, generated configs record a managed runtime entry and DNS mode. The
bridge creates its observer patch inside the owned cycle using the current
installation path on every startup; renaming the skill cannot leave a stale
observer/preload path. Runtime and home paths remain local configuration and must
be regenerated on a different machine. Hand-written configs remain unchanged. Its actual runtime must advertise the configured provider/model pair; initialization checks this and the selected effort rather than silently switching models. The example names reflect the source installation and are not promises about other runtime versions or account access. Doctor checks generated config, file presence and required environment variables; it cannot prove API connectivity or model access. A credential-store-only setup can be valid upstream even if the generated doctor check requires an environment variable; edit that metadata intentionally for such a setup.

Native command variables:

```powershell
$bridge = (Resolve-Path scripts/native-review/bridge.cjs).Path
$config = (Resolve-Path config.local.json).Path
$project = (Resolve-Path '../your-project').Path
$owner = $env:CODEX_THREAD_ID
```

The owner must be the actual Codex task. Outside Codex, do not invent a task ID and assume queue/heartbeat integration works. Use this skill inside the intended task for the complete review flow.

## Optional owner-context recovery hook

`node scripts/configure-hook.cjs` prints host TOML for this installation path;
it does not edit or trust your Codex configuration. Install only when requested,
after checking host support and existing registrations. See
[compact-recovery.md](compact-recovery.md) for setup, dynamic owner filtering,
verification and limitations. Ordinary dispatch does not require hook setup.

## Grok Build installation

Run from the skill directory:

```powershell
npm install --prefix .runtime/grok @xai-official/grok@1.0.25
npm run configure -- --backend grok-build --runtime .runtime/grok/node_modules/@xai-official/grok/bin/grok --model grok-4.6 --effort xhigh
npm run doctor -- --config config.local.json
```

Set `XAI_API_KEY` in the environment used to launch Codex before running doctor.
Use a model available to your account. The generated configuration uses the
official API; custom services can use `--base-url` and `--key-env`.

## OpenCode on Windows

Install/configure OpenCode using its own provider settings. Resolve its executable from PATH (`opencode.exe`) or set `OPENCODE_REVIEW_CLI` to an executable path. If your installation only has a `.cmd` wrapper, point to its actual Windows executable. Set optional `OPENCODE_REVIEW_URL` to a loopback HTTP origin such as `http://127.0.0.1:4097`; keep it identical for bridge and listener commands.

```powershell
$project = (Resolve-Path '../your-project').Path
& ./legacy/outputs/opencode-bridge.ps1 -Action Start -Directory $project
& ./legacy/outputs/opencode-bridge.ps1 -Action Health -Directory $project
```

Start creates a local Windows-protected server credential under `legacy/work/opencode-bridge`, starts a loopback service only when unavailable, and refuses to stop an unrelated process occupying its port. Provider API credentials are separate and remain in OpenCode's own configuration. Doctor without `--config` validates Node/PowerShell/parser prerequisites; use this explicit Health command to test the OpenCode service.

Create a fresh empty OpenCode session using the Api action and a UTF-8 JSON BodyFile, then verify its real directory and empty history. Initialize only local owned state:

```powershell
node scripts/init-opencode.cjs --directory $project --session <verified-session-id> --owner $env:CODEX_THREAD_ID --task <absolute-task-file> --scope 'Authorized change'
& ./legacy/outputs/opencode-bridge.ps1 -Action Send -Directory $project -SessionId <verified-session-id> -PromptFile <absolute-task-file>
```

No provider ID is hardcoded. Omit model and variant to use OpenCode's project defaults. For an explicit model override, supply both `--provider` and `--model` at initialization; for an effort override, pass `-Variant` to Send. A fresh session does not inherit another UI session's temporary selection. See [OpenCode workflow](opencode.md) for Wait, review and recovery. Do not change routing on an in-flight cycle.

The initializer defaults to `--delivery-mode async`. Configure the
[owner callback channel](result-delivery.md) before Send. Explicit `direct` is
available for foreground waiting or a verified heartbeat fallback; `events`
retains the legacy inbox queue behavior. Initialization itself sends no callback.

`init-opencode` records `sessionTitle` from optional `--title`, falling back to the authorized scope as a display label. It does not claim to fetch the actual remote title. `-Variant` is optional and must be nonempty when supplied; Snapshot and Reconcile do not select an effort.

## DeepSeek connection handling

`configure --dns-mode system` is the default and leaves system/VPN/proxy routing
untouched. Opt into `--dns-mode auto` only for a demonstrated DNS/address failure:
new connections try system addresses first plus deduplicated fresh A records.
Each DNS source has a 2-second bound; one failed source cannot discard a working
source. `fresh` is available for explicit diagnosis, but can be worse after a VPN
change. Only the exact official HTTPS origin is affected; TLS stays verified.
The preload resolves undici from the chosen Harness installation.

Harness 0.1.5-rc.1 owns same-step model request retries (default normal policy,
5 retries for transient errors). The bridge now records retry counts/backoff and
terminal codes in cycle state. It never resubmits the task to implement retries.
Settings can override the upstream policy, so inspect it if retries differ; avoid
unbounded always mode. Authentication errors are not network retries.
After a terminal failure, preserve the session/report and inspect known effects;
do not restart a cancelled task or blindly replay a failed dispatch.
