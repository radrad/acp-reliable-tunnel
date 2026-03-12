import { ConsoleLogger, type Logger } from "../logger.js";
import type { DataFrame, FrameTransport, JsonRpcMessage } from "./types.js";

type MessageHandler = (message: JsonRpcMessage) => void;
type CloseHandler = (error?: Error) => void;

export class ReliableMessageChannel {
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private readonly outbound = new Map<number, DataFrame>();
  private transport: FrameTransport | null = null;
  private nextSeq = 1;
  private highestReceivedSeq = 0;
  private writeQueue = Promise.resolve();
  private cleanupTransportListeners: Array<() => void> = [];
  private readonly logger: Logger;

  constructor(scope: string, logger?: Logger) {
    this.logger = logger ?? new ConsoleLogger(scope);
  }

  get receiveWatermark(): number {
    return this.highestReceivedSeq;
  }

  attachTransport(transport: FrameTransport, peerAck: number): void {
    this.detachTransport();
    this.transport = transport;
    this.pruneAcked(peerAck);

    this.cleanupTransportListeners.push(
      transport.onFrame((frame) => {
        try {
          if (frame.type === "data") {
            this.pruneAcked(frame.ack);
            this.handleData(frame);
            return;
          }

          if (frame.type === "ack") {
            this.pruneAcked(frame.ack);
            return;
          }

          if (frame.type === "close") {
            this.handleClose(new Error(`Peer closed channel: ${frame.code} ${frame.reason}`));
          }
        } catch (error) {
          this.handleClose(error instanceof Error ? error : new Error(String(error)));
        }
      }),
      transport.onClose((error) => {
        this.detachTransport();
        this.handleClose(error);
      }),
    );

    for (const frame of this.outbound.values()) {
      this.queueFrame(frame);
    }

    this.queueAck();
  }

  detachTransport(): void {
    for (const cleanup of this.cleanupTransportListeners.splice(0)) {
      cleanup();
    }

    this.transport = null;
  }

  send(message: JsonRpcMessage): Promise<void> {
    const frame: DataFrame = {
      type: "data",
      seq: this.nextSeq++,
      ack: this.highestReceivedSeq,
      payload: message,
    };

    this.outbound.set(frame.seq, frame);
    return this.queueFrame(frame);
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  private handleData(frame: DataFrame): void {
    if (frame.seq <= this.highestReceivedSeq) {
      this.queueAck();
      return;
    }

    if (frame.seq !== this.highestReceivedSeq + 1) {
      throw new Error(
        `Out-of-order frame detected. Expected ${this.highestReceivedSeq + 1}, got ${frame.seq}.`,
      );
    }

    this.highestReceivedSeq = frame.seq;
    for (const handler of this.messageHandlers) {
      handler(frame.payload);
    }

    this.queueAck();
  }

  private pruneAcked(ack: number): void {
    for (const seq of [...this.outbound.keys()]) {
      if (seq <= ack) {
        this.outbound.delete(seq);
      }
    }
  }

  private queueAck(): void {
    if (!this.transport) {
      return;
    }

    this.writeQueue = this.writeQueue
      .then(async () => {
        if (!this.transport) {
          return;
        }

        await this.transport.send({ type: "ack", ack: this.highestReceivedSeq });
      })
      .catch((error) => {
        this.logger.warn("Failed to send ACK.", error);
      });
  }

  private queueFrame(frame: DataFrame): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(async () => {
        if (!this.transport) {
          return;
        }

        await this.transport.send(frame);
      })
      .catch((error) => {
        this.logger.warn("Failed to send frame.", error);
      });

    return this.writeQueue;
  }

  private handleClose(error?: Error): void {
    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}