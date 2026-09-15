# OpenCode bridge (Windows)

`ROOT` means this repository's `legacy` directory. Pass the actual code project with `-Directory`.
Default service: `http://127.0.0.1:4096`; override with `OPENCODE_REVIEW_URL`.

- `outputs/opencode-bridge.ps1`: Health, Start, Sessions, Api, Read, Snapshot,
  Send, Wait and Reconcile. Health is read-only; Start recovers an unavailable service.
- `outputs/opencode-events.ps1`: Start, Status, Probe. Start verifies readiness.
- Keep the five adjacent `opencode-*.cjs` runtime modules and
  the repository dependency installation (`npm ci`) together with these entrypoints.
- `work/opencode-bridge/`: `review-cycle.json` (one shared cycle),
  `event-delivery.json` (notification ledger), `event-runtime.json`, process locks
  and logs. Reuse the DPAPI `credential.xml`; never expose plaintext credentials.

## Initialize and dispatch

Establish scope and acceptance criteria, inspect project instructions, and save
the task/report before initialization. Codex owns `review-cycle.json`, never Grok.
Do not change unrelated automations. SSE plus the watchdog observes results and
the async callback submits new input to the exact owner. Configure and verify
the channel as described in [result-delivery.md](result-delivery.md).

1. Read shared state. Transfer ownership only when explicitly continuing the same
   cycle; preserve rounds and in-flight work. Obtain `$env:CODEX_THREAD_ID`; if absent,
   resolve this exact task through app tools and supply its verified ID to the
   helper environment. Never guess from the most recent task.
2. Create a NEW session via Api POST `/session`, explicit code directory, and a
   small JSON BodyFile such as `{"title":"Current task"}`. Verify returned directory
   and empty Read/Snapshot history. If creation is ambiguous, inspect Sessions
   before retrying. No model field is needed at creation. Omit model and variant
   overrides to use OpenCode's defaults for this project. A fresh session does not
   inherit a different desktop/TUI session's temporary model selection.
3. Archive a completed previous state in its project's `.agent-work/history`.
   Atomically initialize `status: ready_to_dispatch`, `codexThreadId`, `sessionId`,
   `sessionTitle`, `directory`, `codeDirectory`, `scope`, `sourceReport`,
   `currentTaskFile`, `latestReviewReport`, `round: 0`, `maxRounds: 4` for user delegation or `2` for proactive simple work (or user bound),
   Supply `model: {providerID, modelID}` only for an explicit override; otherwise omit it.
   `deliveryMode: async`, `submittedMessageId: null`,
   `lastReviewedAssistantMessageId: null`. Omit any old `dispatch`; retain
   `automationId` only as paused legacy metadata.
4. Send the absolute task/report and desired result-file paths with short instructions.
   `PromptFile` sends the entire file; do not use it to paste a full report.

```powershell
& 'ROOT\outputs\opencode-bridge.ps1' -Action Api -ApiPath '/session' -Method POST -Directory '<code-root>' -BodyFile '<creation-json>'
& 'ROOT\outputs\opencode-bridge.ps1' -Action Snapshot -Directory '<code-root>' -SessionId '<session-id>'
& 'ROOT\outputs\opencode-bridge.ps1' -Action Send -Directory '<code-root>' -SessionId '<session-id>' -Prompt '<absolute task path and short instructions>'
& 'ROOT\outputs\opencode-events.ps1' -Action Status
```

Send requires `ready_to_dispatch` or `reviewing` and checks owner, actual directory,
empty fresh history or latest reviewed response, pending execution and round limit.
It saves a unique dispatch marker/hash and target round, starts the listener BEFORE
POST, submits once, then binds the stored user ID and saves `waiting_for_grok`.

New sends default to async delivery. Listener startup probes callback readiness
before POST. Confirm the request/dispatch/round and release the conversation.
On callback or a requested check, Wait verifies the owner, project and dispatch
against actual history and returns full text plus original/effective binding:

```powershell
& 'ROOT\outputs\opencode-bridge.ps1' -Action Wait -Directory '<code-root>' -SessionId '<session-id>' -DispatchId '<dispatchId returned by Send>' -TimeoutSeconds 45
```

A `completed: true` result is ready for independent review;
attention or binding mismatch requires inspection/reconciliation, never a new Send.
Incomplete compaction summaries keep waiting. Snapshot uses the same terminal-message
predicate as Wait/noticeFor and reports `compacting` for summary messages. Snapshot
alone does not prove dispatch ownership; use Wait's request binding before acceptance.
Use `deliveryMode: direct` for explicitly requested foreground waits or the
verified heartbeat fallback described in the result-delivery reference.
Choose `deliveryMode: events` only when queued inbox notices are explicitly wanted.

For manual state changes, use `readJson`, `saveJson`, `acquireLock` from
`ROOT/outputs/opencode-state.cjs`: acquire `work/opencode-bridge/dispatch.lock`,
read/validate owner and cursor, preserve other fields, save, release in finally.
The helper atomically replaces and verifies JSON. Send alone advances rounds;
re-read state after dispatch.

## Review and finish

On callbacks, verify owner and dispatch/request/response IDs against `Snapshot`/`Read`
and current user instructions. Reconcile missing or mismatched IDs; do not adopt
unrelated later executor messages. Completion requires normal assistant stop,
completion time and no pending tools, questions or permissions. For compaction,
use the original-ID verification below; its summary alone is not completion.

Before publishing a verified completion, the listener atomically saves
`dispatch.responseId` and `status: callback_pending` under the dispatch lock.
This identifies the response awaiting review, not proof of callback delivery;
the existing delivery ledger records that separately. If the response ID is
absent (older state, interrupted write or manual Wait), use Reconcile to pin it
from verified history before review. Never select an arbitrary latest reply.

After a verified Wait result or callback, preserve the pinned ID and save
`reviewing`, independently check changed code and relevant regressions, then
record `lastReviewedAssistantMessageId` and `latestReviewReport`. Send only concrete
remaining defects within authorized scope and rounds. Persist and verify `complete`
or descriptive `paused_*`, check listener `Status`, and report results or the blocker.

## Recovery

**Submission/state uncertainty:** leave the listener running and call:

```powershell
& 'ROOT\outputs\opencode-bridge.ps1' -Action Reconcile -Directory '<code-root>' -SessionId '<session-id>'
```

Reconcile makes no model request. It requires one matching dispatch marker AND
prompt hash with no newer human request; a legacy cycle without a marker requires
its already-recorded exact ID and allows no later user-role messages.
Automatic compaction is accepted only with same-session, ordered `auto: true`
compaction requests, successful compaction-summary parent links, and text parts
marked `synthetic: true` plus `metadata.compaction_continue: true`. Text alone is
not proof. `requestBinding` records original/effective IDs and the verified chain;
`submittedMessageId`, owner and round stay bound to the original dispatch.
Reconcile also restores a missing response pin when completion is proven. It
preserves `reviewing`, rejects a changed pinned response and does not restart the
listener during an existing review. A repair Send requires the pinned response
to have been reviewed; its new dispatch replaces the old response pin. See
[compact-recovery.md](compact-recovery.md) for owner-context and crash recovery.
Send binding, Reconcile and callbacks share this verifier. An unfinished summary
never counts as task completion; stranded compaction still reaches the watchdog.
If evidence is ambiguous, inspect Read/Snapshot
instead of adopting the latest message or retrying Send. Only if the startup error
and session prove POST never happened may state return to its prior ready/reviewing
status for retry. Missing IDs, dispatching and deliveryUncertain still receive
completion/attention reconciliation notices and watchdog checks.

**Unknown callback/queue delivery:** Status exposes `deliveryBlocked`. A timeout, missing
acknowledgement, nonzero exit or crash-left pending entry prevents automatic resend.
Check the exact event key in the target task's queued/received messages. Pause the
cycle and wait for listener exit before editing the ledger; preserve it and the
verification evidence. If app submission is verified, add the key to `submitted`;
for verified legacy queue acceptance use `queued`; if proven unsent,
leave it undelivered. Clear only the resolved pending/deliveryUncertain entries,
record evidence/outcome, atomically save, restore status and Start. Truncated history
is not proof of non-delivery. Retain unresolved blocks; never delete the ledger.
An acknowledged callback retries only local persistence, not submission.
Async acknowledgements use `submitted` / `lastSubmitted` with `autoSubmitted: true`.
New acknowledgements use `queued` / `lastQueued` with `autoSubmitted: false`.
Historical `delivered` entries remain untouched for deduplication and prove only
queue acceptance. Direct mode neither queues notices nor erases old uncertainty;
it stores `lastNotice.status: available` and receives results through Wait.

**Locks:** Status lists `listener.lock` / `dispatch.lock` PID metadata. Check the
exact PID and command line; remove only a proven abandoned lock, then Reconcile.

**Stall/service outage:** the five-minute local watchdog invokes no model; stall
alerts arrive 5-10 minutes after progress stops, respecting a declared tool timeout
plus 60 seconds. Inspect actual progress, pending requests, process/port and logs.
Leave healthy/progressing work running; dev servers need not exit to be ready.
For a confirmed hung in-scope request: pause callbacks, abort only that request,
verify stopped, preserve partial files, recover only an unavailable service, and
save a factual handoff before continuing in the same session within the round cap.
If the same failure recurs after one targeted recovery, pause and report the cause.

**Session migration / listener updates:** explicit fresh-session requests require
pausing callbacks, stopping only the recorded request and verifying no execution
remains; preserve partial files and rounds, with no history import. Listener-only
updates pause callbacks and await exit, replace scripts, restore state and Start;
they do not abort Grok, clear the ledger or restart its server.

Local delivery needs this computer and Codex running; there is no reboot autostart
or exactly-once guarantee across queue/crash uncertainty.

Initialize owned legacy state with `node scripts/init-opencode.cjs --directory <project> --session <verified-empty-session> --owner <thread-id> --task <task-file> --scope <authorized-scope>`. Add both `--provider` and `--model` only for an explicit model override; add `-Variant` to Send only for an explicit effort override. This command does not create a remote session or send a prompt. It refuses to replace any existing state; archive an inactive cycle after inspection.

A repair is a submission after rejected implementation; the initial submission is
not a repair. Proactive simple OpenCode work permits one repair (2 submissions);
user delegation defaults to three repairs (4 submissions). At the cap, stop the
owned executor, preserve its rejected state, and let Codex fix remaining defects.
Only unresolved blockers after Codex attempts repair need user discussion.
