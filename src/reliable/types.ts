export type JsonRpcMessage = Record<string, unknown>;

export type SharedSecretHelloAuth = {
  type: "shared_secret";
  secret: string;
};

export type BearerHelloAuth = {
  type: "bearer";
  token: string;
};

export type HelloAuth = SharedSecretHelloAuth | BearerHelloAuth;

export type HelloFrame = {
  type: "hello";
  tunnelId?: string;
  auth: HelloAuth;
  peerAck: number;
  metadata?: {
    clientLabel?: string;
  };
};

export type WelcomeFrame = {
  type: "welcome";
  tunnelId: string;
  peerAck: number;
  identity?: {
    subject: string;
    issuer?: string;
    authType: "shared-secret" | "jwt";
  };
};

export type DataFrame = {
  type: "data";
  seq: number;
  ack: number;
  payload: JsonRpcMessage;
};

export type AckFrame = {
  type: "ack";
  ack: number;
};

export type CloseFrame = {
  type: "close";
  code: string;
  reason: string;
};

export type TunnelFrame = HelloFrame | WelcomeFrame | DataFrame | AckFrame | CloseFrame;

export interface FrameTransport {
  send(frame: TunnelFrame): Promise<void>;
  onFrame(handler: (frame: TunnelFrame) => void): () => void;
  onClose(handler: (error?: Error) => void): () => void;
  close(code?: number, reason?: string): Promise<void>;
}