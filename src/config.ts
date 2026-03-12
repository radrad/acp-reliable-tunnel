import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const agentConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
});

const tlsServerConfigSchema = z
  .object({
    certPath: z.string().min(1),
    keyPath: z.string().min(1),
    caPath: z.string().min(1).optional(),
    requestCert: z.boolean().optional(),
    requestClientCert: z.boolean().optional(),
    rejectUnauthorizedClients: z.boolean().optional(),
    rejectUnauthorized: z.boolean().optional(),
  })
  .transform((value) => ({
    certPath: value.certPath,
    keyPath: value.keyPath,
    ...(value.caPath ? { caPath: value.caPath } : {}),
    requestCert: value.requestCert ?? value.requestClientCert ?? false,
    rejectUnauthorizedClients:
      value.rejectUnauthorizedClients ?? value.rejectUnauthorized ?? false,
  }));

const tlsClientConfigSchema = z
  .object({
    caPath: z.string().min(1).optional(),
    certPath: z.string().min(1).optional(),
    keyPath: z.string().min(1).optional(),
    serverName: z.string().min(1).optional(),
    servername: z.string().min(1).optional(),
    rejectUnauthorized: z.boolean().default(true),
  })
  .transform((value) => ({
    ...(value.caPath ? { caPath: value.caPath } : {}),
    ...(value.certPath ? { certPath: value.certPath } : {}),
    ...(value.keyPath ? { keyPath: value.keyPath } : {}),
    ...(value.serverName ?? value.servername
      ? { serverName: value.serverName ?? value.servername }
      : {}),
    rejectUnauthorized: value.rejectUnauthorized,
  }));

const audienceSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);

const sharedSecretAuthSchema = z.object({
  mode: z.literal("shared-secret"),
  secret: z.string().min(1),
});

const jwtServerAuthSchema = z
  .object({
    mode: z.literal("jwt"),
    issuer: z.string().min(1),
    audience: audienceSchema,
    algorithms: z.array(z.string().min(1)).min(1).default(["RS256"]),
    jwksUrl: z.string().url().optional(),
    secret: z.string().min(1).optional(),
    requiredScopes: z.array(z.string().min(1)).default([]),
    clockToleranceSec: z.number().min(0).default(30),
  })
  .superRefine((value, context) => {
    const configured = Number(Boolean(value.jwksUrl)) + Number(Boolean(value.secret));
    if (configured !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JWT auth requires exactly one of jwksUrl or secret.",
      });
    }
  });

const jwtClientAuthSchema = z
  .object({
    mode: z.literal("jwt"),
    token: z.string().min(1).optional(),
    tokenEnv: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    const configured = Number(Boolean(value.token)) + Number(Boolean(value.tokenEnv));
    if (configured !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JWT client auth requires exactly one of token or tokenEnv.",
      });
    }
  });

const serverAuthSchema = z.union([sharedSecretAuthSchema, jwtServerAuthSchema]);
const clientAuthSchema = z.union([sharedSecretAuthSchema, jwtClientAuthSchema]);

const serverConfigSchema = z.object({
  listen: z.object({
    host: z.string().default("0.0.0.0"),
    port: z.number().int().min(0).max(65535).default(9019),
    path: z.string().default("/acp"),
  }),
  auth: serverAuthSchema,
  tls: tlsServerConfigSchema.optional(),
  reconnectWindowMs: z.number().int().min(1000).default(30000),
  handshakeTimeoutMs: z.number().int().min(1000).default(5000),
  agent: agentConfigSchema,
});

const reconnectConfigSchema = z.object({
  initialDelayMs: z.number().int().min(100).default(500),
  maxDelayMs: z.number().int().min(100).default(5000),
});

const clientConfigSchema = z.object({
  serverUrl: z.string().url(),
  auth: clientAuthSchema,
  tls: tlsClientConfigSchema.optional(),
  reconnect: reconnectConfigSchema.default(() => ({
    initialDelayMs: 500,
    maxDelayMs: 5000,
  })),
  tunnelId: z.string().optional(),
  metadata: z
    .object({
      clientLabel: z.string().optional(),
    })
    .default({}),
});

export type AgentLaunchConfig = z.infer<typeof agentConfigSchema>;
export type SharedSecretAuthConfig = z.infer<typeof sharedSecretAuthSchema>;
export type JwtServerAuthConfig = z.infer<typeof jwtServerAuthSchema>;
export type JwtClientAuthConfig = z.infer<typeof jwtClientAuthSchema>;
export type TunnelServerAuthConfig = z.infer<typeof serverAuthSchema>;
export type TunnelClientAuthConfig = z.infer<typeof clientAuthSchema>;
export type TunnelServerTlsConfig = z.infer<typeof tlsServerConfigSchema>;
export type TunnelClientTlsConfig = z.infer<typeof tlsClientConfigSchema>;
export type TunnelServerConfig = z.infer<typeof serverConfigSchema>;
export type TunnelClientConfig = z.infer<typeof clientConfigSchema>;

function loadJsonFile(filePath: string): unknown {
  const absolutePath = resolve(filePath);
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}

export function loadServerConfig(filePath: string): TunnelServerConfig {
  return serverConfigSchema.parse(loadJsonFile(filePath));
}

export function loadClientConfig(filePath: string): TunnelClientConfig {
  return clientConfigSchema.parse(loadJsonFile(filePath));
}

export function parseConfigPathFromArgv(argv: string[]): string {
  const index = argv.findIndex((value) => value === "--config");
  const configPath = index === -1 ? undefined : argv[index + 1];
  if (!configPath) {
    throw new Error("Missing required --config <path> argument.");
  }

  return configPath;
}