/**
 * Backup Radar domain handler
 *
 * Read-only v3 surface over backup health and backup device inventory per
 * client. Requires an active Backup Radar subscription (endpoints return 402
 * PAYMENT_REQUIRED otherwise). Backup Radar honors the ScalePad data-residency
 * region for us and eu.
 *
 * Tool naming: scalepad_br_<entity>_<operation>.
 */
import type { Tool } from "@modelcontextprotocol/server";
import type { ScalePadClient } from "@wyre-technology/node-scalepad";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { getClient } from "../utils/client.js";
import { logger } from "../utils/logger.js";
import { elicitText } from "../utils/elicitation.js";

interface ToolDef {
  tool: Tool;
  invoke: (
    client: ScalePadClient,
    args: Record<string, unknown>
  ) => Promise<unknown>;
}

/**
 * Pick defined args into an API params object, renaming keys
 * (tool arg name -> API query-parameter name).
 */
function params(
  args: Record<string, unknown>,
  map: Record<string, string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [argName, apiName] of Object.entries(map)) {
    if (args[argName] !== undefined) out[apiName] = args[argName];
  }
  return out;
}

const TOOLS: ToolDef[] = [
  {
    tool: {
      name: "scalepad_br_backups_list_health",
      description:
        "List all Backup Radar clients with their backup health rollups (healthy / warning / failed counts). Cursor-paginated: pass page_size (1-200, default 50) and the cursor returned by the previous page. history_days controls how many days of backup history feed the health rollup. Filterable by client name.",
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_client_name: {
            type: "string",
            description: "Filter results to clients whose name matches (filter[client.name])",
          },
          history_days: {
            type: "number",
            description: "Days of backup history to include in the health rollup",
          },
          sort: {
            type: "string",
            description: "Sort expression (field name, prefix with '-' for descending)",
          },
          page_size: {
            type: "number",
            description: "Results per page, 1-200 (default 50)",
          },
          cursor: {
            type: "string",
            description: "Opaque pagination cursor from the previous page",
          },
        },
      },
    },
    invoke: async (client, args) => {
      const p = params(args, {
        filter_client_name: "filter[client.name]",
        history_days: "history_days",
        sort: "sort",
        page_size: "page_size",
        cursor: "cursor",
      });
      // Zero-filter default: offer a client-name filter before listing everything.
      if (p["filter[client.name]"] === undefined) {
        try {
          const name = await elicitText(
            "No filters provided. Optionally enter a client name to filter backup health results (leave blank / cancel for all clients).",
            "client_name"
          );
          if (name) p["filter[client.name]"] = name;
        } catch {
          // Elicitation unsupported — proceed with the unfiltered list.
        }
      }
      return client.brBackups.listHealth(p as never);
    },
  },
  {
    tool: {
      name: "scalepad_br_backups_get_health",
      description:
        "Get backup health for a single Backup Radar client by client ID, including per-device backup status. history_days controls how many days of backup history feed the health rollup.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "Backup Radar client ID",
          },
          history_days: {
            type: "number",
            description: "Days of backup history to include in the health rollup",
          },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) =>
      client.brBackups.getHealth(
        args.id as string,
        params(args, { history_days: "history_days" }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_br_backups_list_devices",
      description:
        "List backup devices across Backup Radar clients. Cursor-paginated: pass page_size (1-200, default 50) and the cursor returned by the previous page. Filterable by device name or device ID; history_days controls how many days of backup history are included per device.",
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_device_name: {
            type: "string",
            description: "Filter by backup device name (filter[device_name])",
          },
          filter_device_id: {
            type: "string",
            description: "Filter by backup device ID (filter[device_id])",
          },
          history_days: {
            type: "number",
            description: "Days of backup history to include per device",
          },
          sort: {
            type: "string",
            description: "Sort expression (field name, prefix with '-' for descending)",
          },
          page_size: {
            type: "number",
            description: "Results per page, 1-200 (default 50)",
          },
          cursor: {
            type: "string",
            description: "Opaque pagination cursor from the previous page",
          },
        },
      },
    },
    invoke: (client, args) =>
      client.brBackups.listDevices(
        params(args, {
          filter_device_name: "filter[device_name]",
          filter_device_id: "filter[device_id]",
          history_days: "history_days",
          sort: "sort",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
];

const TOOL_INDEX = new Map(TOOLS.map((def) => [def.tool.name, def]));

function getTools(): Tool[] {
  return TOOLS.map((def) => def.tool);
}

async function handleCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const def = TOOL_INDEX.get(toolName);
  if (!def) {
    return {
      content: [
        { type: "text", text: `Unknown Backup Radar tool: ${toolName}` },
      ],
      isError: true,
    };
  }

  const client = await getClient();
  logger.info(`API call: ${toolName}`, { argKeys: Object.keys(args) });
  const result = await def.invoke(client, args);
  logger.debug(`API response: ${toolName}`);

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

export const handler: DomainHandler = {
  getTools,
  handleCall,
};
