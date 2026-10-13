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
 *
 * Gateway mode never falls back to SCALEPAD_* env credentials.
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is a real secret
 * (empty and known placeholders are rejected). MCP_ALLOW_INSECURE_DEV=1 is a
 * local-only escape hatch for an empty secret: it logs a warning and forces
 * the listener onto 127.0.0.1. A configured secret honors MCP_HTTP_HOST,
 * which defaults to 127.0.0.1 when unset. /health and /healthz stay
 * unauthenticated and do not read credentials. stdio does not use S2S auth.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./mcp-server.js";
import { startHttpTransport } from "./http.js";
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
    const layer = await startHttpTransport();
    const shutdown = async () => {
      logger.info("Shutting down ScalePad MCP server...");
      await layer.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
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
