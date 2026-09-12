# Changelog

## Unreleased

- Remove bundled tests, mock executors and the test runner. CI retains dependency,
  environment and release-file checks; production runtime behavior is unchanged.

- Rename the repository and skill to `codexrouter` and simplify the README.

- Expand Windows short directory names before opening native and legacy file watchers,
  avoiding a libuv assertion that aborted the first GitHub Actions run.
- Add an isolated short-path watcher regression test on Windows volumes with 8.3 aliases.

## 0.2.1 - pinned review recovery

- Include the installed skill's DeepSeek Windows preflight, sandbox/transport
  troubleshooting and optional DNS preload with portable runtime resolution.
- Keep cumulative dispatch limits when recovering from a settled provider error.

- Save the verified OpenCode response ID and `callback_pending` state before callback submission, using the existing cycle and delivery ledger.
- Reconcile missing response pins without another model prompt; preserve ongoing reviews and reject changed targets. Keep ambiguous receipt replay blocked.
- Resume the unfinished callback review after owner-context compaction and preserve actual newer user instructions.
- Add an optional read-only SessionStart/compact hook, filtering by the event's owner ID with installation-relative state discovery. Generate portable host configuration without installing or trusting it automatically.
- Reuse native response/review fields; add no pending-work file or global task manager.
- Cover state-write failure, restart boundaries, dynamic ownership and relocated hook execution. Preserve previous permission, cleanup, routing and compaction-chain checks.

## 0.2.0 - asynchronous owner callbacks

- Default to spec, confirmed dispatch, conversation release and independent callback review.
- Submit completion/attention through the configured Codex App Tools MCP server to the exact owner without changing its model settings.
- Probe callback availability before dispatch; record intent and acknowledgement, and block replay of uncertain receipts.
- Support portable environment/file configuration without bundling personal runtime paths.
- Retain explicit foreground waits and legacy queue mode; document verified heartbeat fallback.
- Preserve the 0.1.1 permission, compaction, cleanup, timeout and routing fixes.
- Add mocked callback and detached-process coverage; external model review remains deferred.

## 0.1.1 — review corrections

- Bundle the queued-notice workflow target and share Snapshot/Wait summary exclusion.
- Persist and validate ACP permission decisions during reconciliation.
- Validate raw observer payloads and keep compaction failures distinct from success.
- Guarantee worker lock cleanup attempts, reject unverified prior runtimes, and bound process termination.
- Extend command acknowledgement to 45 seconds with explicit bounded override.
- Require explicit OpenCode variant; persist a cycle title; make Grok stream idle timeout configurable.
- Retry brief Windows atomic state replacement contention without resending model requests.
- Exercise the real observer in mock process tests, including permissions, malformed payloads and failures.
- Keep tracked/ignored release scan semantics and test listener paths containing spaces.

## 0.1.0 — initial public-source preparation

- Bundle native and legacy bridges and all existing regression tests in one repository.
- Remove machine-specific skill references, executable paths and provider IDs.
- Add explicit provider/model routing, config generation and local environment checks.
- Preserve direct results, request binding, bounded waits, review gates and compaction handling.
- Add Windows CI, dependency lockfile, release-file checks, documentation and MIT license.
- Mark desktop wakeup and real long-context compaction as environment-dependent/unverified release capabilities.
