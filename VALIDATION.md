# Release validation

## 0.3.0 - 2026-09-13

Compared the supplied 0.2.1 archive, installed skill changes and GitHub main at
`8d11f66`. Retained the repository's portable configuration, permission/receipt
checks, Windows watcher fixes and checks-only CI. Tests stay outside the shipped
package, matching the existing repository layout.

Validation used Windows, Node.js 24.19.0, PowerShell 7 and the installed official
DeepSeek Harness 0.1.5-rc.1:

- The archive's 140 regression checks passed in an isolated copy of the updated
  runtime. After merging the installed callback/discovery changes, all 31 focused
  callback, recovery, configuration and detached-worker checks passed; the old
  missing-config assertion was adapted to the new sanitized error wording.
- Eight additional checks passed: DNS source failure/timeout, address ordering,
  exact-origin isolation, real socket fallback, relocated managed startup,
  same-request retry tracking and error-body filtering.
- Real Harness against a local synthetic HTTP/SSE server recovered from a connect
  reset followed by a mid-stream reset: 3 model requests, 2 retries, 1 dispatch,
  unchanged native session, verified final OK. Continuous failure stopped after
  5 retries (6 requests), without a completed response. Cancellation during
  backoff stopped the runtime and produced no subsequent request.
- A real official `deepseek-official/deepseek-flash` request at `max` effort
  completed with OK using opt-in auto DNS, with no retry. A preceding system-DNS
  run exhausted retries; subsequent unauthenticated system connectivity succeeded.
  VPN/network conditions changed during the task, so these observations do not
  isolate VPN, DNS or TLS as the sole cause and do not promise future uptime.
- Current Codex callback tool availability was probed without sending a message.
  Actual delivery semantics were tested with mocks, not a new live notification.
- All 23 JavaScript and 3 PowerShell scripts passed syntax checks. Metadata,
  relative documentation links, local doctor and release-file scan passed.
  The user explicitly requested `codexRouter`; the generic skill validator's
  lowercase-only naming check therefore remains an intentional exception.

Default installations keep system networking. `--dns-mode auto` is an opt-in
address selection aid for a demonstrated failure; it does not retry whole tasks,
change TLS validation or select another provider. Generated local configs still
need regeneration when runtime/home locations change on another machine. macOS,
Linux, arbitrary Harness versions and third-party providers are not certified.

## 0.2.1 source update

Updated from the supplied `opencode-review-v0.2.1.zip`. The repository retains
the `codexrouter` name, concise README, Windows watcher path correction and
checks-only CI. Test files from the archive are excluded from the repository.
The optional recovery-hook generator only prints configuration; publishing this
version does not install a hook or change the user's Codex configuration.

The installed skill's DeepSeek preflight and environment-recovery guidance are
included, with an opt-in DNS preload adapted to resolve dependencies from the
selected runtime instead of a private installation path. Existing release
fixes for permission evidence, shutdown, notification configuration and Windows
watchers are retained.

Publication checks on Windows with Node.js 24.19.0 and PowerShell 7:

- An isolated copy of the final runtime passed 145 checks, 0 failed and 0 skipped,
  in approximately 164 seconds. This used the archive's 140 tests plus five
  installed DNS-routing checks. These test files are not shipped in this repository.
- All 25 published runtime scripts matched the isolated copy. Syntax checks
  passed for 22 JavaScript files and three PowerShell files.
- The read-only preflight ran against a disposable workspace with the installed
  official DeepSeek runtime and sandbox 0.1.5-rc.1. The portable preload resolved
  that runtime's installed dependency successfully in a separate process.
- Skill metadata and the 49-file release scan passed.

These checks made no model requests, changed no ACLs and installed no host hook.
They do not certify a real provider request, live callback or another workspace's
sandbox permissions. GitHub CI runs the retained installation/environment/release
checks rather than the removed regression suite.

## Historical 0.2.0 validation

The test suite and its fixtures were removed after the
[127-test CI run passed](https://github.com/yyd-hndx/codexrouter/actions/runs/34693251699).
The records below describe historical validation. Current CI checks installation,
development prerequisites and release files; it no longer runs regression tests.

## Windows CI watcher correction - 2026-09-12

The first [GitHub Actions run](https://github.com/yyd-hndx/opencode-review/actions/runs/34692504358)
aborted the native bridge and recovery test processes in libuv's Windows
`fs-event.c:72`. Its temporary directory used the `RUNNER~1` short-name alias.
This matches the upstream [short-path watcher assertion](https://github.com/libuv/libuv/issues/5010).
Both file-watcher entrypoints now expand their directory with
`fs.realpathSync.native` before registering the watcher. The new regression
uses a separate process and an actual 8.3 path; it skips on volumes without
short-name support. Earlier local intermittent failures remain unclassified
because their failing assertions were not retained.

## Publication recheck - 2026-09-12

Rechecked the supplied 0.2.0 archive on Windows with Node.js 24.19.0 and
PowerShell 7. Dependency installation, development doctor and the 58-file
release scan passed. The final full run passed all 125 tests in approximately
158 seconds, with no skipped tests. No executable or test code was changed.

The first publication recheck returned 124 passes and one failure; its failing
assertion was lost in truncated tool output. A second full run saved complete
output and passed. The intermittent failure remains undiagnosed; a passing
rerun does not establish a fix. GitHub-hosted CI is recorded separately.

## Original package validation

Verified locally on Windows on 2026-09-11 with Node.js 24 and PowerShell 7.
These results apply to the prepared package; GitHub-hosted CI has not run.

| Check | Result |
|---|---|
| Clean-directory dependency installation from lockfile | Passed |
| Final complete suite in clean directory | 125 passed, 0 failed, approximately 147 seconds |
| Focused callback and release checks | 39 passed |
| Separate native bridge and recovery run | 20 passed |
| JavaScript syntax | 34 files passed |
| PowerShell syntax | Both entrypoints passed |
| Skill metadata validation | Passed |
| Development environment doctor | Passed |
| Release-file and documentation-link scan | Passed |
| Prepared executable/test files vs clean test copy | All 36 files identical |

The first aggregate run returned 124 passes and one failure. Its streamed output
was truncated before the failing assertion was retained, so the precise initial
failure is not established. No executable code was changed to obtain the next
result: the separate native run and subsequent complete 125-test run passed.
The initial failure remains an unexplained non-reproduced test result; this record
does not claim it was diagnosed or fixed.

New coverage checks exact-owner callback arguments with no model override,
read-only availability probing, rejected/wrong-owner acknowledgements, durable
submission and restart deduplication, ambiguous receipt blocking, and environment
configuration without a local file. A detached native worker runs a mock ACP task,
then uses a real child-process MCP transport against a mock callback server.
The resulting request/response binding also passes read-only reconciliation.

Existing permission evidence, malformed observer events, failed compaction,
shutdown cleanup, delayed acknowledgement, routing and spaced-path process tests
remain in the suite. Tests use mock ACP/HTTP/queue/MCP services and do not dispatch
paid executors or send messages to real Codex tasks. Dependency installation
contacted npm.

The installed personal skill and other active executor tasks were not modified.
External OpenCode model review remains deferred.

Real desktop callback receipt, heartbeat execution, provider connectivity and
natural long-context compaction are not certified by this package's mock tests.
The async callback depends on an installed app-internal MCP server and inherited
pipe environment; app updates may require reconfiguration. Non-Windows systems
are unverified.

The release scan is heuristic, not a full security audit or Git history scan.
The archive excludes dependencies, runtime/session state, logs and real local
configuration. Re-run checks after changing the package or upstream runtimes.
