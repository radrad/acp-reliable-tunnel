import { loadServerConfig, parseConfigPathFromArgv } from "../config.js";
import { ConsoleLogger } from "../logger.js";
import { ReliableAcpTunnelServer } from "../tunnel/server.js";

const configPath = parseConfigPathFromArgv(process.argv.slice(2));
const config = loadServerConfig(configPath);
const logger = new ConsoleLogger("server-bin");
const server = new ReliableAcpTunnelServer(config, undefined, logger);

await server.start();
logger.info(`ACP tunnel server listening at ${server.getUrl()}`);