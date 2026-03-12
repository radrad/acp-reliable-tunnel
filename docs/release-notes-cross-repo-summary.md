# Cross-Repo Release Notes Summary

## Audience

This document is the short summary of the cross-repo work for readers who do not need the full transport and payload walkthrough.

For the detailed implementation tutorial, see `docs/cross-internet-acp-tunnel-tutorial.md`.

## Headline

We added a reliable, reconnectable, authenticated ACP tunnel over WebSocket without changing ACP wire semantics.

The result is that `vscode-acp` can keep launching a local ACP-compatible subprocess, while the real agent runtime can run on another machine behind a reliable tunnel and still use ACP client capabilities such as file access and terminal execution.

## Compact Repo Breakdown

| Repository | Needed changes? | Summary |
| --- | --- | --- |
| `agent-client-protocol` | No | ACP already had the right transport-agnostic contract. No protocol extension was required for this feature. |
| `vscode-acp` | Yes | Added remote tunnel discovery, provider extensibility, refresh behavior, multi-session state, debugging hooks, and packaging support. |
| `claude-agent-acp` | Yes | Added session cwd normalization, allowed-root enforcement, and session ownership checks for resume/load flows. |
| `acp-reliable-tunnel` | Yes | Added the new transport layer: local stdio shim, reliable replay and ACK channel, tunnel auth, reconnect window, and remote agent hosting. |

## Why `agent-client-protocol` Did Not Need Functional Changes

The central design decision was to preserve ACP itself.

We did not add WebSocket semantics to ACP methods, requests, or notifications. Instead, we wrapped raw ACP JSON-RPC payloads inside a reliable transport frame and handled reconnect, replay, authentication, and socket lifecycle entirely below ACP.

That is why the protocol repo did not need feature-bearing source changes for this work.

## What Changed In Practice

### `vscode-acp`

- can surface a remote tunnel-backed agent alongside local agents
- can refresh discovered agents
- can accept external provider registrations
- can track multiple ACP sessions in the UI

### `claude-agent-acp`

- now treats cwd as a verified boundary rather than a loose parameter
- rejects resumed or loaded sessions that do not belong to the normalized cwd
- documents and tests the tighter session policy

### `acp-reliable-tunnel`

- introduces `hello`, `welcome`, `data`, `ack`, and `close` tunnel frames
- authenticates clients with shared-secret or JWT
- binds tunnel ownership to the authenticated subject
- keeps the remote agent alive during transient disconnects
- replays unacknowledged ACP payloads after reconnect

## End Result

The architecture now supports this deployment model:

1. VS Code remains local.
2. `vscode-acp` still speaks ACP over stdio to a local subprocess.
3. That subprocess is a tunnel-aware shim.
4. The shim connects over WebSocket or WSS to a remote tunnel server.
5. The remote server hosts `claude-agent-acp`.
6. `claude-agent-acp` delegates to Claude Code CLI or the Claude Agent SDK.

This gives remote execution and reconnect resilience without fragmenting ACP.