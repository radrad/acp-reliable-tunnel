export {
	loadClientConfig,
	loadServerConfig,
	type TunnelClientConfig,
	type TunnelServerConfig,
	type TunnelClientAuthConfig,
	type TunnelServerAuthConfig,
} from "./config.js";
export { ReliableAcpTunnelServer, type AgentPeerFactory } from "./tunnel/server.js";
export { TunnelClientConnection } from "./tunnel/client-connection.js";
export { AgentProcessPeer } from "./tunnel/agent-process.js";
export { NdjsonPeer } from "./tunnel/ndjson-peer.js";
export { ReliableMessageChannel } from "./reliable/channel.js";
export { authenticateTunnelClient, TunnelAuthenticationError, type AuthenticatedIdentity } from "./tunnel/auth.js";
export { createTlsClientOptions, createTlsServerOptions } from "./tunnel/tls.js";
export { createMockAgentPeer } from "./test-support/mock-agent.js";