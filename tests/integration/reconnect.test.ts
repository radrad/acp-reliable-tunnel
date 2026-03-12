import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TunnelServerConfig } from "../../src/config.js";
import { TunnelClientConnection } from "../../src/tunnel/client-connection.js";
import { ReliableAcpTunnelServer } from "../../src/tunnel/server.js";
import { NdjsonPeer } from "../../src/tunnel/ndjson-peer.js";
import { createMockAgentPeer } from "../../src/test-support/mock-agent.js";

describe("reconnect integration", () => {
  let server: ReliableAcpTunnelServer;

  beforeEach(async () => {
    const serverConfig: TunnelServerConfig = {
      listen: { host: "127.0.0.1", port: 0, path: "/acp" },
      auth: { mode: "shared-secret", secret: "secret" },
      reconnectWindowMs: 5000,
      handshakeTimeoutMs: 3000,
      agent: { command: "mock", args: [], env: {} },
    };

    server = new ReliableAcpTunnelServer(serverConfig, async () => createMockAgentPeer());
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("reconnects a tunnel and keeps the remote ACP session alive", async () => {
    const inputToBridge = new PassThrough();
    const outputFromBridge = new PassThrough();
    const localPeer = new NdjsonPeer(inputToBridge, outputFromBridge, "reconnect-bridge");
    const remote = new TunnelClientConnection({
      serverUrl: server.getUrl(),
      auth: { mode: "shared-secret", secret: "secret" },
      reconnect: { initialDelayMs: 50, maxDelayMs: 100 },
      metadata: { clientLabel: "reconnect-client" },
    });

    await remote.start();
    localPeer.onMessage((message) => {
      void remote.send(message);
    });
    remote.onMessage((message) => {
      void localPeer.send(message);
    });

    const updates: SessionNotification[] = [];
    const clientImpl: Client = {
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      sessionUpdate: async (params) => {
        updates.push(params);
      },
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
      createTerminal: async () => ({ terminalId: "term-1" }),
      terminalOutput: async () => ({ output: "" }),
      waitForTerminalExit: async () => ({ exitCode: 0 }),
      killTerminal: async () => ({}),
      releaseTerminal: async () => ({}),
    };

    const connection = new ClientSideConnection(
      () => clientImpl,
      ndJsonStream(
        Writable.toWeb(inputToBridge) as WritableStream<Uint8Array>,
        Readable.toWeb(outputFromBridge) as ReadableStream<Uint8Array>,
      ),
    );

    try {
      await connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
      const session = await connection.newSession({ cwd: "C:/repo", mcpServers: [] });
      const tunnelId = remote.getTunnelId();
      expect(tunnelId).toBeTruthy();

      await server.forceDisconnectTunnel(tunnelId!);
      await new Promise((resolve) => setTimeout(resolve, 120));

      await connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "resume after reconnect" }],
      });

      expect(updates.some((update) => update.sessionId === session.sessionId)).toBe(true);
    } finally {
      await remote.close();
      inputToBridge.destroy();
      outputFromBridge.destroy();
    }
  });
});