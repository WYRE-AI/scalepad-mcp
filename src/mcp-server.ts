/**
 * Shared MCP server factory for ScalePad.
 *
 * This module is **side-effect free** (importing it never starts a transport),
 * so it can be reused by every entrypoint:
 * - `index.ts` — stdio serving
 * - `http.ts`  — Node HTTP serving
 *
 * The server uses the flat posture (v2 fleet standard): ALL tools are exposed
 * upfront in tools/list for universal client compatibility. scalepad_navigate
 * is a discovery aid, not a gate.
 */

import { Server } from "@modelcontextprotocol/server";
import type { McpServerFactory, Tool } from "@modelcontextprotocol/server";
import { getAvailableDomains, getDomainHandler } from "./domains/index.js";
import {
  getNavigationTools,
  handleNavigationCall,
  isNavigationTool,
} from "./domains/navigation.js";
import {
  isValidRegion,
  getBaseUrlForRegion,
  type DomainName,
  type CallToolResult,
} from "./utils/types.js";
import {
  createClientDirect,
  runWithRequestClient,
  type ScalePadCredentials,
} from "./utils/client.js";
import { logger } from "./utils/logger.js";
import { bindServerRef } from "./utils/server-ref.js";

export type { ScalePadCredentials };

export const SERVER_NAME = "scalepad-mcp";
export const SERVER_VERSION = "1.0.0";

/** Tool-name prefix → product domain, per the ScalePad API map. */
const PREFIX_TO_DOMAIN: ReadonlyArray<readonly [string, DomainName]> = [
  ["scalepad_core_", "core"],
  ["scalepad_lm_", "lifecycle-manager"],
  ["scalepad_cm_", "controlmap"],
  ["scalepad_br_", "backup-radar"],
  ["scalepad_quoter_", "quoter"],
];

/**
 * The tool set is static and credential-independent, but a fresh server is
 * built per HTTP request — assemble the domain tools once at module scope.
 */
let cachedDomainTools: Tool[] | undefined;
async function getAllDomainTools(): Promise<Tool[]> {
  if (cachedDomainTools) return cachedDomainTools;
  const allTools: Tool[] = [];
  for (const domain of getAvailableDomains()) {
    const handler = await getDomainHandler(domain);
    allTools.push(...handler.getTools());
  }
  cachedDomainTools = allTools;
  return allTools;
}

/**
 * Build a validated ScalePadCredentials object from raw values.
 * Returns `{ creds }` on success or `{ error }` when the API key is missing.
 * Shared by every transport (env vars and gateway headers).
 */
export function buildCredentials(
  apiKey: string | undefined,
  region: string | undefined,
  quoterClientId: string | undefined,
  quoterClientSecret: string | undefined
): { creds?: ScalePadCredentials; error?: string } {
  if (!apiKey) {
    return {
      error:
        "Missing credentials: X-ScalePad-Api-Key header (or SCALEPAD_API_KEY environment variable)",
    };
  }

  const regionVal = region?.toLowerCase() || "us";
  const validRegion = isValidRegion(regionVal) ? regionVal : "us";
  return {
    creds: {
      apiKey,
      region: validRegion,
      baseUrl: getBaseUrlForRegion(validRegion),
      quoterClientId,
      quoterClientSecret,
    },
  };
}

/**
 * Resolve per-request gateway credentials from a header accessor.
 *
 * Works with any transport: pass a getter that returns a (lowercased) header
 * value. Returns `{ creds }` on success, or `{ error }` when the required
 * X-ScalePad-Api-Key header is missing.
 */
export function resolveGatewayCredentials(
  getHeader: (lowerName: string) => string | undefined
): { creds?: ScalePadCredentials; error?: string } {
  return buildCredentials(
    getHeader("x-scalepad-api-key"),
    getHeader("x-scalepad-region"),
    getHeader("x-quoter-client-id"),
    getHeader("x-quoter-client-secret")
  );
}

/**
 * Bind `createMcpServer` into the `McpServerFactory` shape the v2 HTTP serving
 * entry (`createMcpHandler`) consumes. The factory runs once per HTTP request
 * — the fresh-instance-per-request stateless idiom — for BOTH protocol eras
 * (legacy 2025 traffic and modern 2026-07-28 envelope traffic).
 *
 * In gateway mode the request's X-ScalePad-* / X-Quoter-* headers are read
 * from `ctx.requestInfo`, keeping credentials bound per request. Missing
 * headers are answered 401 by the HTTP layer before serving ever starts; if a
 * request slips through without them, tools/call reports the credential error
 * in-band.
 */
export function makeMcpServerFactory(options: {
  gatewayMode: boolean;
  envCredentials?: ScalePadCredentials;
}): McpServerFactory {
  return (ctx) => {
    if (options.gatewayMode) {
      const { creds } = resolveGatewayCredentials(
        (name) => ctx.requestInfo?.headers.get(name) ?? undefined
      );
      return createMcpServer(creds);
    }
    return createMcpServer(options.envCredentials);
  };
}

/**
 * Create a fresh MCP server instance with all handlers registered.
 * Called once for stdio, or per-request for HTTP serving.
 *
 * @param credentialOverrides - Optional credentials for gateway mode. When
 *   provided, a per-request client is created from these credentials instead
 *   of reading from process.env. Never mutate process.env or shared state
 *   with per-request credentials (cross-tenant leak).
 */
export function createMcpServer(
  credentialOverrides?: ScalePadCredentials
): Server {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );
  bindServerRef(server);

  server.setRequestHandler("tools/list", async () => {
    // Flat posture: every tool is exposed upfront.
    return { tools: [...getNavigationTools(), ...(await getAllDomainTools())] };
  });

  server.setRequestHandler("tools/call", async (request, extra) => {
    const { name, arguments: args } = request.params;
    logger.info("Tool call received", { tool: name });

    const dispatch = async (): Promise<CallToolResult> => {
      try {
        const toolArgs = (args ?? {}) as Record<string, unknown>;

        if (isNavigationTool(name)) {
          return await handleNavigationCall(name, toolArgs);
        }

        // Dispatch by tool-name prefix. Calls are accepted for any domain
        // regardless of navigation state — navigation only shapes tools/list.
        for (const [prefix, domain] of PREFIX_TO_DOMAIN) {
          if (name.startsWith(prefix)) {
            const handler = await getDomainHandler(domain);
            return await handler.handleCall(name, toolArgs, extra);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}. Use scalepad_navigate to discover available tools by domain.`,
            },
          ],
          isError: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        logger.error("Tool call failed", { tool: name, error: message, stack });
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    };

    // Gateway mode: bind this request's client + credentials to an
    // AsyncLocalStorage context for the lifetime of `dispatch()` — including
    // every await inside it — so a concurrent request can never observe or
    // clobber this one's client/credentials (see the SECURITY note in
    // utils/client.ts). No explicit cleanup needed: the context falls out of
    // scope when `dispatch()` settles, unlike the old set-then-clear-in-
    // finally dance around a shared module-level override.
    if (credentialOverrides) {
      const directClient = await createClientDirect(credentialOverrides);
      return runWithRequestClient(directClient, credentialOverrides, dispatch);
    }

    return dispatch();
  });

  return server;
}
