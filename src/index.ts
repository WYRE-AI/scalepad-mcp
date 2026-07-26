#!/usr/bin/env node
/**
 * ScalePad MCP Server (flat tool surface)
 *
 * Covers every public ScalePad product API behind one server: Core,
 * Lifecycle Manager, ControlMap, Backup Radar, and Quoter. All tools are
 * exposed upfront in tools/list; scalepad_navigate is a per-domain
 * discovery aid and scalepad_status reports credential status.
 *
 * Supports both stdio and HTTP transports:
 * - stdio (default): For local Claude Desktop / CLI usage
 * - http: For hosted deployment with optional gateway auth
 *
 * Both entrypoints serve dual protocol eras via the v2 SDK serving entries:
 * legacy 2025-era clients (classic `initialize` handshake) are served
 * statelessly per request, and modern 2026-07-28 envelope clients natively —
 * from the same server factory (`mcp-server.ts`).
 *
 * Credentials are provided via environment variables:
 * - SCALEPAD_API_KEY        (required — one key covers all products)
 * - SCALEPAD_REGION         (optional: us, eu, ca, au; default us)
 * - QUOTER_CLIENT_ID        (optional — standalone api.quoter.com OAuth only)
 * - QUOTER_CLIENT_SECRET    (optional — paired with QUOTER_CLIENT_ID)
 *
 * Or via gateway headers (when AUTH_MODE=gateway):
 * - X-ScalePad-Api-Key      (required)
 * - X-ScalePad-Region       (optional)
 * - X-Quoter-Client-Id      (optional)
 * - X-Quoter-Client-Secret  (optional)
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./mcp-server.js";
import { createHttpLayer } from "./http.js";
import { logger } from "./utils/logger.js";

/**
 * Start the server with stdio transport (default).
 * `serveStdio` owns the era decision: a 2025-era `initialize` pins the
 * connection legacy; modern envelope openings are served natively.
 */
function startStdioTransport(): void {
  serveStdio(() => createMcpServer(), {
    onerror: (error) => logger.error("stdio serving error", { error: error.message }),
  });
  logger.info("ScalePad MCP server running on stdio (decision-tree mode)");
}

/**
 * Start the server with HTTP serving via the shared HTTP layer.
 * The MCP handler is created once; its factory runs per request (stateless).
 */
async function startHttpTransport(): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = process.env.MCP_HTTP_HOST || "0.0.0.0";
  const isGatewayMode = process.env.AUTH_MODE === "gateway";

  const layer = createHttpLayer({ gatewayMode: isGatewayMode });

  await new Promise<void>((resolve) => {
    layer.httpServer.listen(port, host, () => {
      logger.info(`ScalePad MCP server listening on http://${host}:${port}/mcp`);
      logger.info(`Health check available at http://${host}:${port}/health`);
      logger.info(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`
      );
      resolve();
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down ScalePad MCP server...");
    await layer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Main entry point - select transport based on MCP_TRANSPORT env var
 */
async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";
  logger.info("Starting ScalePad MCP server", {
    transport: transportType,
    logLevel: process.env.LOG_LEVEL || "info",
    nodeVersion: process.version,
  });

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    startStdioTransport();
  }
}

main().catch((error) => {
  logger.error("Fatal startup error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
