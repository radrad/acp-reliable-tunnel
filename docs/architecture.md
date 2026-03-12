# Architecture

For a short release-note view of the cross-repo work, see `docs/release-notes-cross-repo-summary.md`.

For the full cross-repo tutorial covering `agent-client-protocol`, `vscode-acp`, `claude-agent-acp`, and this tunnel repository, see `docs/cross-internet-acp-tunnel-tutorial.md`.

## Deployment model

Client machine:

- ACP client such as `vscode-acp`
- local stdio shim from this project
- reliable WebSocket tunnel client

Remote machine:

- tunnel server from this project
- remote ACP agent process such as `claude-agent-acp`
- local Claude Code / Claude Agent SDK runtime

## Why a local stdio shim exists

`vscode-acp` currently expects to spawn an ACP-compatible subprocess and talk to it over stdin/stdout. Instead of modifying ACP itself, this project preserves that contract locally and swaps only the transport beneath it.

That gives you:

- no ACP wire changes visible to the editor
- no ACP SDK fork
- easy fallback to local stdio agents
- a migration path for other ACP clients

## Reliability rules

- Sequence numbers are monotonic per direction.
- ACKs are cumulative.
- Messages remain in the sender outbox until acknowledged.
- Replayed frames are dropped if their sequence number is already committed.
- The remote agent process is kept alive for `reconnectWindowMs` after socket loss.

## Current scope

Implemented now:

- dedicated tunnel per ACP client
- reconnect with replay and duplicate suppression
- generic remote agent subprocess hosting
- test harness for multiple clients and multiple sessions

Not implemented yet:

- multiplexing several front-end clients into one shared ACP connection
- persistent disk-backed outbox for host restarts
- TLS termination and stronger authentication than a shared secret

## Recommended integration path with `claude-agent-acp`

Use the existing `claude-agent-acp` package unchanged on the remote machine.

Configure the tunnel server's `agent.command` to `claude-agent-acp` and set the expected environment variables. This is the least risky path because it preserves upstream behavior and isolates the new transport logic inside this repo.