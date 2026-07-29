/**
 * Lazy-loaded ScalePad client
 *
 * This module provides lazy initialization of the ScalePad SDK client
 * (@wyre-technology/node-scalepad) to avoid loading the entire library
 * upfront. One ScalePad API key covers Core, Lifecycle Manager, ControlMap,
 * Backup Radar, and the hosted Quoter API; the optional Quoter OAuth pair is
 * only needed for the standalone api.quoter.com path.
 *
 * SECURITY (cross-tenant credential leak): per-request gateway credentials
 * used to be held in module-level `let _clientOverride` / `let
 * _credentialOverrides`, set synchronously by mcp-server.ts's tools/call
 * handler before an `await` (creating the direct client) and cleared in a
 * `finally` after the tool call resolved. In gateway (multi-tenant HTTP)
 * mode this raced: tenant A's request sets its overrides and suspends on
 * that await; before A resumes, tenant B's request runs — overwriting the
 * overrides with B's client/credentials — and its own `finally` clears them
 * back to null once B's call completes, all while A's tool call is still
 * in flight. A then reads back either B's client or no override at all
 * (falling through to a stale cached singleton or the operator's own env
 * credentials) instead of its own.
 *
 * Fixed by scoping per-request client + credentials to an
 * AsyncLocalStorage context (`runWithRequestClient`) instead of shared
 * mutable module state. The context is isolated per call to `.run()` and
 * needs no explicit clear — it simply falls out of scope when the wrapped
 * callback returns (or throws), so concurrent requests can never observe
 * or clobber each other's client/credentials.
 */

import type { ScalePadClient } from "@wyre-technology/node-scalepad";
import { AsyncLocalStorage } from "node:async_hooks";
import { isValidRegion, getBaseUrlForRegion, type ScalePadRegion } from "./types.js";
import { logger } from "./logger.js";

export interface ScalePadCredentials {
  apiKey: string;
  region: ScalePadRegion;
  baseUrl: string;
  quoterClientId?: string;
  quoterClientSecret?: string;
}

/**
 * Matches an unresolved MCPB/DXT config placeholder, e.g. "${user_config.scalepad_region}".
 * When an optional user_config field is left blank, Claude Desktop injects the literal
 * placeholder string (not empty, not omitted) into the env var. Treat it as unset.
 */
const CONFIG_PLACEHOLDER = /^\$\{.*\}$/;

let _client: ScalePadClient | null = null;
let _credentials: ScalePadCredentials | null = null;

interface RequestContext {
  client: ScalePadClient;
  credentials: ScalePadCredentials;
}

/**
 * Per-request client + credentials, isolated per gateway request. Takes
 * priority over the module-level singleton/env vars below whenever a
 * request is running inside `runWithRequestClient`.
 */
const requestContextStore = new AsyncLocalStorage<RequestContext>();

/** Read an env var, treating blanks and unresolved placeholders as unset. */
function readEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw || CONFIG_PLACEHOLDER.test(raw)) return undefined;
  return raw;
}

/**
 * Create a fresh ScalePadClient directly from credentials,
 * bypassing environment variables and the module-level cache.
 */
export async function createClientDirect(
  creds: ScalePadCredentials
): Promise<ScalePadClient> {
  const { ScalePadClient } = await import("@wyre-technology/node-scalepad");
  return new ScalePadClient({
    apiKey: creds.apiKey,
    region: creds.region,
    quoterClientId: creds.quoterClientId,
    quoterClientSecret: creds.quoterClientSecret,
  });
}

/**
 * Run `fn` with `client`/`credentials` bound to the async context for the
 * duration of that callback — including anything it `await`s or schedules.
 * Used by gateway (multi-tenant HTTP) mode, one call per request, so
 * concurrent requests can never observe or clobber each other's client or
 * credentials.
 */
export function runWithRequestClient<T>(
  client: ScalePadClient,
  credentials: ScalePadCredentials,
  fn: () => T
): T {
  return requestContextStore.run({ client, credentials }, fn);
}

/**
 * Get credentials from environment variables (or the per-request context)
 */
export function getCredentials(): ScalePadCredentials | null {
  const requestContext = requestContextStore.getStore();
  if (requestContext) {
    return requestContext.credentials;
  }

  const apiKey = readEnv("SCALEPAD_API_KEY");
  if (!apiKey) {
    logger.warn("Missing credentials", { hasApiKey: false });
    return null;
  }

  // Ignore a blank value or an unresolved MCPB config placeholder so an
  // optional, left-blank region falls back to "us" — mirroring the gateway
  // path that does `isValidRegion(x) ? x : "us"` instead of failing hard.
  const regionEnv = readEnv("SCALEPAD_REGION")?.toLowerCase() ?? "us";

  if (!isValidRegion(regionEnv)) {
    logger.warn("Invalid region configured, defaulting to us", {
      region: regionEnv,
      valid: ["us", "eu", "ca", "au"],
    });
  }

  const region = isValidRegion(regionEnv) ? regionEnv : "us";
  const baseUrl = getBaseUrlForRegion(region);

  return {
    apiKey,
    region,
    baseUrl,
    quoterClientId: readEnv("QUOTER_CLIENT_ID"),
    quoterClientSecret: readEnv("QUOTER_CLIENT_SECRET"),
  };
}

/**
 * Get or create the ScalePad client (lazy initialization).
 * The cached singleton is invalidated whenever any credential field changes.
 */
export async function getClient(): Promise<ScalePadClient> {
  const requestContext = requestContextStore.getStore();
  if (requestContext) {
    return requestContext.client;
  }

  const creds = getCredentials();

  if (!creds) {
    throw new Error(
      "No API credentials provided. Please configure SCALEPAD_API_KEY and optionally SCALEPAD_REGION (us, eu, ca, au), QUOTER_CLIENT_ID, and QUOTER_CLIENT_SECRET environment variables."
    );
  }

  // If credentials changed, invalidate the cached client
  if (
    _client &&
    _credentials &&
    (creds.apiKey !== _credentials.apiKey ||
      creds.region !== _credentials.region ||
      creds.quoterClientId !== _credentials.quoterClientId ||
      creds.quoterClientSecret !== _credentials.quoterClientSecret)
  ) {
    logger.info("Credentials changed, recreating client");
    _client = null;
  }

  if (!_client) {
    try {
      logger.info("Creating ScalePad client", { region: creds.region, baseUrl: creds.baseUrl });
      _client = await createClientDirect(creds);
      _credentials = creds;
    } catch (error) {
      logger.error("Failed to create ScalePad client", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  return _client;
}

/**
 * Clear the cached client (useful for testing)
 */
export function clearClient(): void {
  _client = null;
  _credentials = null;
}
