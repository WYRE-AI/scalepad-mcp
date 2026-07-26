/**
 * Flat navigation for the ScalePad MCP server.
 *
 * All tools are exposed upfront in tools/list (the v2 fleet posture — no
 * per-process navigation state, which would be shared across tenants under
 * stateless per-request HTTP serving). `scalepad_navigate` is a discovery
 * aid that describes a product domain's tools; `scalepad_status` reports
 * credential status and available domains.
 */

import type { Tool } from "@modelcontextprotocol/server";
import type { CallToolResult, DomainName } from "../utils/types.js";
import { isDomainName } from "../utils/types.js";
import { getAvailableDomains, getDomainHandler } from "./index.js";
import { getCredentials } from "../utils/client.js";
import { logger } from "../utils/logger.js";

/**
 * Per-domain descriptions, distilled from the ScalePad API map
 * (developer.scalepad.com).
 */
export const domainDescriptions: Record<DomainName, string> = {
  core:
    "ScalePad Core - unified platform data (read-only, US-only): clients, contacts, members, sites, opportunities, hardware/SaaS assets, product catalog, service contracts, tickets, and integrations",
  "lifecycle-manager":
    "Lifecycle Manager - engagement and roadmap workflows: initiatives, goals, meetings, action items, assessments, deliverables, budgets, contracts, and workspace",
  controlmap:
    "ControlMap - compliance management per client: risks, controls, evidence, policies, frameworks, assessments, and action items (regions: us, eu, ca, au)",
  "backup-radar":
    "Backup Radar - read-only backup health and backup device inventory per client (regions: us, eu)",
  quoter:
    "Quoter - quotes, catalog items/groups, contacts, suppliers, and OAuth helpers for the standalone api.quoter.com path (defaults to the ScalePad-hosted Quoter API)",
};

const navigateTool: Tool = {
  name: "scalepad_navigate",
  description:
    "Discover available ScalePad tools by product domain. Returns tool names and descriptions for the selected domain. All tools are callable at any time — this is a help/discovery aid, not a prerequisite. One ScalePad API key covers every product; endpoints for products without an active subscription return 402.",
  inputSchema: {
    type: "object" as const,
    properties: {
      domain: {
        type: "string",
        enum: getAvailableDomains(),
        description: `The product domain to explore:
- core: ${domainDescriptions.core}
- lifecycle-manager: ${domainDescriptions["lifecycle-manager"]}
- controlmap: ${domainDescriptions.controlmap}
- backup-radar: ${domainDescriptions["backup-radar"]}
- quoter: ${domainDescriptions.quoter}`,
      },
    },
    required: ["domain"],
  },
};

const statusTool: Tool = {
  name: "scalepad_status",
  description:
    "Show ScalePad API credential status and available product domains",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

/**
 * The always-visible navigation tools.
 */
export function getNavigationTools(): Tool[] {
  return [navigateTool, statusTool];
}

export function isNavigationTool(name: string): boolean {
  return ["scalepad_navigate", "scalepad_status"].includes(name);
}

/**
 * Handle a navigation tool call. Purely informational — no state changes.
 */
export async function handleNavigationCall(
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  if (name === "scalepad_navigate") {
    const domain = args.domain;
    if (typeof domain !== "string" || !isDomainName(domain)) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid domain: ${String(domain)}. Available domains: ${getAvailableDomains().join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    const handler = await getDomainHandler(domain);
    logger.debug("Domain discovery", { domain });

    const toolSummary = handler
      .getTools()
      .map((t) => `- ${t.name}: ${t.description}`)
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `${domainDescriptions[domain]}\n\nAvailable tools:\n${toolSummary}`,
        },
      ],
    };
  }

  if (name === "scalepad_status") {
    const creds = getCredentials();
    const credStatus = creds
      ? `Configured (region: ${creds.region}, base URL: ${creds.baseUrl})`
      : "NOT CONFIGURED - set SCALEPAD_API_KEY (or send X-ScalePad-Api-Key in gateway mode)";
    const quoterStatus = creds?.quoterClientId
      ? "Configured (standalone api.quoter.com OAuth available)"
      : "Not configured (Quoter tools use the ScalePad-hosted path with the ScalePad key)";

    return {
      content: [
        {
          type: "text",
          text: [
            "ScalePad MCP Server Status",
            "",
            `Credentials: ${credStatus}`,
            `Quoter OAuth: ${quoterStatus}`,
            `Available domains: ${getAvailableDomains().join(", ")}`,
            "",
            "All tools are exposed upfront; use scalepad_navigate to explore a product domain's tools.",
          ].join("\n"),
        },
      ],
      // Fleet contract (mcp-assert): status reports an error state when the
      // server has no credentials, so monitors can detect a DOWN vendor.
      ...(creds ? {} : { isError: true }),
    };
  }

  return {
    content: [{ type: "text", text: `Unknown navigation tool: ${name}` }],
    isError: true,
  };
}
