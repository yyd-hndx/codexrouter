# Configuration and runtime setup

Run commands from this repository root. `npm run configure -- ...` generates machine-specific files which must remain untracked. Neither configure nor doctor sends model prompts. Put API key values in environment variables or the executor's documented credential store, never in shared JSON or shell history.

The native bridge accepts a version-1 JSON file with `backends` keyed by `grok-build` and/or `deepseek-harness`. Each backend sets an absolute Node `command`, JavaScript entrypoint and arguments, non-secret `env`, exact `modelSelector`, expected `model`, and `effort`. DeepSeek also requires `provider`. Generated `requiredEnv` metadata tells doctor which variables to check; it never prints their values. Existing hand-written configs may use the native credential-file adapter; do not publish those private paths or values.

Use `node scripts/configure.cjs --backend <backend> --runtime <entry.js> --model <model> --effort <effort>`; DeepSeek additionally needs `--provider`. Optional `--output` changes the output JSON path, and `--home` selects the executor home. Grok also accepts `--base-url` and `--key-env`. Configure refuses to replace an existing backend or runtime settings file. Inspect it and back it up before manually reconfiguring. A clean home prevents importing unrelated sessions/settings.

Grok accepts `--idle-timeout-seconds` (1–86400, default 300). This upstream inference-stream idle timeout is independent of the bridge's no-progress warning and total runtime limit. Configure it for models that remain silent while reasoning; a larger bridge runtime does not override a shorter upstream idle timeout.

For DeepSeek, the generated observer patch uses the current repository's observer absolute path. Its actual runtime must advertise the configured provider/model pair; initialization checks this and the selected effort rather than silently switching models. The example names reflect the source installation and are not promises about other runtime versions or account access. Doctor checks generated config, file presence and required environment variables; it cannot prove API connectivity or model access. A credential-store-only setup can be valid upstream even if the generated doctor check requires an environment variable; edit that metadata intentionally for such a setup.

Native command variables:

```powershell
$bridge = (Resolve-Path scripts/native-review/bridge.cjs).Path
$config = (Resolve-Path config.local.json).Path
$project = (Resolve-Path '../your-project').Path
$owner = $env:CODEX_THREAD_ID
```

The owner must be the actual Codex task. Outside Codex, do not invent a task ID and assume queue/heartbeat integration works. Use this skill inside the intended task for the complete review flow.

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
node scripts/init-opencode.cjs --directory $project --session <verified-session-id> --owner $env:CODEX_THREAD_ID --provider <configured-provider-id> --model <configured-model-id> --task <absolute-task-file> --scope 'Authorized change'
& ./legacy/outputs/opencode-bridge.ps1 -Action Send -Directory $project -SessionId <verified-session-id> -Variant <configured-variant> -PromptFile <absolute-task-file>
```

No provider ID is hardcoded. The cycle records provider/model, and Send uses the explicit variant. Backend/version support and provider configuration determine which variants exist. Send refuses missing routing and checks the current cycle before posting. See [OpenCode workflow](opencode.md) for Wait, review and recovery. Do not change routing on an in-flight cycle.

The initializer defaults to `--delivery-mode async`. Configure the
[owner callback channel](result-delivery.md) before Send. Explicit `direct` is
available for foreground waiting or a verified heartbeat fallback; `events`
retains the legacy inbox queue behavior. Initialization itself sends no callback.

`init-opencode` records `sessionTitle` from optional `--title`, falling back to the authorized scope as a display label. It does not claim to fetch the actual remote title. `Send` requires an explicit nonempty `-Variant`; Snapshot and Reconcile do not select an effort.
