/**
 * HTTP layer for the ScalePad MCP server.
 *
 * One `createMcpHandler` (with `legacy: 'stateless'`) serves BOTH protocol
 * eras from the same `/mcp` endpoint: 2025-era clients (classic `initialize`
 * handshake) are answered statelessly per request, modern 2026-07-28 envelope
 * clients natively. Never use `legacy: 'reject'` here — it would turn away
 * every pre-envelope client.
 *
 * Routing order (invariant):
 *  1. /health, /healthz — shallow, unauthenticated liveness probe
 *  2. /mcp — gateway 401 gate BEFORE delegating to the MCP handler
 *  3. 404 JSON with the endpoint list
 */

import {
  createServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  SERVER_NAME,
  makeMcpServerFactory,
  resolveGatewayCredentials,
} from "./mcp-server.js";
import { logger } from "./utils/logger.js";

export interface HttpLayer {
  httpServer: NodeHttpServer;
  /** Close the MCP handler, then the HTTP server. */
  close(): Promise<void>;
}

/**
 * Build the HTTP layer (without listening) so both `index.ts` and the test
 * suite can run the real routing + MCP serving stack.
 */
export function createHttpLayer(options: { gatewayMode: boolean }): HttpLayer {
  const { gatewayMode } = options;

  const mcpHandler = createMcpHandler(makeMcpServerFactory({ gatewayMode }), {
    legacy: "stateless",
    onerror: (error) => logger.error("MCP serving error", { error: error.message }),
  });
  const handleMcpRequest = toNodeHandler(mcpHandler, {
    onerror: (error) => logger.error("MCP request adapter error", { error: error.message }),
  });

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health endpoint - shallow, unauthenticated liveness probe.
    // Must NOT call getCredentials() or any upstream: in gateway mode
    // credentials only arrive per-request via headers, so a credential
    // check here would always 503 and crash-loop the container.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          name: SERVER_NAME,
          transport: "http",
          authMode: gatewayMode ? "gateway" : "env",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      if (gatewayMode) {
        const { error } = resolveGatewayCredentials((name) => {
          const value = req.headers[name];
          return Array.isArray(value) ? value[0] : value;
        });
        if (error) {
          // Reject explicitly BEFORE delegating. Falling through to the
          // env-configured handlers would serve the server operator's tenant
          // data to whoever sent the unauthenticated request — a cross-tenant
          // leak.
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32001,
                message: `Unauthorized: ${error}. Required header: X-ScalePad-Api-Key. Optional headers: X-ScalePad-Region, X-Quoter-Client-Id, X-Quoter-Client-Secret.`,
              },
              id: null,
            })
          );
          return;
        }
      }

      // Per-request credential binding happens inside the factory (it reads
      // the gateway headers from ctx.requestInfo on every request).
      // Cast: the adapter's duck-typed NodeIncomingMessageLike declares
      // `method?: string`, which node:http's IncomingMessage doesn't satisfy
      // under exactOptionalPropertyTypes (v2.0.0-beta.5 typings papercut).
      await handleMcpRequest(req as unknown as Parameters<typeof handleMcpRequest>[0], res);
      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  return {
    httpServer,
    close: async () => {
      await mcpHandler.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
