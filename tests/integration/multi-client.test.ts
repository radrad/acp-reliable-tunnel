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

type Harness = {
  connection: ClientSideConnection;
  updates: SessionNotification[];
  dispose: () => Promise<void>;
};

async function createHarness(serverUrl: string): Promise<Harness> {
  const inputToBridge = new PassThrough();
  const outputFromBridge = new PassThrough();
  const localPeer = new NdjsonPeer(inputToBridge, outputFromBridge, "test-bridge");
  const remote = new TunnelClientConnection({
    serverUrl,
    auth: { mode: "shared-secret", secret: "secret" },
    reconnect: { initialDelayMs: 50, maxDelayMs: 250 },
    metadata: { clientLabel: "test-client" },
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

  const stream = ndJsonStream(
    Writable.toWeb(inputToBridge) as WritableStream<Uint8Array>,
    Readable.toWeb(outputFromBridge) as ReadableStream<Uint8Array>,
  );

  const connection = new ClientSideConnection(() => clientImpl, stream);
  await connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

  return {
    connection,
    updates,
    dispose: async () => {
      await remote.close();
      inputToBridge.destroy();
      outputFromBridge.destroy();
    },
  };
}

describe("multi-client integration", () => {
  let server: ReliableAcpTunnelServer;
  let serverConfig: TunnelServerConfig;

  beforeEach(async () => {
    serverConfig = {
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

  it("supports multiple clients and multiple sessions from one machine", async () => {
    const clientOne = await createHarness(server.getUrl());
    const clientTwo = await createHarness(server.getUrl());

    try {
      const sessionOneA = await clientOne.connection.newSession({ cwd: "C:/repo-a", mcpServers: [] });
      const sessionOneB = await clientOne.connection.newSession({ cwd: "C:/repo-b", mcpServers: [] });
      const sessionTwoA = await clientTwo.connection.newSession({ cwd: "C:/repo-c", mcpServers: [] });

      await clientOne.connection.prompt({
        sessionId: sessionOneA.sessionId,
        prompt: [{ type: "text", text: "first turn" }],
      });
      await clientOne.connection.prompt({
        sessionId: sessionOneB.sessionId,
        prompt: [{ type: "text", text: "second session" }],
      });
      await clientTwo.connection.prompt({
        sessionId: sessionTwoA.sessionId,
        prompt: [{ type: "text", text: "third turn" }],
      });

      expect(clientOne.updates.some((update) => update.sessionId === sessionOneA.sessionId)).toBe(true);
      expect(clientOne.updates.some((update) => update.sessionId === sessionOneB.sessionId)).toBe(true);
      expect(clientTwo.updates.some((update) => update.sessionId === sessionTwoA.sessionId)).toBe(true);
    } finally {
      await clientOne.dispose();
      await clientTwo.dispose();
    }
  });
});