import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ConsoleLogger, type Logger } from "../logger.js";
import type { AgentLaunchConfig } from "../config.js";
import type { JsonRpcPeer } from "./jsonrpc-peer.js";
import { NdjsonPeer } from "./ndjson-peer.js";

export class AgentProcessPeer implements JsonRpcPeer {
  private readonly peer: NdjsonPeer;
  private readonly logger: Logger;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    scope: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? new ConsoleLogger(scope);
    this.peer = new NdjsonPeer(child.stdout, child.stdin, scope, this.logger);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.logger.info("Agent stderr.", chunk.trim());
    });
  }

  static async launch(config: AgentLaunchConfig, scope: string, logger?: Logger): Promise<AgentProcessPeer> {
    const child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    return new AgentProcessPeer(child, scope, logger);
  }

  send(message: Record<string, unknown>): Promise<void> {
    return this.peer.send(message);
  }

  onMessage(handler: Parameters<NdjsonPeer["onMessage"]>[0]): ReturnType<NdjsonPeer["onMessage"]> {
    return this.peer.onMessage(handler);
  }

  onClose(handler: Parameters<NdjsonPeer["onClose"]>[0]): ReturnType<NdjsonPeer["onClose"]> {
    return this.peer.onClose(handler);
  }

  async close(): Promise<void> {
    this.child.kill();
    await this.peer.close();
  }
}