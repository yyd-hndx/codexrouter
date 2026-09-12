# Release validation - 0.2.0

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
