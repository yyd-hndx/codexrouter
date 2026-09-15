# ZCode

Use the installed ZCode desktop runtime with `scripts/native-review/bridge.cjs`.
This is a ZCode Protocol v1 adapter, not ACP. It shares durable cycle state,
owner callbacks, response-bound review and repair limits with the native bridge.

## Configure

Install ZCode and configure an API-key/custom provider in its desktop app first.
Use Node.js 24+ to run the bridge and configure command. Locate the actual
`resources/glm/zcode.cjs` and executable; do not assume a migrated install path.

```powershell
node scripts/configure.cjs --backend zcode --runtime '<install>/resources/glm/zcode.cjs' --executable '<install>/ZCode.exe'
node scripts/doctor.cjs --config config.local.json
```

`--executable` is optional when the configured Node.js 24+ can run the bundle.
Electron launches use `ELECTRON_RUN_AS_NODE=1`. `--home` optionally selects a
different ZCode data directory (default `~/.zcode`). No API key is copied into
bridge config, command arguments, or the skill.

Default selection reads the most recently updated unarchived desktop task in
the target project. If there is none, it uses the most recent desktop task.
The provider/model and thought level come from that task and the desktop's
`v2/config.json`; the chosen source is recorded as `selectionSource`. This
does not observe an unsent model change in a UI picker. Report the actual model
and source when confirming initialization. If the chosen model is gone or its
effort is unsupported, stop initialization instead of choosing another model.
An explicit `--provider` plus `--model`, and optional `--effort`, overrides this
selection when configuring a backend. Existing backend config is never overwritten.

## Dispatch and Review

Use the same commands as [native-bridge.md](native-bridge.md), selecting
`--backend zcode`. Always verify the owning thread and `status: ready` first.

```powershell
node scripts/native-review/bridge.cjs init --config config.local.json --backend zcode --directory '<project>' --owner '<thread-id>' --scope '<authorized task>' --max-rounds 4 --notify async --permission allow_once
node scripts/native-review/bridge.cjs send --cycle '<returned-cycle>' --owner '<thread-id>' --prompt-file '<task-file>'
```

The default permission policy is `reject`. Use `allow_once` only for authorized
tool execution. This is not a filesystem sandbox. Unknown client operations and
interactive questions fail closed; inspect attention rather than approving them
through a generic auto-answer. The adapter neither grants persistent permissions
nor fabricates browser, OAuth, or automation services.

After a confirmed send, release the conversation unless independent work remains.
On callback, read the owned state and response, inspect actual changes and run
checks. Bind review to the returned `responseId`:

```powershell
node scripts/native-review/bridge.cjs review --cycle '<cycle>' --owner '<thread-id>' --response-id '<response>' --report '<review-file>' --outcome changes_requested
node scripts/native-review/bridge.cjs send --cycle '<cycle>' --owner '<thread-id>' --prompt-file '<repair-file>'
```

Use `--outcome complete` after verification. Repairs reuse the same session.
Three repairs means four total submissions; stop the owned runtime at the cap
before Codex takes over. `stop` uses ZCode's session stop/close and process cleanup.
`read`, `wait`, `snapshot` and `reconcile` never submit a model prompt. Do not
resend after uncertain submission or restart a stopped cycle on a delayed event.

Completion requires matching input, session, turn and assistant-message identities,
successful terminal status, expected model/effort and a settled snapshot without
pending tools, background jobs or permissions. The original prompt and result must
match persisted messages. Missing/ambiguous evidence goes to manual inspection.

## Limits

Tested protocol: desktop 3.11.2 / runtime 0.16.5 on Windows. Bundled internal
protocols may change with updates. Desktop OAuth-only providers and desktop browser,
computer-use or automation host services are not implemented by this adapter.
Configuration is read at initialization; live repairs keep the original binding.
Runtime crashes require inspection; there is no automatic reattach or replay.
Compaction that changes the original message chain cannot certify completion and
requires manual review. This first adapter does not promise automatic recovery of
every ZCode event type.
