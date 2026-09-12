# Security

Do not attach credentials, raw conversation journals, private project files or unredacted model output to public issues. If a key leaks, revoke/rotate it with its provider before cleaning up copies. `.gitignore` does not remove existing Git history.

Report reproducible security problems through the repository's private vulnerability reporting feature when available. If it has not been enabled, open a minimal public request for a private reporting channel without including sensitive details. The repository owner should enable private vulnerability reporting and GitHub secret scanning/push protection before public release.

The bridge stores prompts, protocol events, tool output and responses locally to prove request/response identity. These files may contain private data even when no API key is stored. Runtime folders are excluded from release archives and Git by default. Review permissions and scope before allowing tools: executors are not a filesystem or network sandbox. Generated configuration defaults to direct result returns; events/heartbeat require explicit environment support.

Version 0.1.x is the initial development line. No security audit or sandbox guarantee is claimed.
