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
 *  2. /mcp — X-Gateway-S2S, then the gateway credential 401 gate, BEFORE
 *     delegating to the MCP handler
 *  3. 404 JSON with the endpoint list
 *
 * HTTP startup refuses to listen when CONDUIT_S2S_SECRET is empty or a known
 * placeholder, unless MCP_ALLOW_INSECURE_DEV=1 (empty secret only). That
 * bypass forces the listener onto 127.0.0.1. A configured secret honors
 * MCP_HTTP_HOST and defaults to 127.0.0.1 when the host is unset. The secret
 * is read at startup, not at module load, and is never written to logs.
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
  runWithGatewayCredentials,
} from "./mcp-server.js";
import { logger } from "./utils/logger.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

const LOOPBACK_HOST = "127.0.0.1";

/**
 * Public example values. A copied placeholder must not verify as a real
 * secret, including when MCP_ALLOW_INSECURE_DEV=1 is also set.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

export interface HttpLayer {
  httpServer: NodeHttpServer;
  /** Close the MCP handler, then the HTTP server. */
  close(): Promise<void>;
}

export interface HttpLayerOptions {
  gatewayMode: boolean;
  /**
   * Service-to-service secret captured at startup. Empty only for the
   * insecure-dev bypass and for tests that construct the layer directly.
   * Production listens through `startHttpTransport`, which refuses to start
   * when this would be empty.
   */
  s2sSecret?: string;
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function credentialHeader(value: string | string[] | undefined): string | undefined {
  const trimmed = firstHeader(value)?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Fail closed: an empty or known-placeholder CONDUIT_S2S_SECRET used to skip
 * X-Gateway-S2S checks. Refuse to listen unless the operator explicitly opts
 * into insecure local dev — and even then, only for a truly empty secret.
 * Never include the secret value in the log.
 */
export function resolveHttpListen(): { secret: string; host: string } {
  const raw = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  const placeholder = raw.length > 0 && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase());

  if (placeholder) {
    logger.error(
      "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
        "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value. " +
        "MCP_ALLOW_INSECURE_DEV does not accept a placeholder."
    );
    process.exit(1);
  }

  const configuredHost = (process.env.MCP_HTTP_HOST ?? "").trim();

  if (raw) {
    return { secret: raw, host: configuredHost || LOOPBACK_HOST };
  }

  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") {
    if (configuredHost && !isLoopbackBindHost(configuredHost)) {
      logger.error(
        `WARNING: MCP_HTTP_HOST=${configuredHost} is not a loopback address. ` +
          "MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. " +
          `Binding ${LOOPBACK_HOST} only.`
      );
    }
    logger.error(
      "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
        `HTTP /mcp is not enforcing X-Gateway-S2S and listens on ${LOOPBACK_HOST} only. ` +
        "Do not use this outside local development."
    );
    return { secret: "", host: LOOPBACK_HOST };
  }

  logger.error(
    "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
      "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
      "or set MCP_ALLOW_INSECURE_DEV=1 for local development only."
  );
  process.exit(1);
}

/**
 * Build the HTTP layer (without listening) so both `startHttpTransport` and
 * the protocol tests can run the real routing + MCP serving stack.
 */
export function createHttpLayer(options: HttpLayerOptions): HttpLayer {
  const { gatewayMode } = options;
  const s2sSecret = options.s2sSecret ?? "";

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
      // Conduit service-to-service auth (gateway#377 parity): rejected
      // BEFORE any credential extraction. Empty s2sSecret is only reachable
      // when MCP_ALLOW_INSECURE_DEV=1; startup refuses otherwise.
      if (s2sSecret && !verifyS2sHeader(firstHeader(req.headers[S2S_HEADER]), s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
          })
        );
        return;
      }

      if (gatewayMode) {
        const { creds, error } = resolveGatewayCredentials((name) =>
          credentialHeader(req.headers[name])
        );
        if (error || !creds) {
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
                message:
                  "Unauthorized: missing required gateway credential header X-ScalePad-Api-Key. Optional headers: X-ScalePad-Region, X-Quoter-Client-Id, X-Quoter-Client-Secret.",
              },
              id: null,
            })
          );
          return;
        }

        await runWithGatewayCredentials(creds, () =>
          handleMcpRequest(req as unknown as Parameters<typeof handleMcpRequest>[0], res)
        );
        return;
      }

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

/**
 * Listen for HTTP MCP. Refuses to start without a real CONDUIT_S2S_SECRET
 * unless MCP_ALLOW_INSECURE_DEV=1, which forces 127.0.0.1.
 */
export async function startHttpTransport(): Promise<HttpLayer> {
  const { secret, host } = resolveHttpListen();
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const gatewayMode = process.env.AUTH_MODE === "gateway";
  const layer = createHttpLayer({ gatewayMode, s2sSecret: secret });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      reject(err);
    };
    layer.httpServer.once("error", onError);
    layer.httpServer.listen(port, host, () => {
      layer.httpServer.removeListener("error", onError);
      const bound = layer.httpServer.address();
      const where =
        typeof bound === "object" && bound ? `${bound.address}:${bound.port}` : `${host}:${port}`;
      logger.info(`ScalePad MCP server listening on http://${where}/mcp`);
      logger.info(`Health check available at http://${where}/health`);
      logger.info(
        `Authentication mode: ${gatewayMode ? "gateway (header-based)" : "env (environment variables)"}`
      );
      resolve();
    });
  });

  return layer;
}
