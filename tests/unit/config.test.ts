import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadClientConfig,
  loadServerConfig,
} from "../../src/config.js";
import {
  createTlsClientOptions,
  createTlsServerOptions,
} from "../../src/tunnel/tls.js";

const TEST_PEM = "test certificate fixture\n";
const TEST_KEY = "test private key fixture\n";

async function createPemDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "acp-tunnel-config-"));
  await writeFile(join(dir, "server.crt"), TEST_PEM, "utf8");
  await writeFile(join(dir, "server.key"), TEST_KEY, "utf8");
  await writeFile(join(dir, "ca.crt"), TEST_PEM, "utf8");
  await writeFile(join(dir, "client.crt"), TEST_PEM, "utf8");
  await writeFile(join(dir, "client.key"), TEST_KEY, "utf8");
  return dir;
}

async function writeJsonFile(contents: unknown): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "acp-tunnel-json-"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(contents, null, 2), "utf8");
  return { dir, path };
}

describe("config loading", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("parses documented server TLS fields", async () => {
    const pemDir = await createPemDir();
    tempDirs.push(pemDir);
    const configFile = await writeJsonFile({
      listen: { host: "127.0.0.1", port: 9019, path: "/acp" },
      auth: { mode: "shared-secret", secret: "secret" },
      tls: {
        certPath: join(pemDir, "server.crt"),
        keyPath: join(pemDir, "server.key"),
        caPath: join(pemDir, "ca.crt"),
        requestCert: true,
        rejectUnauthorizedClients: true,
      },
      agent: { command: "mock", args: [], env: {} },
    });
    tempDirs.push(configFile.dir);

    const config = loadServerConfig(configFile.path);

    expect(config.tls).toEqual({
      certPath: join(pemDir, "server.crt"),
      keyPath: join(pemDir, "server.key"),
      caPath: join(pemDir, "ca.crt"),
      requestCert: true,
      rejectUnauthorizedClients: true,
    });
    expect(createTlsServerOptions(config.tls)?.requestCert).toBe(true);
    expect(createTlsServerOptions(config.tls)?.rejectUnauthorized).toBe(true);
  });

  it("accepts legacy server TLS aliases for compatibility", async () => {
    const pemDir = await createPemDir();
    tempDirs.push(pemDir);
    const configFile = await writeJsonFile({
      listen: { host: "127.0.0.1", port: 9019, path: "/acp" },
      auth: { mode: "shared-secret", secret: "secret" },
      tls: {
        certPath: join(pemDir, "server.crt"),
        keyPath: join(pemDir, "server.key"),
        requestClientCert: true,
        rejectUnauthorized: true,
      },
      agent: { command: "mock", args: [], env: {} },
    });
    tempDirs.push(configFile.dir);

    const config = loadServerConfig(configFile.path);

    expect(config.tls?.requestCert).toBe(true);
    expect(config.tls?.rejectUnauthorizedClients).toBe(true);
  });

  it("parses documented client TLS fields", async () => {
    const pemDir = await createPemDir();
    tempDirs.push(pemDir);
    const configFile = await writeJsonFile({
      serverUrl: "wss://example.test/acp",
      auth: { mode: "shared-secret", secret: "secret" },
      tls: {
        caPath: join(pemDir, "ca.crt"),
        certPath: join(pemDir, "client.crt"),
        keyPath: join(pemDir, "client.key"),
        serverName: "example.test",
        rejectUnauthorized: true,
      },
    });
    tempDirs.push(configFile.dir);

    const config = loadClientConfig(configFile.path);
    const tlsOptions = createTlsClientOptions(config.tls);

    expect(config.tls).toEqual({
      caPath: join(pemDir, "ca.crt"),
      certPath: join(pemDir, "client.crt"),
      keyPath: join(pemDir, "client.key"),
      serverName: "example.test",
      rejectUnauthorized: true,
    });
    expect(tlsOptions.servername).toBe("example.test");
    expect(tlsOptions.rejectUnauthorized).toBe(true);
  });

  it("accepts legacy client TLS servername alias for compatibility", async () => {
    const configFile = await writeJsonFile({
      serverUrl: "wss://example.test/acp",
      auth: { mode: "shared-secret", secret: "secret" },
      tls: {
        servername: "example.test",
        rejectUnauthorized: false,
      },
    });
    tempDirs.push(configFile.dir);

    const config = loadClientConfig(configFile.path);

    expect(config.tls).toEqual({
      serverName: "example.test",
      rejectUnauthorized: false,
    });
  });
});