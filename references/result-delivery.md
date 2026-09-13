# Asynchronous completion delivery

The normal workflow releases the conversation after confirmed dispatch. The
executor's completion event submits a new message to the original owner task.
Do not keep a foreground Wait loop alive just to receive the result.

## Local callback channel

`scripts/owner-notify.cjs` uses the installed Codex App Tools MCP server and its
`send_message_to_thread` tool, preserving the owner's current model/settings.
It does not use `codex queue`, start another Codex session, simulate keyboard
input, or run `codex exec resume`. The source remains an executor event even
though the app delivers it as a new conversational input.

The notifier discovers the newest installed `codex-app-tools` server under the
current `CODEX_HOME` plugin cache and uses the inherited Node path or current Node.
Explicit `CODEX_APP_TOOLS_MCP_SERVER` and `CODEX_MCP_NODE_PATH` overrides take
priority. For a private file, use the fields in
[`owner-notify.example.json`](../scripts/owner-notify.example.json) at
`$CODEX_HOME/codexRouter/owner-notify.json`, or select a file with
`CODEX_OWNER_NOTIFY_CONFIG`. Relative paths resolve beside that file.
The older `scripts/owner-notify.local.json` is retained as a compatibility fallback.
An explicit stale or malformed configuration fails rather than silently choosing
another server. Real local configuration must remain untracked.
The worker inherits `CODEX_APP_TOOLS_PIPE_PATH` from the owning Codex environment.
This integration depends on an installed app-internal MCP server exposing the
named tool; it is not a standalone public service bundled in this repository.
Never copy secrets
or invent an owner ID. A worker started outside that environment needs a verified
configuration or the explicit fallback below.

Before dispatch, run `node <skill>/scripts/owner-notify.cjs probe`. This is a
read-only availability check. OpenCode listener startup and native `init`
perform it automatically for `async`. Probe success proves availability, not
delivery; a real submitted callback received in the owner conversation proves
the integration. Application updates can change this capability.

OpenCode uses `deliveryMode: async`; native backends use `--notify async`.
Both persist event identity before submission, submit once, then record the
acknowledgement. Ambiguous transport results block automatic resubmission.
Read actual owner messages before reconciling uncertain receipts. Do not fall
back to a second delivery channel after an ambiguous send.

## Dispatch and return

1. Save the spec and acceptance criteria. Record exact owner, backend, project,
   state/cycle path, session, dispatch, request ID and authorized round cap.
2. Verify callback readiness, submit once, and verify the resulting request ID
   and round. Preserve those fields across compaction and restarts.
3. End the current turn with a short dispatch confirmation. No foreground
   polling, progress spam or unrelated testing while the executor works.
4. On callback, load the skill and owned state. Match event, dispatch, original
   request and actual response; stale events never restart a stopped cycle.
5. If the owner is idle, process the review. If another task is active, handle
   the event like additional user input at a safe step, without losing that task
   or overriding a newer explicit user instruction. A completion notification
   is a review request, not evidence that the implementation is correct.
6. Independently verify, persist the exact reviewed response/report, and complete
   or send in-scope repairs within the cap. Each repair keeps the same session,
   advances the round exactly once through Send, and releases the conversation.

An executor compaction summary is intermediate. Preserve the original dispatch
ID and verify the continuation chain; do not accept the summary as completion.
Owner conversation compaction is separate: persist the exact review target before
callback submission, then resume that target after compaction. See
[owner review recovery](compact-recovery.md) for the existing-state protocol and
optional host hook. A notification's transport role never changes its provenance.
User conversation topic changes do not cancel existing delegated work. Explicit
stop/cancel does; delayed callbacks must then be ignored.

## Degraded fallback

If the callback channel is demonstrably unavailable BEFORE submission, explain
the limitation briefly and attach a heartbeat to the exact existing owner using
`automation_update`. Reuse its existing automation, save its ID and schedule
with the dispatch handoff, and verify ACTIVE status. Five minutes is a practical
fallback interval; label it scheduled checking, not instant event delivery.

After verifying the heartbeat, explicitly initialize native `--notify manual`
or OpenCode `--delivery-mode direct` so an unavailable async channel does not block
dispatch. Here the heartbeat consumes stored results; it does not start a foreground
wait loop. If dispatch already exists, inspect state and do not initialize again.

Each heartbeat makes one bounded status check and stays quiet while unchanged
or running. On verified completion it resumes the authorized review. Stop/update
it when the cycle stops/completes or ownership/dispatch changes. Do not duplicate
an already-submitted callback. Disable a temporary heartbeat after a verified
callback channel takes over, preserving any historical uncertainty.

If neither delivery mechanism is available, state that automatic follow-up is
unavailable and preserve the handoff. Do not silently occupy the foreground;
the user can request a later status check. Foreground `direct` waits are only
for an explicit request to wait in this turn.

## Receipt meanings

- `available`: result stored locally, not submitted to Codex.
- `queued`: legacy CLI queue accepted an item; no automatic wakeup is proven.
- `submitted`: the app tool accepted a new input for the exact owner task.
- Received callback in the owner conversation: actual delivery observed.
- Response-bound independent review: Codex acceptance, distinct from delivery.

The local app/computer must remain available. Persistent ambiguous receipts are
not an exactly-once guarantee; never turn uncertainty into an automatic resend.
