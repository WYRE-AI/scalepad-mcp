/**
 * Lazy-loaded ScalePad client
 *
 * This module provides lazy initialization of the ScalePad SDK client
 * (@wyre-technology/node-scalepad) to avoid loading the entire library
 * upfront. One ScalePad API key covers Core, Lifecycle Manager, ControlMap,
 * Backup Radar, and the hosted Quoter API; the optional Quoter OAuth pair is
 * only needed for the standalone api.quoter.com path.
 */

import type { ScalePadClient } from "@wyre-technology/node-scalepad";
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

/** Per-request client override — takes priority over the cached singleton */
let _clientOverride: ScalePadClient | null = null;

/** Per-request credential override — takes priority over env vars */
let _credentialOverrides: ScalePadCredentials | null = null;

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
 * Set a request-scoped client override.
 * While set, getClient() returns this instance instead of the cached one.
 */
export function setClientOverride(client: ScalePadClient): void {
  _clientOverride = client;
}

/**
 * Clear the request-scoped client override.
 */
export function clearClientOverride(): void {
  _clientOverride = null;
}

/**
 * Set request-scoped credential overrides.
 * While set, getCredentials() returns these instead of reading env vars.
 */
export function setCredentialOverrides(creds: ScalePadCredentials): void {
  _credentialOverrides = creds;
}

/**
 * Clear request-scoped credential overrides.
 */
export function clearCredentialOverrides(): void {
  _credentialOverrides = null;
}

/**
 * Get credentials from environment variables (or per-request overrides)
 */
export function getCredentials(): ScalePadCredentials | null {
  if (_credentialOverrides) {
    return _credentialOverrides;
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
  if (_clientOverride) {
    return _clientOverride;
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
