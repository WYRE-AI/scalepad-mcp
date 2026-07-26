/**
 * Domain handlers index
 *
 * Lazy-loads domain handlers (one per ScalePad product) to avoid loading
 * everything upfront. Each src/domains/<slug>.ts exports
 * `export const handler: DomainHandler`.
 */

import type { DomainHandler, DomainName } from "../utils/types.js";

// Cache for loaded domain handlers
const domainCache = new Map<DomainName, DomainHandler>();

/**
 * Lazy-load a domain handler
 */
export async function getDomainHandler(
  domain: DomainName
): Promise<DomainHandler> {
  // Check cache first
  const cached = domainCache.get(domain);
  if (cached) {
    return cached;
  }

  // Dynamically import the domain handler
  let handler: DomainHandler;

  switch (domain) {
    case "core": {
      const { handler: coreHandler } = await import("./core.js");
      handler = coreHandler;
      break;
    }
    case "lifecycle-manager": {
      const { handler: lifecycleManagerHandler } = await import("./lifecycle-manager.js");
      handler = lifecycleManagerHandler;
      break;
    }
    case "controlmap": {
      const { handler: controlmapHandler } = await import("./controlmap.js");
      handler = controlmapHandler;
      break;
    }
    case "backup-radar": {
      const { handler: backupRadarHandler } = await import("./backup-radar.js");
      handler = backupRadarHandler;
      break;
    }
    case "quoter": {
      const { handler: quoterHandler } = await import("./quoter.js");
      handler = quoterHandler;
      break;
    }
    default:
      throw new Error(`Unknown domain: ${domain}`);
  }

  // Cache the handler
  domainCache.set(domain, handler);
  return handler;
}

/**
 * Get all available domain names
 */
export function getAvailableDomains(): DomainName[] {
  return ["core", "lifecycle-manager", "controlmap", "backup-radar", "quoter"];
}

/**
 * Clear the domain cache (useful for testing)
 */
export function clearDomainCache(): void {
  domainCache.clear();
}
