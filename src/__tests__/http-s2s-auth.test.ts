/**
 * HTTP transport fail-closed auth (CWE-306).
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholders are refused even with that flag. The flag forces the
 * listener onto 127.0.0.1. /mcp rejects a missing or invalid X-Gateway-S2S
 * header. AUTH_MODE=gateway rejects requests that omit vendor credential
 * headers and must not fall back to SCALEPAD_* in process.env.
 */

import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpJson } from "./helpers.js";

const getCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock("../utils/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/client.js")>();
  return {
    ...actual,
    getCredentials: () => {
      const creds = actual.getCredentials();
      getCredentialsMock(creds);
      return creds;
    },
  };
});

import { startHttpTransport, type HttpLayer } from "../http.js";

const S2S_SECRET = "s2s-do-not-log-7f3a";
const ENV_API_KEY = "env-key-must-not-be-used";

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "SCALEPAD_API_KEY",
  "SCALEPAD_REGION",
  "QUOTER_CLIENT_ID",
  "QUOTER_CLIENT_SECRET",
  "LOG_LEVEL",
  "MCP_TRANSPORT",
] as const;

const savedEnv = new Map<string, string | undefined>();
const layers: HttpLayer[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });
  return {
    text: () => lines.join("\n"),
    restore: () => spy.mockRestore(),
  };
}

function exitSpy() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

interface HttpResult {
  status: number;
  body: string;
  contentType: string;
}

function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return fetch(`http://127.0.0.1:${options.port}${options.path}`, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  }).then(async (res) => ({
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get("content-type") ?? "",
  }));
}

async function readMcp(result: HttpResult): Promise<unknown> {
  return mcpJson(
    new Response(result.body, {
      status: result.status,
      headers: { "content-type": result.contentType },
    })
  );
}

async function listen(): Promise<{ port: number; address: string; layer: HttpLayer }> {
  const layer = await startHttpTransport();
  layers.push(layer);
  const bound = layer.httpServer.address() as AddressInfo | null;
  if (!bound || typeof bound === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return { port: bound.port, address: bound.address, layer };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

const statusCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "scalepad_status", arguments: {} },
});

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "error";
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.SCALEPAD_API_KEY;
  delete process.env.SCALEPAD_REGION;
  delete process.env.QUOTER_CLIENT_ID;
  delete process.env.QUOTER_CLIENT_SECRET;
  getCredentialsMock.mockClear();
});

afterEach(async () => {
  while (layers.length > 0) {
    const layer = layers.pop();
    if (!layer) continue;
    await layer.close();
  }
});

describe("HTTP startup", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is empty", async () => {
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exit).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).toContain("CONDUIT_S2S_SECRET is empty");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it("treats a whitespace secret as empty", async () => {
    process.env.CONDUIT_S2S_SECRET = "   ";
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(logs.text()).toContain("CONDUIT_S2S_SECRET is empty");
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(logs.text()).toContain("Refusing to start HTTP transport");
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it.each(["changeme", "your-s2s-secret", "replace-with-a-real-secret", "  Your-S2S-Secret  "])(
    "refuses known placeholder %j and does not log it",
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      delete process.env.MCP_ALLOW_INSECURE_DEV;
      const logs = captureStderr();
      const exit = exitSpy();
      try {
        await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
        expect(exit).toHaveBeenCalledWith(1);
        const text = logs.text();
        expect(text).toContain("known placeholder");
        expect(text).toContain("openssl rand -hex 32");
        expect(text).not.toContain(placeholder.trim());
        expect(text).not.toContain(S2S_SECRET);
      } finally {
        exit.mockRestore();
        logs.restore();
      }
    }
  );

  it("refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.CONDUIT_S2S_SECRET = "  Your-S2S-Secret  ";
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.text()).toContain("known placeholder");
      expect(logs.text()).not.toContain("Your-S2S-Secret");
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it("allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("127.0.0.1");
      const text = logs.text();
      expect(text).toContain("SECURITY WARNING");
      expect(text).toContain("CONDUIT_S2S_SECRET");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV");
      expect(text).toContain("127.0.0.1");
      expect(text).not.toContain("not a loopback address");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it("forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is not loopback", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    const exit = exitSpy();
    try {
      const server = await listen();
      expect(exit).not.toHaveBeenCalled();
      expect(server.address).toBe("127.0.0.1");
      const text = logs.text();
      expect(text).toContain("MCP_HTTP_HOST=0.0.0.0 is not a loopback address");
      expect(text).toContain("Binding 127.0.0.1 only");
      expect(text).toContain("SECURITY WARNING");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it("forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is localhost", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "localhost";
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("127.0.0.1");
      expect(logs.text()).toContain("SECURITY WARNING");
      expect(logs.text()).not.toContain("not a loopback address");
    } finally {
      logs.restore();
    }
  });

  it("still binds a non-loopback host when CONDUIT_S2S_SECRET is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("0.0.0.0");
      expect(logs.text()).not.toContain("not a loopback address");
      expect(logs.text()).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it("binds 127.0.0.1 when MCP_HTTP_HOST is unset and a secret is set", async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    expect(server.address).toBe("127.0.0.1");
  });
});

describe("HTTP /mcp authentication", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.SCALEPAD_API_KEY = ENV_API_KEY;
    process.env.SCALEPAD_REGION = "us";
  });

  it("returns 401 when the S2S header is missing or invalid and does not log the secret", async () => {
    const logs = captureStderr();
    const server = await listen();
    try {
      const missing = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({ "x-scalepad-api-key": "header-key" }),
        body: statusCall,
      });
      const invalid = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader("wrong-secret"),
          "x-scalepad-api-key": "header-key",
        }),
        body: statusCall,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain("X-Gateway-S2S");
      expect(invalid.body).toContain("X-Gateway-S2S");
      expect(missing.body).not.toContain(S2S_SECRET);
      expect(invalid.body).not.toContain(S2S_SECRET);
      expect(missing.body).not.toContain(ENV_API_KEY);
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(getCredentialsMock).not.toHaveBeenCalled();
    } finally {
      logs.restore();
    }
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
      body: statusCall,
    });

    expect(response.status).toBe(401);
    expect(response.body).toContain("missing required gateway credential header");
    expect(response.body).toContain("X-ScalePad-Api-Key");
    expect(response.body).not.toContain(ENV_API_KEY);
    expect(response.body).not.toContain(S2S_SECRET);
    expect(response.body).not.toContain("region: us");
    expect(getCredentialsMock).not.toHaveBeenCalled();

    const partial = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-scalepad-region": "eu",
      }),
      body: statusCall,
    });
    expect(partial.status).toBe(401);
    expect(getCredentialsMock).not.toHaveBeenCalled();
  });

  it("accepts a valid S2S header plus credential headers and uses those credentials", async () => {
    const logs = captureStderr();
    const server = await listen();
    try {
      const response = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          "x-scalepad-api-key": "header-api-key",
          "x-scalepad-region": "eu",
        }),
        body: statusCall,
      });

      expect(response.status).toBe(200);
      expect(response.body).not.toContain(S2S_SECRET);
      expect(response.body).not.toContain(ENV_API_KEY);
      const payload = (await readMcp(response)) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = payload.result?.content?.[0]?.text ?? response.body;
      expect(text).toContain("region: eu");
      expect(text).toContain("https://eu.api.scalepad.com");
      expect(text).not.toContain("region: us");
      expect(text).not.toContain(ENV_API_KEY);
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(logs.text()).not.toContain(ENV_API_KEY);
      const seen = getCredentialsMock.mock.calls.map((call) => call[0] as { region?: string; apiKey?: string });
      expect(seen.some((creds) => creds?.region === "eu" && creds.apiKey === "header-api-key")).toBe(true);
      expect(seen.some((creds) => creds?.apiKey === ENV_API_KEY)).toBe(false);
    } finally {
      logs.restore();
    }
  });

  it("serves /health and /healthz without authentication and without reading credentials", async () => {
    const server = await listen();
    for (const path of ["/health", "/healthz"]) {
      const response = await sendHttp({
        port: server.port,
        method: "GET",
        path,
      });
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body) as { status?: string; authMode?: string };
      expect(body.status).toBe("ok");
      expect(body.authMode).toBe("gateway");
      expect(response.body).not.toContain(S2S_SECRET);
      expect(response.body).not.toContain(ENV_API_KEY);
    }
    expect(getCredentialsMock).not.toHaveBeenCalled();
  });

  it("requires S2S in env mode and does not apply it to /health", async () => {
    process.env.AUTH_MODE = "env";
    const server = await listen();
    const missing = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "vitest-env", version: "0.0.0" },
        },
      }),
    });
    expect(missing.status).toBe(401);
    expect(missing.body).toContain("X-Gateway-S2S");

    const health = await sendHttp({ port: server.port, method: "GET", path: "/health" });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).authMode).toBe("env");
  });
});
