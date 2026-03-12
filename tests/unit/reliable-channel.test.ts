import { describe, expect, it } from "vitest";
import { ReliableMessageChannel } from "../../src/reliable/channel.js";
import type { FrameTransport, TunnelFrame } from "../../src/reliable/types.js";

class FakeTransport implements FrameTransport {
  private frameHandler: ((frame: TunnelFrame) => void) | null = null;
  private closeHandler: ((error?: Error) => void) | null = null;
  private peer: FakeTransport | null = null;

  connect(peer: FakeTransport): void {
    this.peer = peer;
  }

  async send(frame: TunnelFrame): Promise<void> {
    this.peer?.frameHandler?.(frame);
  }

  onFrame(handler: (frame: TunnelFrame) => void): () => void {
    this.frameHandler = handler;
    return () => {
      this.frameHandler = null;
    };
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandler = handler;
    return () => {
      this.closeHandler = null;
    };
  }

  async close(): Promise<void> {
    this.closeHandler?.();
  }
}

describe("ReliableMessageChannel", () => {
  it("delivers messages once and ignores duplicates", async () => {
    const leftTransport = new FakeTransport();
    const rightTransport = new FakeTransport();
    leftTransport.connect(rightTransport);
    rightTransport.connect(leftTransport);

    const left = new ReliableMessageChannel("left");
    const right = new ReliableMessageChannel("right");
    const received: Array<Record<string, unknown>> = [];

    right.onMessage((message) => received.push(message));

    left.attachTransport(leftTransport, 0);
    right.attachTransport(rightTransport, 0);

    await left.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(received).toHaveLength(1);

    rightTransport.send({
      type: "data",
      seq: 1,
      ack: 0,
      payload: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });

    expect(received).toHaveLength(1);
  });
});