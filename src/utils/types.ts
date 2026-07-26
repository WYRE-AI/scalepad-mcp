/**
 * Shared types for the ScalePad MCP server
 */
import type { Tool } from "@modelcontextprotocol/server";

/**
 * Tool call result type - inline literal-typed definition per the v2 SDK
 * (do NOT widen `type` to `string`).
 */
export type CallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Domain handler interface — implemented by every src/domains/<slug>.ts as
 * `export const handler: DomainHandler`.
 */
export interface DomainHandler {
  /** Get the tools for this domain */
  getTools(): Tool[];
  /** Handle a tool call. `extra` is the per-request server context the v2 SDK
   * passes to request handlers; handlers that don't need it may omit it. */
  handleCall(
    toolName: string,
    args: Record<string, unknown>,
    extra?: unknown
  ): Promise<CallToolResult>;
}

/**
 * Domain names (product slugs) for ScalePad
 */
export type DomainName =
  | "core"
  | "lifecycle-manager"
  | "controlmap"
  | "backup-radar"
  | "quoter";

/**
 * Check if a string is a valid domain name
 */
export function isDomainName(value: string): value is DomainName {
  return ["core", "lifecycle-manager", "controlmap", "backup-radar", "quoter"].includes(value);
}

/**
 * ScalePad data-residency region.
 * Regional base URLs apply to ControlMap (us/eu/ca/au) and Backup Radar
 * (us/eu); Core and Lifecycle Manager are US-only — the SDK routes per
 * product from the configured region.
 */
export type ScalePadRegion = "us" | "eu" | "ca" | "au";

/**
 * Check if a string is a valid ScalePad region
 */
export function isValidRegion(value: string): value is ScalePadRegion {
  return ["us", "eu", "ca", "au"].includes(value);
}

/**
 * Get the base URL for a ScalePad region
 */
export function getBaseUrlForRegion(region: ScalePadRegion): string {
  switch (region) {
    case "eu":
      return "https://eu.api.scalepad.com";
    case "ca":
      return "https://ca.api.scalepad.com";
    case "au":
      return "https://au.api.scalepad.com";
    case "us":
    default:
      return "https://api.scalepad.com";
  }
}
