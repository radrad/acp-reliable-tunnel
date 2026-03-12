import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { ConsoleLogger, type Logger } from "../logger.js";
import type { TunnelClientConfig } from "../config.js";
import { ReliableMessageChannel } from "../reliable/channel.js";
import { WebSocketFrameTransport } from "../reliable/websocket-transport.js";
import type { HelloFrame, JsonRpcMessage, WelcomeFrame } from "../reliable/types.js";
import type { CloseHandler, JsonRpcPeer, MessageHandler } from "./jsonrpc-peer.js";
import { createTlsClientOptions } from "./tls.js";

function resolveHelloAuth(config: TunnelClientConfig): HelloFrame["auth"] {
  if (config.auth.mode === "shared-secret") {
    return {
      type: "shared_secret",
      secret: config.auth.secret,
    };
  }

  const token = config.auth.token ?? process.env[config.auth.tokenEnv ?? ""];
  if (!token) {
    throw new Error("JWT auth is configured but no token value is available.");
  }

  return {
    type: "bearer",
    token,
  };
}

export class TunnelClientConnection implements JsonRpcPeer {
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private readonly channel: ReliableMessageChannel;
  private readonly logger: Logger;
  private readonly reconnectConfig: TunnelClientConfig["reconnect"];
  private stopped = false;
  private tunnelId: string | undefined;
  private activeSocket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private currentDelayMs: number;

  constructor(private readonly config: TunnelClientConfig, logger?: Logger) {
    this.logger = logger ?? new ConsoleLogger("client");
    this.channel = new ReliableMessageChannel("client-channel", this.logger);
    this.reconnectConfig = config.reconnect;
    this.currentDelayMs = this.reconnectConfig.initialDelayMs;

    this.channel.onMessage((message) => {
      for (const handler of this.messageHandlers) {
        handler(message);
      }
    });

    this.channel.onClose((error) => {
      if (!this.stopped) {
        this.logger.warn("Reliable channel detached; reconnecting.", error);
      }
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (!this.tunnelId && this.config.tunnelId) {
      this.tunnelId = this.config.tunnelId;
    }

    await this.connect();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    await this.channel.send(message);
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  getTunnelId(): string | undefined {
    return this.tunnelId;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.channel.detachTransport();

    if (this.activeSocket) {
      this.activeSocket.removeAllListeners();
      await new Promise<void>((resolve) => {
        this.activeSocket?.once("close", () => resolve());
        this.activeSocket?.close();
      });
      this.activeSocket = null;
    }
  }

  private async connect(): Promise<void> {
    const socket = new WebSocket(
      this.config.serverUrl,
      createTlsClientOptions(this.config.tls)
    );
    this.activeSocket = socket;

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error));
    });

    const hello: HelloFrame = {
      type: "hello",
      auth: resolveHelloAuth(this.config),
      peerAck: this.channel.receiveWatermark,
      ...(this.tunnelId ? { tunnelId: this.tunnelId } : {}),
      ...(this.config.metadata.clientLabel
        ? { metadata: { clientLabel: this.config.metadata.clientLabel } }
        : {}),
    };

    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(hello), (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    const welcome = await new Promise<WelcomeFrame>((resolve, reject) => {
      const onMessage = (payload: WebSocket.RawData) => {
        try {
          const frame = JSON.parse(payload.toString()) as WelcomeFrame;
          if (frame.type !== "welcome") {
            reject(new Error(`Expected welcome frame, received ${frame.type}.`));
            return;
          }

          resolve(frame);
        } catch (error) {
          reject(error);
        }
      };

      socket.once("message", onMessage);
      socket.once("close", () => reject(new Error("Socket closed before welcome frame.")));
      socket.once("error", (error) => reject(error));
    });

    this.tunnelId = welcome.tunnelId ?? randomUUID();
    this.currentDelayMs = this.reconnectConfig.initialDelayMs;
    if (welcome.identity) {
      this.logger.info(
        `Authenticated tunnel as ${welcome.identity.subject} via ${welcome.identity.authType}.`,
      );
    }

    const transport = new WebSocketFrameTransport(socket, "client-ws", this.logger);
    this.channel.attachTransport(transport, welcome.peerAck);

    socket.on("close", () => {
      this.channel.detachTransport();
      this.activeSocket = null;

      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    socket.on("error", (error) => {
      this.logger.warn("Client socket error.", error);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => {
        this.logger.warn("Reconnect attempt failed.", error);
        this.currentDelayMs = Math.min(this.currentDelayMs * 2, this.reconnectConfig.maxDelayMs);
        this.scheduleReconnect();
      });
    }, this.currentDelayMs);
  }
}