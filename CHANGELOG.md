# Changelog

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
