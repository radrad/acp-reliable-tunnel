import {
  AgentSideConnection,
  RequestError,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type AgentSideConnection as AgentConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { PassThrough, Readable, Writable } from "node:stream";
import type { JsonRpcPeer } from "../tunnel/jsonrpc-peer.js";
import { NdjsonPeer } from "../tunnel/ndjson-peer.js";

type SessionState = {
  id: string;
  turn: number;
};

class MockAgent implements Agent {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly client: AgentConnection) {}

  async initialize(_request: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { embeddedContext: true, image: false },
      },
      authMethods: [],
      agentInfo: {
        name: "mock-remote-agent",
        version: "0.1.0",
        title: "Mock Remote Agent",
      },
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    const id = randomUUID();
    this.sessions.set(id, { id, turn: 0 });
    return {
      sessionId: id,
      modes: {
        currentModeId: "default",
        availableModes: [{ id: "default", name: "Default" }],
      },
      models: {
        currentModelId: "mock-model",
        availableModels: [{ modelId: "mock-model", name: "Mock Model" }],
      },
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.resourceNotFound(params.sessionId);
    }

    session.turn += 1;
    const promptText = params.prompt
      .flatMap((content) => (content.type === "text" ? [content.text] : []))
      .join(" ");

    await this.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `session:${session.id} turn:${session.turn} ` },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 40));

    await this.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: `analyze:${promptText}`, priority: "high", status: "completed" },
          { content: `reply:${session.turn}`, priority: "medium", status: "completed" },
        ],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 40));

    await this.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `echo:${promptText}` },
      },
    });

    return { stopReason: "end_turn" };
  }

  async cancel(_params: CancelNotification): Promise<void> {}
}

export function createMockAgentPeer(): JsonRpcPeer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  const stream = ndJsonStream(
    Writable.toWeb(stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(stdin) as ReadableStream<Uint8Array>,
  );

  new AgentSideConnection((client) => new MockAgent(client), stream);

  return new NdjsonPeer(stdout, stdin, "mock-agent");
}