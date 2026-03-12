import type { Writable } from "node:stream";
import { ConsoleLogger, type Logger } from "../logger.js";
import type { JsonRpcMessage } from "../reliable/types.js";
import type { CloseHandler, JsonRpcPeer, MessageHandler } from "./jsonrpc-peer.js";

export class NdjsonPeer implements JsonRpcPeer {
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private readonly logger: Logger;
  private buffer = "";

  constructor(
    readable: NodeJS.ReadableStream,
    private readonly writable: Writable,
    scope: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? new ConsoleLogger(scope);

    readable.setEncoding("utf8");
    readable.on("data", (chunk: string) => this.handleChunk(chunk));
    readable.on("close", () => this.emitClose());
    readable.on("end", () => this.emitClose());
    readable.on("error", (error) => this.emitClose(error instanceof Error ? error : new Error(String(error))));
  }

  send(message: JsonRpcMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.writable.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async close(): Promise<void> {
    this.writable.end();
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const message = JSON.parse(trimmed) as JsonRpcMessage;
        for (const handler of this.messageHandlers) {
          handler(message);
        }
      } catch (error) {
        this.logger.warn("Failed to parse NDJSON message.", { line: trimmed, error });
      }
    }
  }

  private emitClose(error?: Error): void {
    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}