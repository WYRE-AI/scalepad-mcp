/**
 * Tests for the ScalePad MCP HTTP layer.
 *
 * Runs the REAL routing + dual-era MCP serving stack (src/http.ts) on an
 * ephemeral port and exercises:
 *  - /health (shallow, unauthenticated — both auth modes)
 *  - the gateway 401 gate on /mcp (before any MCP delegation)
 *  - dual-era tools/list: legacy 2025-era JSON-RPC POSTs (decoded via the
 *    SSE-aware mcpJson helper) and a modern @modelcontextprotocol/client.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHttpLayer, type HttpLayer } from "../http.js";
import { mcpJson } from "./helpers.js";

const NAV_TOOL_NAMES = ["scalepad_navigate", "scalepad_status"];

const LEGACY_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function listen(layer: HttpLayer): Promise<number> {
  return new Promise<number>((resolve) => {
    layer.httpServer.listen(0, "127.0.0.1", () => {
      const addr = layer.httpServer.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

type JsonRpcResponse = {
  result?: {
    protocolVersion?: string;
    serverInfo?: { name?: string };
    capabilities?: Record<string, unknown>;
    tools?: Array<{ name: string }>;
  };
};

describe("HTTP layer (env mode)", () => {
  let layer: HttpLayer;
  let base: string;

  beforeAll(async () => {
    layer = createHttpLayer({ gatewayMode: false });
    const port = await listen(layer);
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await layer.close();
  });

  it("serves /health with status ok and env authMode", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.name).toBe("scalepad-mcp");
    expect(body.authMode).toBe("env");
  });

  it("returns 404 with the endpoint list for unknown paths", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.endpoints).toEqual(["/mcp", "/health"]);
  });

  it("answers a legacy 2025-era initialize with the scalepad-mcp identity", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: LEGACY_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "vitest-legacy", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const init = (await mcpJson(res)) as JsonRpcResponse;
    expect(typeof init.result?.protocolVersion).toBe("string");
    expect(init.result?.serverInfo?.name).toBe("scalepad-mcp");
    expect(init.result?.capabilities).toBeTypeOf("object");
  });

  it("legacy tools/list exposes the full flat tool surface", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: LEGACY_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
    const list = (await mcpJson(res)) as JsonRpcResponse;
    const names = (list.result?.tools ?? []).map((t) => t.name);
    // Flat posture: navigation tools plus every product-domain tool upfront.
    for (const nav of NAV_TOOL_NAMES) expect(names).toContain(nav);
    for (const domainTool of [
      "scalepad_core_clients_list",
      "scalepad_lm_initiatives_list",
      "scalepad_cm_health_list",
      "scalepad_br_backups_list_health",
      "scalepad_quoter_quotes_list",
    ]) {
      expect(names).toContain(domainTool);
    }
    expect(names.length).toBeGreaterThan(300);
    expect(new Set(names).size).toBe(names.length);
  });

  it("modern client tools/list matches the legacy era's tool names", async () => {
    const legacyRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: LEGACY_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    const legacyList = (await mcpJson(legacyRes)) as JsonRpcResponse;
    const legacyNames = (legacyList.result?.tools ?? []).map((t) => t.name).sort();

    const client = new Client({ name: "vitest-modern", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(legacyNames);
    } finally {
      await client.close();
    }
  });
});

describe("HTTP layer (gateway mode 401 gate)", () => {
  let layer: HttpLayer;
  let base: string;

  beforeAll(async () => {
    layer = createHttpLayer({ gatewayMode: true });
    const port = await listen(layer);
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await layer.close();
  });

  it("returns a 401 JSON-RPC error when X-ScalePad-Api-Key is missing", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: LEGACY_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      jsonrpc?: string;
      error?: { code?: number; message?: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.message).toContain("X-ScalePad-Api-Key");
  });

  it("serves the request when X-ScalePad-Api-Key is present", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        ...LEGACY_HEADERS,
        "X-ScalePad-Api-Key": "test-key",
        "X-ScalePad-Region": "eu",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "vitest-gateway", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const init = (await mcpJson(res)) as JsonRpcResponse;
    expect(init.result?.serverInfo?.name).toBe("scalepad-mcp");
  });

  it("still serves /health without credentials in gateway mode", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.authMode).toBe("gateway");
  });
});
