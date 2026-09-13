# Official native executors

Use `scripts/native-review/bridge.cjs` with Node.js (Node 24 for DeepSeek's runtime).
The bridge starts the official ACP process, owns its session, listens before
submitting, and records all received protocol frames. No extra model or server is
inserted between the official agent and its configured provider.

## Run and review

1. Inspect the project instructions and authorized scope. Save the task and
   acceptance criteria under `.agent-work/tasks`; reports go under
   `.agent-work/reports`, probes under `.agent-work/checks`. Honor explicit paths
   and exact-prompt requests. Initialization itself sends no model prompt.
2. Initialize with the verified owning Codex thread and exact project directory:

```powershell
node $bridge init --config $config --backend grok-build --directory $project --owner $owner --scope 'Authorized task' --max-rounds 4 --max-runtime 1200 --stall-seconds 300 --notify async --permission allow_once
```

Use `--backend deepseek-harness` to select DeepSeek. Do not omit the configured
effort or substitute a model when discovery fails. `init` checks the fresh native
session, model and effort. Retain its returned absolute `cycle` path and check
`status: ready` before sending. One active native cycle is allowed per project;
cycles of other tasks and the legacy OpenCode cycle must remain untouched.

`ready` establishes the session and configured model/effort. It does not test
the provider request path or Windows shell sandbox. For a new Windows DeepSeek
workspace, run the read-only preflight in [deepseek-troubleshooting.md](deepseek-troubleshooting.md)
before dispatch; reuse valid evidence for an unchanged workspace/configuration.

`--permission reject` is the default. `allow_once` auto-selects the ACP permission
option of that name for this session, so use it only for a task whose tool
execution is authorized. The bridge is not a filesystem sandbox; an executor can
add its own OS sandbox. ACP permission does not grant Windows WRITE_DAC. Do not infer
permission for destructive or external actions from a broad coding request.

Permission requests and the exact selected/cancelled replies are journaled. Read-only
reconciliation validates session, request ID, unique option ID and the recorded
`allow_once` policy. Missing, duplicate, foreign or denied permission evidence cannot
certify completion. Old journals without these replies still require manual inspection.

3. Submit once, from a UTF-8 file when the prompt contains quotes or multiple lines:

```powershell
node $bridge send --cycle $cycle --owner $owner --prompt-file $promptFile
```

Take `$dispatchId` from `send`'s result. `async` is the default: `init` probes the
owner callback channel before starting a runtime. Confirm dispatch and release
the conversation. Follow [result-delivery.md](result-delivery.md) for setup and
the explicit fallback when that channel is unavailable.

On callback or a requested status check, read the owned response with:

```powershell
node $bridge wait --cycle $cycle --owner $owner --dispatch-id $dispatchId --timeout-seconds 45
```

`wait` is read-only, returns persisted state/text and rejects changed ownership or
dispatch. A timeout does not justify resending. Only an explicit request to wait
in this turn uses `--notify direct` and repeated bounded waits.

Submission persists a dispatch UUID and exact prompt hash before writing ACP. It
increments the round once. Never manually increment it, insert dispatch markers
in a verbatim prompt, or resubmit after a timeout. Inspect the persisted command,
reply and journal instead. `read` returns the last response; `snapshot` returns
state. Those operations do not prompt the model.

4. Direct results and event callbacks identify the cycle, dispatch, request and response. First read
   current state and user instructions; a stale callback does not authorize work.
   Only `awaiting_review` is a verified completed turn. Independently inspect the
   actual artifact/diff and run relevant checks; the agent's report is not proof.
   Save a review report and bind the review to the exact `responseId`:

```powershell
node $bridge review --cycle $cycle --owner $owner --response-id $responseId --report $report --outcome changes_requested
node $bridge send --cycle $cycle --owner $owner --prompt-file $repairPrompt
```

Repairs stay in the same native session and authorized scope. Use outcome
`complete` after successful verification. Completion or exhausted rounds closes
the runtime, with `runtimeExited: true`. At the cap, further work requires renewed
scope/budget and a new cycle, not manual state changes.

5. To interrupt:

```powershell
node $bridge stop --cycle $cycle --owner $owner
```

This cancels and closes the session, then closes/kills the owned process tree if
necessary. Verify `paused_stopped`, `runtimeExited`, and worker exit; partial text
and files remain available. The separate DeepSeek browser service is not this
worker and is not stopped by this command.

Command acknowledgement defaults to 45 seconds, adjustable with
`--command-timeout-seconds 1..60`. It is separate from executor runtime and `wait`.
Unknown acknowledgement means inspect that command's reply file, never resend blindly.
Shutdown bounds Windows process-tree termination and always attempts lock release,
even if closing or persistence fails. An unverified prior runtime exit still blocks
a new cycle after lock release; inspect the recorded process and reconcile first.

## Completion and uncertainty

- Grok Build requires native `turn_completed`, normal `end_turn`, consistent
  prompt/request/session/model IDs and no pending tools or permission failures.
- DeepSeek requires ACP settlement **and** the observer's native
  `turn/end.reason.kind = completed`, original user-message hash/ID, matching
  turn, real assistant-message ID/provider/model, and no interrupted/pending work.
  ACP `end_turn` alone also represents some failures in this Harness version.
- DeepSeek compaction start/summary/end identities are observed without copying
  summary bodies into progress events. Repeated compactions within the original
  turn preserve the original request. Unclosed/mismatched compactions cannot
  certify completion. While compacting, the default stall allowance is 600 seconds
  (or the normal allowance if larger), configurable with `--compaction-stall-seconds`.
  The hard runtime limit still applies. A resumed event or completed result clears
  a stale stall alert; do not abort healthy compaction merely because a bounded
  wait returned. Cross-turn/session recovery remains read-only reconciliation.
- Failed compaction is counted separately and conservatively yields
  `compaction_failed_requires_review`, even if a later normal turn-end arrives.
  This prevents failure from being reported as verified compaction success; inspect
  whether the upstream runtime recovered before manually accepting artifacts.
  Malformed observer payloads emit a payload-free protocol error and cannot certify
  success, rather than throwing while writing ACP stdout.
- Native runs default to `--notify async`, which submits completion or attention
  to the exact owner through the configured app tool. Acceptance is recorded as
  `submitted`, `autoSubmitted: true`; it does not prove the owner reviewed it. Use
  `--notify events` only when queued notices are explicitly wanted: `codex queue`
  adds an item to the owning task's queue but does not guarantee submission or
  wakeup. Its successful receipt is recorded as `queued`, with
  `autoSubmitted: false`; historical `delivered` receipts also prove only queue
  acceptance. Do not treat either as proof that Codex processed the message.
  Delivery intent is persisted before submission, with no automatic replay after
  ambiguous acknowledgement. Normal token progress is quiet; a stall persists
  an attention condition, and the runtime bound cancels.
- `reconcile --cycle ... --owner ...` is read-only and sends no prompt. It checks
  dispatch evidence, returns a completion proof when sufficient, and reports the
  worker PID/lock. It never overrides stopped state or resurrects a process.
- This first native adapter supports live same-session repair, not automatic
  restart/reattach after worker crashes. Native logs remain for manual recovery.
  Missing/foreign IDs, compaction ambiguities or truncated journals fail closed.
  Do not pretend a summary is task completion or replace the original request ID.
- A settled provider error is not a completed response: `review` cannot accept
  it, and `send` cannot resume `paused_reconcile`. Diagnose the failure before
  deciding whether the still-authorized task can use a fresh session. Preserve
  the failed cycle, verify its owned processes exit, and carry forward cumulative
  dispatch usage. Do not edit status/round fields or loop fresh cycles on the same
  unresolved error. See [failure recovery](deepseek-troubleshooting.md#failure-recovery).
- For an ambiguous callback or queue receipt, verify the actual owner-thread message first.
  A live worker accepts `ack-delivery --key <exact delivery.key>` only after this
  inspection; it acknowledges the existing event without sending another message.
  Missing worker: keep paused; do not edit a live worker's state from outside.
- A leftover lock or recorded PID is not proof of a running process. Verify its
  command line and creation time before stopping an orphan; never kill a reused
  PID or remove a lock held by a live worker. Preserve the old cycle as evidence.

## Portable installation

Runtime packages are upstream dependencies, not bundled in the skill. Install
`@xai-official/grok` and/or `@deepseek-ai/dsh`, pin tested versions, and configure
their official provider settings. See the configuration reference for the tested pair.
Copy the shape of the local config to another machine with its own paths, model
route, credential lookup and Codex executable. Keep API keys out of skill files.

The config has `version: 1` and `backends` keyed by executor name. `codexCommand`
is optional and used only for legacy `events` queues; async configuration lives
in the environment or separate owner-notify local config described above.
Each backend defines `command`, `args`, `env`, `modelSelector`, `model`, `effort`;
DeepSeek also defines `provider`. Optional `credential` reads a local JSON file by
`keys` path and exposes the value only through listed `envNames`. DeepSeek uses
its own credential store. Plaintext keys do not belong in the bridge config.

Grok uses `agent --no-leader --model <alias> --reasoning-effort xhigh stdio`.
DeepSeek uses `--profile acp --patch <patch.yml>`; the patch selects the provider
and loads the bundled `deepseek-events.mjs` observer. The observer reports original
native events and IDs; it does not rewrite prompts or model output.

Sources: [Grok Build](https://docs.x.ai/build/overview),
[Grok settings](https://docs.x.ai/build/settings/reference),
[Grok source](https://github.com/xai-org/grok-build),
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A repair is a submission after rejected implementation; the initial submission is
not a repair. Proactive simple OpenCode work permits one repair (2 submissions);
user delegation defaults to three repairs (4 submissions). At the cap, stop the
owned executor, preserve its rejected state, and let Codex fix remaining defects.
Only unresolved blockers after Codex attempts repair need user discussion.
