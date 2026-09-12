---
name: codexrouter
description: Delegate authorized implementation asynchronously to OpenCode, official Grok Build, or DeepSeek Harness using a detailed spec, then independently review completion callbacks. Also inspect, stop, or reconcile runs. Review-only requests do not authorize dispatch.
---

# codexrouter

Codex scopes, reviews and independently verifies; the selected executor implements.
Match the user's language and keep updates brief.

## Default workflow

1. Write a detailed spec: problem, scope, constraints, expected behavior, acceptance
   checks and report path. Delegation includes follow-up on that authorized work.
2. Verify the owner and fresh executor session, initialize durable state, and
   establish callback readiness before submitting the spec path once.
3. Confirm the receipt, session, dispatch, request ID and round; then end the
   current turn promptly. The executor runs in the background.
4. Completion submits new input to the original owner conversation. Verify its
   identity, independently review the result, and finish or request repairs within
   the cap. Release the conversation after each confirmed repair dispatch.

Callbacks remain executor events, not new authorization. Preserve any other
active user task and handle the callback at a safe step under the latest instructions.
Read [result-delivery.md](references/result-delivery.md) before dispatch.

## Select the backend

Preserve the user's executor, model and effort; never silently switch or fall back.
Interpret executor aliases only when context refers to the executor.

| Choice | Configuration | Required reference |
|---|---|---|
| No selection / OpenCode | Explicit provider/model in cycle configuration; explicit variant | [opencode.md](references/opencode.md) |
| Grok Build / `grok build` | `grok-build`, configured model and effort | [native-bridge.md](references/native-bridge.md) and [configuration.md](references/configuration.md) |
| `deep` / `deeps` / DeepSeek Harness | `deepseek-harness`, configured provider/model and effort | Same native references |

Use the selected backend's workflow and state; OpenCode state/commands do not apply
to native ACP backends. Inspection, stop or recovery requests do not start a cycle.
For DeepSeek on a new Windows workspace, or after tool/transport failure, use
[DeepSeek environment checks](references/deepseek-troubleshooting.md). Session
`ready` verifies protocol/model binding, not shell permissions or API health.

## Shared constraints

- Default to at most three implementation rounds; announce the bound and honor
  the user's limit. Extra rounds require authorization. Each cycle starts empty
  in the exact project root, without imported/forked history; repairs reuse it.
  A replacement cycle does not reset the task's consumed dispatch allowance.
- Preserve explicit prompts verbatim on native backends. Legacy OpenCode appends
  a dispatch marker and cannot currently meet byte-exact prompt requirements;
  disclose that limitation and ask before changing the user's selected executor.
- Bind the actual owner; never overwrite another active task. Callbacks, review
  requests and historical approvals grant no new scope. Stop cancels the run:
  verify exit and never revive it from delayed events.
- Keep tasks, reports and probes under `.agent-work/{tasks,reports,checks}` unless
  directed otherwise; preserve historical/unrelated data. Send absolute artifact
  paths with short instructions, not full reports, subject to exact-prompt requests.

## Execute and accept

Follow the selected reference to initialize, send once, verify completion, record
review, and finish or repair within the cap. Never manually advance rounds or
blindly resend after uncertain submission; reconcile without a new prompt.

Before accepting callbacks, check current user instructions and dispatch ownership
against actual state. Independently verify the artifacts and relevant regressions;
executor reports and compaction summaries alone do not prove completion. Record
the exact reviewed response and report verified results or the remaining blocker.

If the owner conversation compacts while reviewing, recover from the owned cycle
and its pinned response, not the last visible historical user request. Continue
the unfinished review unless actual newer user input changes the work. Do not
repeat completed checks when their sources still match. The final response must
address the work being finished. Read [compact-recovery.md](references/compact-recovery.md)
for recovery, state loss and optional host hook setup. This skill manages its own
delegated reviews only; it does not maintain a global conversation task queue.

All backends default to asynchronous delivery. Use bounded `Wait`/`wait` for a
requested status check or callback verification; foreground waiting is opt-in.
A dispatch receipt is not task completion. An uncertain send requires read-only
reconciliation, never blind resubmission. Keep normal progress quiet and preserve healthy services.
