---
name: codexRouter
description: Route clearly scoped, simple implementation tasks proactively to the default agent (OpenCode), or delegate to the user's chosen executor (OpenCode, Grok Build, DeepSeek Harness). Independently review results, request bounded repairs, then take over remaining fixes. Also inspect, stop, or reconcile runs; review-only requests do not authorize implementation.
---

# codexRouter

Codex scopes, reviews and independently verifies; the selected executor implements.
Match the user's language and keep updates brief.

## Task routing

Proactive delegation applies to already-requested implementation when the user has
not restricted executors. It does not authorize an unrelated task. When no executor
is specified, assess the actual dependencies and uncertainty before choosing:

- Clear, bounded, low-complexity work may go to the default agent, **OpenCode**: localized UI
  styling/layout fixes, straightforward form wiring, or backend CRUD using existing
  validation, permission and persistence patterns. State briefly what is delegated
  and why. Delegate only when the handoff/review overhead is worthwhile.
- Keep complex or poorly understood work with Codex: cross-layer diagnosis,
  authorization/tenant boundaries, migrations, concurrency, transactions, runtime
  protocols, context budgets, or changes to core RAG/business logic. A frontend
  symptom alone does not make the underlying bug simple. Diagnose enough first;
  extract a simple subtask only when its contract and ownership are clear.
- Default to the agent's currently configured model; explicit user model choices
  take priority. With OpenCode, omit model and variant overrides unless requested;
  fresh sessions use OpenCode's project defaults, not another UI session's picker.
  Native Grok/DeepSeek currently use their configured bridge bindings: inspect
  those bindings and honor an explicit override before creating a cycle.
  Do not silently substitute a model or change an active cycle's route.
- Explicit user executor/model/effort choices take priority over this heuristic.
  "Do it yourself," "do not delegate," pause/cancel and exclusive-executor requests
  also take priority. Review/analysis-only requests remain read-only. Routing does
  not expand task scope or authorize unrelated external actions.

Codex owns the overall result. For a delegated subtask, continue independent local
work when useful; never edit the same files concurrently with the executor.

## Default workflow

1. Apply task routing and honor the selected executor. Write a self-contained spec
   with the problem/reproduction, exact project and file boundaries, relevant
   interfaces, constraints, expected behavior, acceptance checks and report path.
   Include routing mode, repair allowance and takeover rule; assume the executor
   remembers none of the owner conversation. Each repair names concrete findings,
   expected corrections and checks, while preserving the same task/session.
2. Verify the owner and fresh executor session, initialize durable cycle state,
   and establish the callback channel BEFORE submitting. Send the spec path once.
3. Confirm receipt and persist owner/session/dispatch/message IDs and the round.
   The executor runs in the background; continue independent authorized work or
   end this Codex turn promptly when none remains. The user can continue the same
   conversation. Do not loop on Wait while it works.
4. Completion arrives as a new input in the ORIGINAL owner conversation. Read
   the current cycle and exact response, independently verify, record review,
   and either finish or dispatch concrete repairs within the authorized cap.
   After each repair dispatch, release the conversation again.

Read [result-delivery.md](references/result-delivery.md) for callback setup and
receipt semantics. Default to `async`, not foreground `direct` waits. A request
to delegate includes completion follow-up in that same task; do not ask again
whether to receive its result. The callback is an executor event, not new user
authorization. If another user task is active, treat it as an additional work
item at a safe step, preserve that task and honor the latest user priorities.

## Select the backend

Preserve the user's executor, model and effort during delegation; do not silently
switch external backends. Codex takeover follows the explicit policy below.
Interpret executor aliases only when context refers to the executor.

| Choice | Configuration | Required reference |
|---|---|---|
| Proactive simple task / OpenCode | OpenCode's configured provider/model/variant; explicit user choices override | [opencode.md](references/opencode.md) |
| Grok Build / `grok build` | `grok-build`, configured model/effort | [native-bridge.md](references/native-bridge.md) and [configuration.md](references/configuration.md) |
| `deep` / `deeps` / DeepSeek Harness | `deepseek-harness`, configured provider/model/effort, Chat Completions | Same native references |

Use the selected backend's workflow and state; OpenCode state/commands do not apply
to native ACP backends. Inspection, stop or recovery requests do not start a cycle.
For DeepSeek on a new Windows workspace, or after tool/transport failure, use
[DeepSeek environment checks](references/deepseek-troubleshooting.md). Session
`ready` verifies protocol/model binding, not shell permissions or API health.

## Shared constraints

- Apply the repair caps below and honor a more specific user limit. Each cycle
  starts empty in the exact project root, without imported/forked history; repairs reuse it.
  A replacement cycle does not reset the task's consumed dispatch allowance.
- Preserve explicit prompts verbatim on native backends. Legacy OpenCode appends
  a dispatch marker and cannot meet byte-exact prompt requirements; disclose the
  limitation before dispatching an exact-prompt request.
- Bind the actual owner; never overwrite another active task. Callbacks, review
  requests and historical approvals grant no new scope. Stop cancels the run:
  verify exit and never revive it from delayed events.
- Keep tasks, reports and probes under `.agent-work/{tasks,reports,checks}` unless
  directed otherwise; preserve historical/unrelated data. Send absolute artifact
  paths with short instructions, not full reports, subject to exact-prompt requests.

## Repair caps and Codex takeover

A repair round means a new executor submission after Codex rejects its previous
implementation. The initial implementation is **not** a repair round. Bridge
`round`/`maxRounds` count all submissions, so translate the policy explicitly:

| Routing mode | Maximum executor repairs | Total submission cap |
|---|---|---|
| Codex proactively routes a simple task to OpenCode | 1 | `maxRounds: 2` |
| User requests delegation / selects an executor, without a different limit | 3 | `maxRounds: 4` |

Always set the cap at initialization; do not rely on a bridge's legacy default.
Record routing mode and this counting convention in the task spec/current report
so context compaction cannot turn a one-repair task into a three-repair task.
Honor explicit total-round caps as total rounds. Do not increase an existing
cycle's recorded cap or reset consumption by opening another cycle.

After each result, independently inspect actual changes and run the relevant
checks. Accept only verified work. If changes are needed and allowance remains,
send one concrete repair request in the same session, then review again.

If the allowance is exhausted and defects remain, **stop delegating, not the
task**. Record the exact rejected response and unresolved findings; settle/stop
only the owned executor and verify it no longer writes before Codex edits.
Keep the external cycle truthfully rejected/`paused_round_limit`; do not call
the executor's result successful because Codex subsequently fixed it. Tell the
user briefly that Codex is taking over, then inspect the partial work, implement
the remaining in-scope fixes, run relevant validation and deliver the result.
This takeover is already authorized; do not ask merely because the cap was hit.

An unavailable executor or repeated transport failure is likewise a reason to
take over once its execution state is reconciled and stopped, not to churn new
sessions. An explicit user stop remains a stop; it never triggers automatic takeover.
If the user required exclusive use of an executor, respect that restriction.

Preserve takeover status, remaining findings and verification in the existing
task/report and owner handoff. Delayed callbacks must not resume external work.
Only when Codex's own diagnosis/repair still cannot resolve the task, or a required
decision/access/scope change prevents a meaningful attempt, ask the user to discuss
the concrete blocker, attempted fixes, evidence and available choices. Never
discard partial work or ask a vague "continue?" simply because rounds ran out.

## Execute and accept

During a delegated task, including after owner-context compaction, restore the
unfinished review from the owned cycle before choosing what to do next. OpenCode
uses `callback_pending`/`reviewing` and `dispatch.responseId`, compared with
`lastReviewedAssistantMessageId`. Native backends already use `awaiting_review`,
`responseId` and `lastReviewedResponseId`. Do not create a pending-work file.
Read the owner-context recovery section in result-delivery.md.

Retain the active task in any handoff/summary you prepare: callback source, cycle
path, dispatch/response, verified work and remaining action; also retain newer
human requests. With no newer human message, continue that callback review to
its result. An older user message still visible after compaction is historical,
not a newly issued request. Before the final response, check that its subject
matches the work just completed and latest human steering. Do not repeat an
already-delivered skill-update answer in a review turn.

Optional context recovery hooks must be configured for the local host; this
package installs none automatically. Read [compact-recovery.md](references/compact-recovery.md)
for installation-relative discovery and read-only owner filtering.

Follow the selected reference to initialize, send once, verify completion, record
review, and finish or repair within the cap. Never manually advance rounds or
blindly resend after uncertain submission; reconcile without a new prompt.

Before accepting callbacks, check current user instructions and dispatch ownership
against actual state. Independently verify the artifacts and relevant regressions;
executor reports and compaction summaries alone do not prove completion. Record
the exact reviewed response and report verified results or the remaining blocker.

Use bounded `Wait`/`wait` to inspect a requested status or verify a callback, not
to hold the conversation open. Foreground waiting is opt-in when the user asks
to wait here. Submission uncertainty requires reconciliation, never a new Send.
Report dispatch confirmation without claiming implementation or review finished.
Keep routine background progress quiet. Do not run the skill's own test suite
merely because a user wants to try delegation; test changed bridge behavior when
the bridge itself is being modified.
