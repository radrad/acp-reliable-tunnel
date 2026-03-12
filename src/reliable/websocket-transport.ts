import WebSocket from "ws";
import { ConsoleLogger, type Logger } from "../logger.js";
import type { FrameTransport, TunnelFrame } from "./types.js";

type FrameHandler = (frame: TunnelFrame) => void;
type CloseHandler = (error?: Error) => void;

export class WebSocketFrameTransport implements FrameTransport {
  private readonly frameHandlers = new Set<FrameHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private readonly logger: Logger;

  constructor(private readonly socket: WebSocket, scope: string, logger?: Logger) {
    this.logger = logger ?? new ConsoleLogger(scope);

    socket.on("message", (payload) => {
      try {
        const frame = JSON.parse(payload.toString()) as TunnelFrame;
        for (const handler of this.frameHandlers) {
          handler(frame);
        }
      } catch (error) {
        const asError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn("Failed to parse WebSocket frame.", asError);
        for (const handler of this.closeHandlers) {
          handler(asError);
        }
      }
    });

    socket.on("close", () => {
      for (const handler of this.closeHandlers) {
        handler();
      }
    });

    socket.on("error", (error) => {
      for (const handler of this.closeHandlers) {
        handler(error);
      }
    });
  }

  send(frame: TunnelFrame): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(frame), (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  onFrame(handler: FrameHandler): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(code = 1000, reason = "normal"): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      this.socket.once("close", () => resolve());
      this.socket.close(code, reason);
    });
  }
}