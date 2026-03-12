import path from "node:path";

const tunnelRoot = path.resolve(
  "C:/Playground/acp-reliable-tunnel"
);

export const remoteClaudeAgent = {
  id: "claude-remote",
  name: "Claude Remote over Reliable ACP Tunnel",
  command: "node",
  args: [
    path.join(tunnelRoot, "dist/bin/stdio-client.js"),
    "--config",
    path.join(tunnelRoot, "configs/client.example.json"),
  ],
};