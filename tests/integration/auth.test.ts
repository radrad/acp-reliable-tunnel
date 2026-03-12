import { SignJWT } from "jose";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TunnelServerConfig } from "../../src/config.js";
import { TunnelClientConnection } from "../../src/tunnel/client-connection.js";
import { ReliableAcpTunnelServer } from "../../src/tunnel/server.js";
import { createMockAgentPeer } from "../../src/test-support/mock-agent.js";

const jwtSecret = new TextEncoder().encode("integration-jwt-secret");

async function createJwt(subject: string, scopes: string[] = ["acp:tunnel"]): Promise<string> {
  return new SignJWT({ scope: scopes.join(" ") })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("https://issuer.example.test")
    .setAudience("acp-tunnel")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(jwtSecret);
}

describe("auth integration", () => {
  let server: ReliableAcpTunnelServer;

  beforeEach(async () => {
    const serverConfig: TunnelServerConfig = {
      listen: { host: "127.0.0.1", port: 0, path: "/acp" },
      auth: {
        mode: "jwt",
        issuer: "https://issuer.example.test",
        audience: "acp-tunnel",
        secret: "integration-jwt-secret",
        algorithms: ["HS256"],
        requiredScopes: ["acp:tunnel"],
        clockToleranceSec: 5,
      },
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

  it("rejects a client with an invalid bearer token", async () => {
    const remote = new TunnelClientConnection({
      serverUrl: server.getUrl(),
      auth: { mode: "jwt", token: "invalid-token" },
      reconnect: { initialDelayMs: 50, maxDelayMs: 100 },
      metadata: { clientLabel: "invalid-client" },
    });

    await expect(remote.start()).rejects.toThrow();
  });

  it("prevents a different subject from hijacking an existing tunnel id", async () => {
    const first = new TunnelClientConnection({
      serverUrl: server.getUrl(),
      auth: { mode: "jwt", token: await createJwt("alice") },
      reconnect: { initialDelayMs: 50, maxDelayMs: 100 },
      metadata: { clientLabel: "alice-client" },
    });

    await first.start();

    try {
      const socket = new WebSocket(server.getUrl());

      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", (error) => reject(error));
      });

      socket.send(
        JSON.stringify({
          type: "hello",
          tunnelId: first.getTunnelId(),
          auth: {
            type: "bearer",
            token: await createJwt("bob"),
          },
          peerAck: 0,
          metadata: { clientLabel: "bob-client" },
        }),
      );

      const close = await new Promise<{ code: number; reason: string }>((resolve) => {
        socket.once("close", (code, reason) => {
          resolve({ code, reason: reason.toString() });
        });
      });

      expect(close.code).toBe(1008);
      expect(close.reason).toContain("tunnel ownership mismatch");
    } finally {
      await first.close();
    }
  });
});