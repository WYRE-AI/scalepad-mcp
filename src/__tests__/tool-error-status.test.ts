/**
 * Verifies the tools/call path reports a domain handler's ScalePadError as
 * `Error (HTTP <status>): ...` (via formatToolError) rather than `Error: <message>`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ScalePadError } from "@wyre-technology/node-scalepad";
import { mcpJson } from "./helpers.js";

vi.mock("../domains/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../domains/index.js")>();
  return {
    ...actual,
    getDomainHandler: vi.fn(async (domain: Parameters<typeof actual.getDomainHandler>[0]) => {
      const real = await actual.getDomainHandler(domain);
      if (domain !== "core") return real;
      return {
        ...real,
        handleCall: async () => {
          throw new ScalePadError("HTTP 422", 422, { message: "page_size must be <= 200" });
        },
      };
    }),
  };
});

import { createHttpLayer, type HttpLayer } from "../http.js";

describe("tools/call error formatting", () => {
  let layer: HttpLayer;
  let base: string;

  beforeAll(async () => {
    layer = createHttpLayer({ gatewayMode: false });
    base = await new Promise<string>((resolve) => {
      layer.httpServer.listen(0, "127.0.0.1", () => {
        const addr = layer.httpServer.address();
        resolve(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
      });
    });
  });

  afterAll(async () => {
    await layer.close();
  });

  it("returns the HTTP status and vendor message for a handler ScalePadError", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "scalepad_core_clients_list", arguments: {} },
      }),
    });
    const body = (await mcpJson(res)) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
    };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toBe("Error (HTTP 422): page_size must be <= 200");
  });
});
