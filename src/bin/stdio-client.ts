import { loadClientConfig, parseConfigPathFromArgv } from "../config.js";
import { ConsoleLogger } from "../logger.js";
import { TunnelClientConnection } from "../tunnel/client-connection.js";
import { NdjsonPeer } from "../tunnel/ndjson-peer.js";

const configPath = parseConfigPathFromArgv(process.argv.slice(2));
const config = loadClientConfig(configPath);
const logger = new ConsoleLogger("stdio-client");

const localPeer = new NdjsonPeer(process.stdin, process.stdout, "local-stdio", logger);
const remotePeer = new TunnelClientConnection(config, logger);

await remotePeer.start();

localPeer.onMessage((message) => {
  void remotePeer.send(message);
});

remotePeer.onMessage((message) => {
  void localPeer.send(message);
});

const shutdown = async (): Promise<void> => {
  await remotePeer.close();
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});