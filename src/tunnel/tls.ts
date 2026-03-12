import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerOptions } from "node:https";
import type { ClientOptions } from "ws";
import type { TunnelClientTlsConfig, TunnelServerTlsConfig } from "../config.js";

function readPem(filePath: string): Buffer {
  return readFileSync(resolve(filePath));
}

export function createTlsServerOptions(config?: TunnelServerTlsConfig): ServerOptions | undefined {
  if (!config) {
    return undefined;
  }

  return {
    cert: readPem(config.certPath),
    key: readPem(config.keyPath),
    ...(config.caPath ? { ca: readPem(config.caPath) } : {}),
    requestCert: config.requestCert,
    rejectUnauthorized: config.rejectUnauthorizedClients,
  };
}

export function createTlsClientOptions(config?: TunnelClientTlsConfig): ClientOptions {
  if (!config) {
    return {};
  }

  return {
    ...(config.caPath ? { ca: readPem(config.caPath) } : {}),
    ...(config.certPath ? { cert: readPem(config.certPath) } : {}),
    ...(config.keyPath ? { key: readPem(config.keyPath) } : {}),
    ...(config.serverName ? { servername: config.serverName } : {}),
    rejectUnauthorized: config.rejectUnauthorized,
  };
}