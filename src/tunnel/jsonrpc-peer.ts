import type { JsonRpcMessage } from "../reliable/types.js";

export type MessageHandler = (message: JsonRpcMessage) => void;
export type CloseHandler = (error?: Error) => void;

export interface JsonRpcPeer {
  send(message: JsonRpcMessage): Promise<void>;
  onMessage(handler: MessageHandler): () => void;
  onClose(handler: CloseHandler): () => void;
  close(): Promise<void>;
}

export function bridgePeers(left: JsonRpcPeer, right: JsonRpcPeer): () => Promise<void> {
  const cleanups = [
    left.onMessage((message) => {
      void right.send(message);
    }),
    right.onMessage((message) => {
      void left.send(message);
    }),
  ];

  return async () => {
    for (const cleanup of cleanups) {
      cleanup();
    }

    await Promise.allSettled([left.close(), right.close()]);
  };
}