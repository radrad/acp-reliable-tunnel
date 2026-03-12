import { randomUUID } from "node:crypto";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import WebSocket, { WebSocketServer } from "ws";
import { ConsoleLogger, type Logger } from "../logger.js";
import type { AgentLaunchConfig, TunnelServerConfig } from "../config.js";
import { ReliableMessageChannel } from "../reliable/channel.js";
import { WebSocketFrameTransport } from "../reliable/websocket-transport.js";
import type { FrameTransport, HelloFrame, JsonRpcMessage, WelcomeFrame } from "../reliable/types.js";
import { AgentProcessPeer } from "./agent-process.js";
import { authenticateTunnelClient, TunnelAuthenticationError, type AuthenticatedIdentity } from "./auth.js";
import type { JsonRpcPeer } from "./jsonrpc-peer.js";
import { createTlsServerOptions } from "./tls.js";

export type AgentPeerFactory = (config: AgentLaunchConfig, scope: string, logger: Logger) => Promise<JsonRpcPeer>;

type TunnelSession = {
  id: string;
  owner: AuthenticatedIdentity;
  channel: ReliableMessageChannel;
  agentPeer: JsonRpcPeer;
  closeAgentTimer: NodeJS.Timeout | null;
  transport: FrameTransport | null;
};

export class ReliableAcpTunnelServer {
  private readonly logger: Logger;
  private readonly server: WebSocketServer;
  private readonly httpsServer: HttpsServer | null;
  private readonly sessions = new Map<string, TunnelSession>();

  constructor(
    private readonly config: TunnelServerConfig,
    private readonly createAgentPeer: AgentPeerFactory = (agentConfig, scope, logger) =>
      AgentProcessPeer.launch(agentConfig, scope, logger),
    logger?: Logger,
  ) {
    this.logger = logger ?? new ConsoleLogger("server");
    const tlsOptions = createTlsServerOptions(config.tls);
    this.httpsServer = tlsOptions ? createHttpsServer(tlsOptions) : null;
    this.server = this.httpsServer
      ? new WebSocketServer({ server: this.httpsServer, path: config.listen.path })
      : new WebSocketServer({
          host: config.listen.host,
          port: config.listen.port,
          path: config.listen.path,
        });
  }

  async start(): Promise<void> {
    this.server.on("connection", (socket) => {
      void this.handleSocket(socket);
    });

    if (this.httpsServer) {
      await new Promise<void>((resolve) => {
        this.httpsServer!.listen(
          this.config.listen.port,
          this.config.listen.host,
          () => resolve()
        );
      });
      return;
    }

    await new Promise<void>((resolve) => {
      this.server.once("listening", () => resolve());
    });
  }

  getUrl(): string {
    const address = this.httpsServer ? this.httpsServer.address() : this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server address is not available.");
    }

    const host = address.address === "::" ? "127.0.0.1" : address.address;
    const scheme = this.httpsServer ? "wss" : "ws";
    return `${scheme}://${host}:${address.port}${this.config.listen.path}`;
  }

  async forceDisconnectTunnel(tunnelId: string): Promise<void> {
    const session = this.sessions.get(tunnelId);
    if (!session?.transport) {
      return;
    }

    await session.transport.close(1012, "test disconnect");
    session.transport = null;
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.closeAgentTimer && clearTimeout(session.closeAgentTimer);
      await session.agentPeer.close();
      session.channel.detachTransport();
    }

    this.sessions.clear();

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        if (!this.httpsServer) {
          resolve();
          return;
        }

        this.httpsServer.close((httpsError) => {
          if (httpsError) {
            reject(httpsError);
            return;
          }

          resolve();
        });
      });
    });
  }

  private async handleSocket(socket: WebSocket): Promise<void> {
    const hello = await this.waitForHello(socket);
    let identity: AuthenticatedIdentity;
    try {
      identity = await authenticateTunnelClient(this.config.auth, hello.auth);
    } catch (error) {
      const reason =
        error instanceof TunnelAuthenticationError ? error.message : "authentication failed";
      socket.close(1008, reason);
      return;
    }

    const tunnelId = hello.tunnelId ?? randomUUID();
    const session = await this.getOrCreateSession(tunnelId, identity);

    if (session.owner.subject !== identity.subject || session.owner.authType !== identity.authType) {
      socket.close(1008, "tunnel ownership mismatch");
      return;
    }

    if (session.transport) {
      socket.close(1013, "tunnel already attached");
      return;
    }

    if (session.closeAgentTimer) {
      clearTimeout(session.closeAgentTimer);
      session.closeAgentTimer = null;
    }

    const welcome: WelcomeFrame = {
      type: "welcome",
      tunnelId,
      peerAck: session.channel.receiveWatermark,
      identity: {
        subject: session.owner.subject,
        authType: session.owner.authType,
        ...(session.owner.issuer ? { issuer: session.owner.issuer } : {}),
      },
    };

    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(welcome), (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    const transport = new WebSocketFrameTransport(socket, `server-ws:${tunnelId}`, this.logger);
    session.transport = transport;
    session.channel.attachTransport(transport, hello.peerAck);

    transport.onClose(() => {
      session.channel.detachTransport();
      session.transport = null;
      session.closeAgentTimer = setTimeout(() => {
        void this.destroySession(session.id);
      }, this.config.reconnectWindowMs);
    });
  }

  private async getOrCreateSession(
    tunnelId: string,
    identity: AuthenticatedIdentity,
  ): Promise<TunnelSession> {
    const existing = this.sessions.get(tunnelId);
    if (existing) {
      return existing;
    }

    const sessionLogger = new ConsoleLogger(`tunnel:${tunnelId}`);
    const channel = new ReliableMessageChannel(`server-channel:${tunnelId}`, sessionLogger);
    const agentPeer = await this.createAgentPeer(this.config.agent, `agent:${tunnelId}`, sessionLogger);
    const session: TunnelSession = {
      id: tunnelId,
      owner: identity,
      channel,
      agentPeer,
      closeAgentTimer: null,
      transport: null,
    };

    agentPeer.onMessage((message: JsonRpcMessage) => {
      void channel.send(message);
    });

    agentPeer.onClose((error) => {
      sessionLogger.warn("Agent peer closed.", error);
      void this.destroySession(tunnelId);
    });

    channel.onMessage((message) => {
      void agentPeer.send(message);
    });

    this.sessions.set(tunnelId, session);
    return session;
  }

  private async destroySession(tunnelId: string): Promise<void> {
    const session = this.sessions.get(tunnelId);
    if (!session) {
      return;
    }

    session.closeAgentTimer && clearTimeout(session.closeAgentTimer);
    session.channel.detachTransport();
    await session.agentPeer.close();
    this.sessions.delete(tunnelId);
  }

  private waitForHello(socket: WebSocket): Promise<HelloFrame> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for hello frame."));
      }, this.config.handshakeTimeoutMs);

      const cleanup = (): void => {
        clearTimeout(timeout);
        socket.removeAllListeners("message");
        socket.removeAllListeners("close");
        socket.removeAllListeners("error");
      };

      socket.once("message", (payload) => {
        cleanup();
        try {
          const frame = JSON.parse(payload.toString()) as HelloFrame;
          if (frame.type !== "hello") {
            reject(new Error(`Expected hello frame, received ${frame.type}.`));
            return;
          }

          resolve(frame);
        } catch (error) {
          reject(error);
        }
      });

      socket.once("close", () => {
        cleanup();
        reject(new Error("Socket closed before hello frame."));
      });

      socket.once("error", (error) => {
        cleanup();
        reject(error);
      });
    });
  }
}