/**
 * ControlMap domain handler
 *
 * Compliance management per client: health metrics and reports, risks,
 * controls, evidence, policies/procedures/governance, framework objectives,
 * assessments, and action items. Requires an active ControlMap subscription
 * (endpoints return 402 PAYMENT_REQUIRED otherwise). ControlMap honors the
 * ScalePad data-residency region (us, eu, ca, au).
 *
 * Search endpoints are POST with structured filter bodies; document uploads
 * accept multipart files (up to 10 MB) or the signed-URL flow.
 *
 * Tool naming: scalepad_cm_<entity>_<operation>.
 */
import type { Tool } from "@modelcontextprotocol/server";
import type { ScalePadClient } from "@wyre-technology/node-scalepad";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { getClient } from "../utils/client.js";
import { logger } from "../utils/logger.js";
import { elicitText, elicitConfirmation } from "../utils/elicitation.js";

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

/** Everything except the named (path) params — the tool's request body. */
function bodyExcept(
  args: Record<string, unknown>,
  pathParams: string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!pathParams.includes(key) && value !== undefined) out[key] = value;
  }
  return out;
}

/** Shared annotations for reversible state-mutating tools. */
function mutatingAnnotations(title: string, idempotent: boolean) {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: idempotent,
    openWorldHint: true,
  };
}

/** Shared annotations for irreversible (permanent) state-mutating tools. */
function irreversibleAnnotations(title: string) {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  };
}

const PAGINATION_NOTE =
  "Cursor-paginated: pass page_size (1-200, default 50) and the cursor returned by the previous page.";

const clientIdProp = {
  type: "string",
  description: "ControlMap client ID",
} as const;

/** Common body properties for the POST …/search endpoints. */
const searchBodyProps = {
  filter: {
    type: "object",
    description:
      "Structured filter object (field -> condition), per developer.scalepad.com. Omit to return everything.",
  },
  fields: {
    type: "array",
    items: { type: "string" },
    description: "Fields to include in the results",
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
} as const;

/** Common query properties for cross-client summary list endpoints. */
const summaryListProps = {
  filter_client_tenant_id: {
    type: "string",
    description: "Filter by client tenant ID (filter[client.tenant_id])",
  },
  filter_client_name: {
    type: "string",
    description: "Filter by client name (filter[client.name])",
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
} as const;

const SUMMARY_PARAM_MAP: Record<string, string> = {
  filter_client_tenant_id: "filter[client.tenant_id]",
  filter_client_name: "filter[client.name]",
  sort: "sort",
  page_size: "page_size",
  cursor: "cursor",
};

const TOOLS: ToolDef[] = [
  // -------------------------------------------------------------------------
  // cmHealth — compliance health metrics + reports
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_cm_health_list",
      description: `List compliance health metrics across all ControlMap clients. ${PAGINATION_NOTE} Filterable by client ID, tenant ID, or name.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_client_id: {
            type: "string",
            description: "Filter by client ID (filter[client.id])",
          },
          ...summaryListProps,
          fields: {
            type: "string",
            description: "Comma-separated list of fields to include",
          },
        },
      },
    },
    invoke: async (client, args) => {
      const p = params(args, {
        filter_client_id: "filter[client.id]",
        ...SUMMARY_PARAM_MAP,
        fields: "fields",
      });
      // Zero-filter default: offer a client-name filter before listing everything.
      const hasFilter = Object.keys(p).some((k) => k.startsWith("filter["));
      if (!hasFilter) {
        try {
          const name = await elicitText(
            "No filters provided. Optionally enter a client name to filter compliance health results (leave blank / cancel for all clients).",
            "client_name"
          );
          if (name) p["filter[client.name]"] = name;
        } catch {
          // Elicitation unsupported — proceed with the unfiltered list.
        }
      }
      return client.cmHealth.listHealth(p as never);
    },
  },
  {
    tool: {
      name: "scalepad_cm_health_get",
      description:
        "Get compliance health metrics for a single ControlMap client (framework progress, evidence and action-item posture).",
      inputSchema: {
        type: "object" as const,
        properties: { client_id: clientIdProp },
        required: ["client_id"],
      },
    },
    invoke: (client, args) => client.cmHealth.getHealth(args.client_id as string),
  },
  {
    tool: {
      name: "scalepad_cm_reports_list",
      description: `List generated ControlMap reports for a client (POST search with a structured filter body). ${PAGINATION_NOTE}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          ...searchBodyProps,
        },
        required: ["client_id"],
      },
    },
    invoke: (client, args) =>
      client.cmHealth.listReports(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_reports_get_signed_url",
      description:
        "Retrieve a signed URL to download a generated ControlMap report for a client. The URL is time-limited.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          report_id: { type: "string", description: "Report ID" },
        },
        required: ["client_id", "report_id"],
      },
    },
    invoke: (client, args) =>
      client.cmHealth.getReportSignedUrl(
        args.client_id as string,
        args.report_id as string
      ),
  },

  // -------------------------------------------------------------------------
  // cmRisks — risk register
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_cm_risks_search",
      description: `Search a ControlMap client's risk register (POST search with a structured filter body; omit filter to list all risks). ${PAGINATION_NOTE}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          ...searchBodyProps,
        },
        required: ["client_id"],
      },
    },
    invoke: (client, args) =>
      client.cmRisks.search(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_risks_get",
      description: "Get a single ControlMap risk by ID for a client.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          risk_id: { type: "string", description: "Risk ID" },
        },
        required: ["client_id", "risk_id"],
      },
    },
    invoke: (client, args) =>
      client.cmRisks.get(args.client_id as string, args.risk_id as string),
  },
  {
    tool: {
      name: "scalepad_cm_risks_create",
      description:
        "⚠ HIGH-IMPACT. Create a risk in a ControlMap client's risk register (name, description, status, department, category, owner, business impact, impact/likelihood scores). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Client Risk", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          name: { type: "string", description: "Risk name" },
          description: { type: "string", description: "Risk description" },
          status: { type: "string", description: "Risk status" },
          department: { type: "string", description: "Responsible department" },
          risk_category: { type: "string", description: "Risk category" },
          owner_email: { type: "string", description: "Risk owner's email" },
          business_impact: { type: "string", description: "Business impact description" },
          impact: { type: "number", description: "Impact score" },
          likelihood: { type: "number", description: "Likelihood score" },
        },
        required: ["client_id", "name"],
      },
    },
    invoke: (client, args) =>
      client.cmRisks.create(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_risks_update",
      description:
        "⚠ HIGH-IMPACT. Partially update a ControlMap risk (code, title, description, status, owner, team, department, category). Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Client Risk", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          risk_id: { type: "string", description: "Risk ID" },
          code: { type: "string", description: "Risk code" },
          title: { type: "string", description: "Risk title" },
          description: { type: "string", description: "Risk description" },
          status: { type: "string", description: "Risk status" },
          owner_email: { type: "string", description: "Risk owner's email" },
          team: { type: "string", description: "Responsible team" },
          department: { type: "string", description: "Responsible department" },
          category: { type: "string", description: "Risk category" },
        },
        required: ["client_id", "risk_id"],
      },
    },
    invoke: (client, args) =>
      client.cmRisks.update(
        args.client_id as string,
        args.risk_id as string,
        bodyExcept(args, ["client_id", "risk_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_risks_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a risk from a ControlMap client's risk register. Confirm with the user before invoking.",
      annotations: irreversibleAnnotations("Delete Client Risk"),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          risk_id: { type: "string", description: "Risk ID" },
        },
        required: ["client_id", "risk_id"],
      },
    },
    invoke: (client, args) =>
      client.cmRisks.delete(args.client_id as string, args.risk_id as string),
  },
  {
    tool: {
      name: "scalepad_cm_risks_list_summaries",
      description: `List risk summaries across all ControlMap clients. ${PAGINATION_NOTE} Filterable by client tenant ID or name.`,
      inputSchema: {
        type: "object" as const,
        properties: { ...summaryListProps },
      },
    },
    invoke: (client, args) =>
      client.cmRisks.listSummaries(params(args, SUMMARY_PARAM_MAP) as never),
  },
  {
    tool: {
      name: "scalepad_cm_risks_map",
      description:
        "⚠ HIGH-IMPACT. Map a ControlMap risk to related records: assets, asset types, threats, vulnerabilities, vendors, objectives, controls, and/or action items. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Map Risk to Assets and Vendors", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          risk_id: { type: "string", description: "Risk ID" },
          asset_codes: { type: "array", items: { type: "string" }, description: "Asset codes to map" },
          asset_type_names: { type: "array", items: { type: "string" }, description: "Asset type names to map" },
          threat_codes: { type: "array", items: { type: "string" }, description: "Threat codes to map" },
          vulnerability_codes: { type: "array", items: { type: "string" }, description: "Vulnerability codes to map" },
          vendor_codes: { type: "array", items: { type: "string" }, description: "Vendor codes to map" },
          objective_codes: { type: "array", items: { type: "string" }, description: "Framework objective codes to map" },
          control_codes: { type: "array", items: { type: "string" }, description: "Control codes to map" },
          action_item_codes: { type: "array", items: { type: "string" }, description: "Action item codes to map" },
        },
        required: ["client_id", "risk_id"],
      },
    },
    invoke: (client, args) =>
      client.cmRisks.map(
        args.client_id as string,
        args.risk_id as string,
        bodyExcept(args, ["client_id", "risk_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_risks_unmap",
      description:
        "⚠ HIGH-IMPACT. Bulk-remove mappings between a ControlMap risk and related records (assets, asset types, threats, vulnerabilities, vendors, objectives, controls, action items). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Unmap Risk from Assets and Vendors", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          risk_id: { type: "string", description: "Risk ID" },
          asset_codes: { type: "array", items: { type: "string" }, description: "Asset codes to unmap" },
          asset_type_names: { type: "array", items: { type: "string" }, description: "Asset type names to unmap" },
          threat_codes: { type: "array", items: { type: "string" }, description: "Threat codes to unmap" },
          vulnerability_codes: { type: "array", items: { type: "string" }, description: "Vulnerability codes to unmap" },
          vendor_codes: { type: "array", items: { type: "string" }, description: "Vendor codes to unmap" },
          objective_codes: { type: "array", items: { type: "string" }, description: "Framework objective codes to unmap" },
          control_codes: { type: "array", items: { type: "string" }, description: "Control codes to unmap" },
          action_item_codes: { type: "array", items: { type: "string" }, description: "Action item codes to unmap" },
        },
        required: ["client_id", "risk_id"],
      },
    },
    invoke: (client, args) =>
      client.cmRisks.unmap(
        args.client_id as string,
        args.risk_id as string,
        bodyExcept(args, ["client_id", "risk_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_risks_get_category",
      description: "Get a single ControlMap risk category by ID for a client.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          risk_category_id: { type: "string", description: "Risk category ID" },
        },
        required: ["client_id", "risk_category_id"],
      },
    },
    invoke: (client, args) =>
      client.cmRisks.getCategory(
        args.client_id as string,
        args.risk_category_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_risks_list_departments",
      description: "List the risk departments configured for a ControlMap client.",
      inputSchema: {
        type: "object" as const,
        properties: { client_id: clientIdProp },
        required: ["client_id"],
      },
    },
    invoke: (client, args) => client.cmRisks.listDepartments(args.client_id as string),
  },

  // -------------------------------------------------------------------------
  // cmControls — controls, control sets, control families
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_cm_controls_search",
      description: `Search a ControlMap client's controls (POST search with a structured filter body; omit filter to list all controls). ${PAGINATION_NOTE}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          ...searchBodyProps,
        },
        required: ["client_id"],
      },
    },
    invoke: (client, args) =>
      client.cmControls.search(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_controls_get",
      description: "Get a single ControlMap control by ID for a client.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          control_id: { type: "string", description: "Control ID" },
        },
        required: ["client_id", "control_id"],
      },
    },
    invoke: (client, args) =>
      client.cmControls.get(args.client_id as string, args.control_id as string),
  },
  {
    tool: {
      name: "scalepad_cm_controls_create",
      description:
        "⚠ HIGH-IMPACT. Create a control for a ControlMap client (type, name, description, tag, contributors, owner, control set / family). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Control", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          name: { type: "string", description: "Control name" },
          type: { type: "string", description: "Control type" },
          description: { type: "string", description: "Control description" },
          tag: { type: "string", description: "Control tag" },
          contributors: { type: "array", items: { type: "string" }, description: "Contributor emails" },
          owner_email: { type: "string", description: "Control owner's email" },
          control_set_name: { type: "string", description: "Control set to place the control in" },
          control_family_name: { type: "string", description: "Control family to place the control in" },
        },
        required: ["client_id", "name"],
      },
    },
    invoke: (client, args) =>
      client.cmControls.create(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_controls_update",
      description:
        "⚠ HIGH-IMPACT. Partially update a ControlMap control (name, description, code, status, owner, type, frequency, team, implementation notes, control family). Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Client Control", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          control_id: { type: "string", description: "Control ID" },
          name: { type: "string", description: "Control name" },
          description: { type: "string", description: "Control description" },
          code: { type: "string", description: "Control code" },
          status: { type: "string", description: "Control status" },
          owner: { type: "string", description: "Control owner" },
          type: { type: "string", description: "Control type" },
          frequency: { type: "string", description: "Review/operation frequency" },
          team: { type: "string", description: "Responsible team" },
          implementation_notes: { type: "string", description: "Implementation notes" },
          control_family_name: { type: "string", description: "Control family name" },
        },
        required: ["client_id", "control_id"],
      },
    },
    invoke: (client, args) =>
      client.cmControls.update(
        args.client_id as string,
        args.control_id as string,
        bodyExcept(args, ["client_id", "control_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_controls_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a control from a ControlMap client. Confirm with the user before invoking.",
      annotations: irreversibleAnnotations("Delete Control"),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          control_id: { type: "string", description: "Control ID" },
        },
        required: ["client_id", "control_id"],
      },
    },
    invoke: (client, args) =>
      client.cmControls.delete(args.client_id as string, args.control_id as string),
  },
  {
    tool: {
      name: "scalepad_cm_controls_map",
      description:
        "⚠ HIGH-IMPACT. Map a ControlMap control to related items: evidence, policies, risks, action items, procedures, governance, and/or framework objectives. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Map Control to Related Items", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          control_id: { type: "string", description: "Control ID" },
          evidence_codes: { type: "array", items: { type: "string" }, description: "Evidence codes to map" },
          policy_codes: { type: "array", items: { type: "string" }, description: "Policy codes to map" },
          risk_codes: { type: "array", items: { type: "string" }, description: "Risk codes to map" },
          action_item_codes: { type: "array", items: { type: "string" }, description: "Action item codes to map" },
          procedure_codes: { type: "array", items: { type: "string" }, description: "Procedure codes to map" },
          governance_codes: { type: "array", items: { type: "string" }, description: "Governance codes to map" },
          objectives: { type: "array", items: { type: "object" }, description: "Framework objectives to map" },
        },
        required: ["client_id", "control_id"],
      },
    },
    invoke: (client, args) =>
      client.cmControls.map(
        args.client_id as string,
        args.control_id as string,
        bodyExcept(args, ["client_id", "control_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_controls_unmap",
      description:
        "⚠ HIGH-IMPACT. Bulk-remove mappings between a ControlMap control and related items (evidence, policies, risks, action items, procedures, governance, objectives). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Unmap Control from Related Items", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          control_id: { type: "string", description: "Control ID" },
          evidence_codes: { type: "array", items: { type: "string" }, description: "Evidence codes to unmap" },
          policy_codes: { type: "array", items: { type: "string" }, description: "Policy codes to unmap" },
          risk_codes: { type: "array", items: { type: "string" }, description: "Risk codes to unmap" },
          action_item_codes: { type: "array", items: { type: "string" }, description: "Action item codes to unmap" },
          procedure_codes: { type: "array", items: { type: "string" }, description: "Procedure codes to unmap" },
          governance_codes: { type: "array", items: { type: "string" }, description: "Governance codes to unmap" },
          objectives: { type: "array", items: { type: "object" }, description: "Framework objectives to unmap" },
        },
        required: ["client_id", "control_id"],
      },
    },
    invoke: (client, args) =>
      client.cmControls.unmap(
        args.client_id as string,
        args.control_id as string,
        bodyExcept(args, ["client_id", "control_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_controls_list_sets",
      description: `List control sets for a ControlMap client. ${PAGINATION_NOTE} Filterable by ID, name, or code.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          filter_id: { type: "string", description: "Filter by control set ID (filter[id])" },
          filter_name: { type: "string", description: "Filter by control set name (filter[name])" },
          filter_code: { type: "string", description: "Filter by control set code (filter[code])" },
          page_size: { type: "number", description: "Results per page, 1-200 (default 50)" },
          cursor: { type: "string", description: "Opaque pagination cursor from the previous page" },
        },
        required: ["client_id"],
      },
    },
    invoke: (client, args) =>
      client.cmControls.listSets(
        args.client_id as string,
        params(args, {
          filter_id: "filter[id]",
          filter_name: "filter[name]",
          filter_code: "filter[code]",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_controls_list_families",
      description: `List control families for a ControlMap client. ${PAGINATION_NOTE} Filterable by ID, name, or code.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          filter_id: { type: "string", description: "Filter by control family ID (filter[id])" },
          filter_name: { type: "string", description: "Filter by control family name (filter[name])" },
          filter_code: { type: "string", description: "Filter by control family code (filter[code])" },
          page_size: { type: "number", description: "Results per page, 1-200 (default 50)" },
          cursor: { type: "string", description: "Opaque pagination cursor from the previous page" },
        },
        required: ["client_id"],
      },
    },
    invoke: (client, args) =>
      client.cmControls.listFamilies(
        args.client_id as string,
        params(args, {
          filter_id: "filter[id]",
          filter_name: "filter[name]",
          filter_code: "filter[code]",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_controls_list_summaries",
      description: `List control summaries across all ControlMap clients. ${PAGINATION_NOTE} Filterable by client ID.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_client_id: { type: "string", description: "Filter by client ID (filter[client.id])" },
          sort: { type: "string", description: "Sort expression (field name, prefix with '-' for descending)" },
          page_size: { type: "number", description: "Results per page, 1-200 (default 50)" },
          cursor: { type: "string", description: "Opaque pagination cursor from the previous page" },
        },
      },
    },
    invoke: (client, args) =>
      client.cmControls.listSummaries(
        params(args, {
          filter_client_id: "filter[client.id]",
          sort: "sort",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_controls_get_summary",
      description: "Get the control summary for a single ControlMap client (counts by status).",
      inputSchema: {
        type: "object" as const,
        properties: { client_id: clientIdProp },
        required: ["client_id"],
      },
    },
    invoke: (client, args) => client.cmControls.getSummary(args.client_id as string),
  },

  // -------------------------------------------------------------------------
  // cmEvidence — evidence, evidence requests, documents
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_cm_evidence_search",
      description: `Search a ControlMap client's evidence records (POST search with a structured filter body; omit filter to list all evidence). Set fetch_items / evidence_request to include nested request detail. ${PAGINATION_NOTE}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          ...searchBodyProps,
          fetch_items: { type: "boolean", description: "Include nested evidence items in the results" },
          evidence_request: { type: "boolean", description: "Include evidence request detail in the results" },
        },
        required: ["client_id"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.search(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_list_summaries",
      description: `List evidence summaries across all ControlMap clients. ${PAGINATION_NOTE} Filterable by client ID, tenant ID, or name.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_client_id: { type: "string", description: "Filter by client ID (filter[client.id])" },
          ...summaryListProps,
        },
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.listSummaries(
        params(args, {
          filter_client_id: "filter[client.id]",
          ...SUMMARY_PARAM_MAP,
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_create",
      description:
        "⚠ HIGH-IMPACT. Create an evidence record for a ControlMap client (title, description, owner, assignee, refresh schedule, initial mappings). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Client Evidence", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          title: { type: "string", description: "Evidence title" },
          description: { type: "string", description: "Evidence description" },
          owner_email: { type: "string", description: "Owner's email" },
          assignee_email: { type: "string", description: "Assignee's email" },
          repeat_type: { type: "string", description: "Refresh repeat type (e.g. monthly, quarterly, yearly)" },
          schedule: { type: "object", description: "Refresh schedule definition" },
          mappings: { type: "object", description: "Initial mappings (objective/control/question codes)" },
        },
        required: ["client_id", "title"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.create(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_get",
      description: "Get a single ControlMap evidence record by ID for a client.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_id: { type: "string", description: "Evidence ID" },
        },
        required: ["client_id", "evidence_id"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.get(args.client_id as string, args.evidence_id as string),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_update",
      description:
        "⚠ HIGH-IMPACT. Update a ControlMap evidence record (title, description, owner, schedule). Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Client Evidence", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_id: { type: "string", description: "Evidence ID" },
          title: { type: "string", description: "Evidence title" },
          description: { type: "string", description: "Evidence description" },
          owner: { type: "string", description: "Owner" },
          schedule: { type: "object", description: "Refresh schedule definition" },
        },
        required: ["client_id", "evidence_id"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.update(
        args.client_id as string,
        args.evidence_id as string,
        bodyExcept(args, ["client_id", "evidence_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a ControlMap evidence record (and its requests). Confirm with the user before invoking.",
      annotations: irreversibleAnnotations("Delete Client Evidence"),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_id: { type: "string", description: "Evidence ID" },
        },
        required: ["client_id", "evidence_id"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.delete(args.client_id as string, args.evidence_id as string),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_delete_schedule",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Delete the refresh schedule from a ControlMap evidence record. schedule_action controls how pending scheduled requests are handled. Confirm with the user before invoking.",
      annotations: irreversibleAnnotations("Delete Evidence Refresh Schedule"),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_id: { type: "string", description: "Evidence ID" },
          schedule_action: {
            type: "string",
            description: "How to handle pending scheduled requests when removing the schedule",
          },
        },
        required: ["client_id", "evidence_id"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.deleteSchedule(
        args.client_id as string,
        args.evidence_id as string,
        params(args, { schedule_action: "schedule_action" }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_requests_list",
      description: "List the requests attached to a ControlMap evidence record (each request collects one round of evidence).",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_id: { type: "string", description: "Evidence ID" },
        },
        required: ["client_id", "evidence_id"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.listRequests(
        args.client_id as string,
        args.evidence_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_requests_create",
      description:
        "⚠ HIGH-IMPACT. Create a new (empty) request in a ControlMap evidence record. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Request in Evidence", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_id: { type: "string", description: "Evidence ID" },
        },
        required: ["client_id", "evidence_id"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.createRequest(
        args.client_id as string,
        args.evidence_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_requests_create_with_urls",
      description:
        "⚠ HIGH-IMPACT. Create an evidence request on a ControlMap evidence record and get signed upload URLs for the named file (preferred for files over 10 MB). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Evidence Request with URLs", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_id: { type: "string", description: "Evidence ID" },
          file_name: { type: "string", description: "Name of the file to upload" },
          file_size_bytes: { type: "number", description: "File size in bytes" },
        },
        required: ["client_id", "evidence_id", "file_name", "file_size_bytes"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.createRequestSignedUrl(
        args.client_id as string,
        args.evidence_id as string,
        bodyExcept(args, ["client_id", "evidence_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_requests_signed_urls",
      description:
        "⚠ HIGH-IMPACT. Generate signed upload URLs for a document on an existing ControlMap evidence request (preferred for files over 10 MB). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Generate Signed URLs for Evidence", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_request_id: { type: "string", description: "Evidence request ID" },
          file_name: { type: "string", description: "Name of the file to upload" },
          file_size_bytes: { type: "number", description: "File size in bytes" },
        },
        required: ["client_id", "evidence_request_id", "file_name", "file_size_bytes"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.createRequestDocumentSignedUrl(
        args.client_id as string,
        args.evidence_request_id as string,
        bodyExcept(args, ["client_id", "evidence_request_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_requests_upload_document",
      description:
        "⚠ HIGH-IMPACT. Upload a document (multipart, up to 10 MB) to an existing ControlMap evidence request. For larger files use the signed-URL flow (scalepad_cm_evidence_requests_signed_urls). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Upload Document to Evidence Request", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_request_id: { type: "string", description: "Evidence request ID" },
          file: { type: "string", description: "File content, base64-encoded" },
          file_name: { type: "string", description: "File name" },
        },
        required: ["client_id", "evidence_request_id", "file"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.uploadRequestDocument(
        args.client_id as string,
        args.evidence_request_id as string,
        bodyExcept(args, ["client_id", "evidence_request_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_requests_create_with_upload",
      description:
        "⚠ HIGH-IMPACT. Create an evidence request on a ControlMap evidence record by directly uploading a document (multipart, up to 10 MB). For larger files use scalepad_cm_evidence_requests_create_with_urls. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Evidence Request with Upload", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_id: { type: "string", description: "Evidence ID" },
          file: { type: "string", description: "File content, base64-encoded" },
          file_name: { type: "string", description: "File name" },
        },
        required: ["client_id", "evidence_id", "file"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.uploadDocument(
        args.client_id as string,
        args.evidence_id as string,
        bodyExcept(args, ["client_id", "evidence_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_requests_create_link",
      description:
        "⚠ HIGH-IMPACT. Attach a named hyperlink to a ControlMap evidence request (link-based evidence instead of a file upload). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Link for Evidence Request", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_request_id: { type: "string", description: "Evidence request ID" },
          name: { type: "string", description: "Link display name" },
          hyperlink: { type: "string", description: "URL of the linked evidence" },
        },
        required: ["client_id", "evidence_request_id", "name", "hyperlink"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.createRequestLink(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_requests_update",
      description:
        "⚠ HIGH-IMPACT. Partially update a ControlMap evidence request (assignee, status, due date, notes). Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Evidence Request", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_request_id: { type: "string", description: "Evidence request ID" },
          assigned_to: { type: "string", description: "Assignee" },
          status: { type: "string", description: "Request status" },
          due_date: { type: "string", description: "Due date, ISO 8601" },
          notes: { type: "string", description: "Notes" },
        },
        required: ["client_id", "evidence_request_id"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.updateRequest(
        args.client_id as string,
        args.evidence_request_id as string,
        bodyExcept(args, ["client_id", "evidence_request_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_requests_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a ControlMap evidence request (and its uploaded documents/links). Confirm with the user before invoking.",
      annotations: irreversibleAnnotations("Delete Evidence Request"),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_request_id: { type: "string", description: "Evidence request ID" },
        },
        required: ["client_id", "evidence_request_id"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.deleteRequest(
        args.client_id as string,
        args.evidence_request_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_requests_archive",
      description:
        "⚠ HIGH-IMPACT. Archive a ControlMap evidence request (removes it from active views without deleting data). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Archive Evidence Request", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_request_id: { type: "string", description: "Evidence request ID" },
        },
        required: ["client_id", "evidence_request_id"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.archiveRequest(
        args.client_id as string,
        args.evidence_request_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_refresh_mappings",
      description:
        "⚠ HIGH-IMPACT. Refresh (recompute) a ControlMap client's evidence mappings. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Refresh Client Evidence Mappings", false),
      inputSchema: {
        type: "object" as const,
        properties: { client_id: clientIdProp },
        required: ["client_id"],
      },
    },
    invoke: (client, args) => client.cmEvidence.refreshMappings(args.client_id as string),
  },
  {
    tool: {
      name: "scalepad_cm_documents_get_signed_url",
      description:
        "Get a time-limited signed download URL for a ControlMap document by document ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          document_id: { type: "string", description: "Document ID" },
        },
        required: ["client_id", "document_id"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.getDocumentSignedUrl(
        args.client_id as string,
        args.document_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_documents_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a ControlMap document. Confirm with the user before invoking.",
      annotations: irreversibleAnnotations("Delete Document"),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          document_id: { type: "string", description: "Document ID" },
        },
        required: ["client_id", "document_id"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.deleteDocument(
        args.client_id as string,
        args.document_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_map",
      description:
        "⚠ HIGH-IMPACT. Map a ControlMap evidence record to framework objectives, controls, and/or assessment questions. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Map Evidence to Objectives or Controls", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_id: { type: "string", description: "Evidence ID" },
          objective_codes: { type: "array", items: { type: "string" }, description: "Framework objective codes to map" },
          control_codes: { type: "array", items: { type: "string" }, description: "Control codes to map" },
          assessment_question_codes: { type: "array", items: { type: "string" }, description: "Assessment question codes to map" },
        },
        required: ["client_id", "evidence_id"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.map(
        args.client_id as string,
        args.evidence_id as string,
        bodyExcept(args, ["client_id", "evidence_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_evidence_unmap",
      description:
        "⚠ HIGH-IMPACT. Bulk-remove mappings between a ControlMap evidence record and framework objectives, controls, and/or assessment questions. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Unmap Evidence from Objectives or Controls", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          evidence_id: { type: "string", description: "Evidence ID" },
          objective_codes: { type: "array", items: { type: "string" }, description: "Framework objective codes to unmap" },
          control_codes: { type: "array", items: { type: "string" }, description: "Control codes to unmap" },
          assessment_question_codes: { type: "array", items: { type: "string" }, description: "Assessment question codes to unmap" },
        },
        required: ["client_id", "evidence_id"],
      },
    },
    invoke: (client, args) =>
      client.cmEvidence.unmap(
        args.client_id as string,
        args.evidence_id as string,
        bodyExcept(args, ["client_id", "evidence_id"]) as never
      ),
  },

  // -------------------------------------------------------------------------
  // cmPolicies — governance, policies, procedures
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_cm_governance_search",
      description: `Search a ControlMap client's governance documents (POST search with a structured filter body; omit filter to list all). ${PAGINATION_NOTE}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          ...searchBodyProps,
        },
        required: ["client_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.searchGovernance(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_governance_create",
      description:
        "⚠ HIGH-IMPACT. Create a governance document for a ControlMap client. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Client Governance", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          title: { type: "string", description: "Governance document title" },
          description: { type: "string", description: "Governance document description" },
        },
        required: ["client_id", "title"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.createGovernance(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_governance_get",
      description: "Get a single ControlMap governance document by ID for a client.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          governance_id: { type: "string", description: "Governance document ID" },
        },
        required: ["client_id", "governance_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.getGovernance(
        args.client_id as string,
        args.governance_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_governance_update",
      description:
        "⚠ HIGH-IMPACT. Partially update a ControlMap governance document (title, description, code, status, data classification, review date, owner, approver, team, tags). Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Client Governance", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          governance_id: { type: "string", description: "Governance document ID" },
          title: { type: "string", description: "Title" },
          description: { type: "string", description: "Description" },
          code: { type: "string", description: "Code" },
          status: { type: "string", description: "Status" },
          data_classification: { type: "string", description: "Data classification" },
          review_date: { type: "string", description: "Review date, ISO 8601" },
          owner: { type: "string", description: "Owner" },
          approver: { type: "string", description: "Approver" },
          team: { type: "string", description: "Team" },
          tags: { type: "array", items: { type: "string" }, description: "Tags" },
        },
        required: ["client_id", "governance_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.updateGovernance(
        args.client_id as string,
        args.governance_id as string,
        bodyExcept(args, ["client_id", "governance_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_governance_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a ControlMap governance document. Confirm with the user before invoking.",
      annotations: irreversibleAnnotations("Delete Client Governance"),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          governance_id: { type: "string", description: "Governance document ID" },
        },
        required: ["client_id", "governance_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.deleteGovernance(
        args.client_id as string,
        args.governance_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_governance_map",
      description:
        "⚠ HIGH-IMPACT. Map a ControlMap governance document to framework objectives, policies, and/or controls. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Map Governance to Related Items", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          governance_id: { type: "string", description: "Governance document ID" },
          objectives: { type: "array", items: { type: "object" }, description: "Framework objectives to map" },
          policy_codes: { type: "array", items: { type: "string" }, description: "Policy codes to map" },
          control_codes: { type: "array", items: { type: "string" }, description: "Control codes to map" },
        },
        required: ["client_id", "governance_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.mapGovernance(
        args.client_id as string,
        args.governance_id as string,
        bodyExcept(args, ["client_id", "governance_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_governance_unmap",
      description:
        "⚠ HIGH-IMPACT. Bulk-remove mappings between a ControlMap governance document and framework objectives, policies, and/or controls. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Unmap Governance from Related Items", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          governance_id: { type: "string", description: "Governance document ID" },
          objectives: { type: "array", items: { type: "object" }, description: "Framework objectives to unmap" },
          policy_codes: { type: "array", items: { type: "string" }, description: "Policy codes to unmap" },
          control_codes: { type: "array", items: { type: "string" }, description: "Control codes to unmap" },
        },
        required: ["client_id", "governance_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.unmapGovernance(
        args.client_id as string,
        args.governance_id as string,
        bodyExcept(args, ["client_id", "governance_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_governance_list_summaries",
      description: `List governance overviews across all ControlMap clients. ${PAGINATION_NOTE} Filterable by client tenant ID or name.`,
      inputSchema: {
        type: "object" as const,
        properties: { ...summaryListProps },
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.listGovernanceSummaries(params(args, SUMMARY_PARAM_MAP) as never),
  },
  {
    tool: {
      name: "scalepad_cm_policies_search",
      description: `Search a ControlMap client's policies (POST search with a structured filter body; omit filter to list all). ${PAGINATION_NOTE}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          ...searchBodyProps,
        },
        required: ["client_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.searchPolicies(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_policies_create",
      description:
        "⚠ HIGH-IMPACT. Create a policy for a ControlMap client, optionally from a policy template and with initial sections. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Client Policy", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          title: { type: "string", description: "Policy title" },
          policy_template_name: { type: "string", description: "Policy template to create from" },
          sections: {
            type: "array",
            items: { type: "object" },
            description: "Initial policy sections ({ title, description })",
          },
        },
        required: ["client_id", "title"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.createPolicy(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_policies_get",
      description: "Get a single ControlMap policy by ID for a client, including its sections.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          policy_id: { type: "string", description: "Policy ID" },
        },
        required: ["client_id", "policy_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.getPolicy(args.client_id as string, args.policy_id as string),
  },
  {
    tool: {
      name: "scalepad_cm_policies_update",
      description:
        "⚠ HIGH-IMPACT. Partially update a ControlMap policy (title, code, status, data classification, review date, owner, approver, team, tags, contributors). Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Client Policy", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          policy_id: { type: "string", description: "Policy ID" },
          title: { type: "string", description: "Title" },
          code: { type: "string", description: "Code" },
          status: { type: "string", description: "Status" },
          data_classification: { type: "string", description: "Data classification" },
          review_date: { type: "string", description: "Review date, ISO 8601" },
          owner: { type: "string", description: "Owner" },
          approver: { type: "string", description: "Approver" },
          team: { type: "string", description: "Team" },
          tags: { type: "array", items: { type: "string" }, description: "Tags" },
          contributors: { type: "array", items: { type: "string" }, description: "Contributor emails" },
        },
        required: ["client_id", "policy_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.updatePolicy(
        args.client_id as string,
        args.policy_id as string,
        bodyExcept(args, ["client_id", "policy_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_policies_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a ControlMap policy (and its sections). Confirm with the user before invoking.",
      annotations: irreversibleAnnotations("Delete Client Policy"),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          policy_id: { type: "string", description: "Policy ID" },
        },
        required: ["client_id", "policy_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.deletePolicy(
        args.client_id as string,
        args.policy_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_policies_upsert_section",
      description:
        "⚠ HIGH-IMPACT. Create or update a section of a ControlMap policy (PUT: include id to update an existing section, omit it to create one). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create or Update Policy Section", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          policy_id: { type: "string", description: "Policy ID" },
          id: { type: "string", description: "Section ID (omit to create a new section)" },
          title: { type: "string", description: "Section title" },
          description: { type: "string", description: "Section body/description" },
        },
        required: ["client_id", "policy_id", "title"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.upsertPolicySection(
        args.client_id as string,
        args.policy_id as string,
        bodyExcept(args, ["client_id", "policy_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_policies_delete_section",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a section from a ControlMap policy. Confirm with the user before invoking.",
      annotations: irreversibleAnnotations("Delete Client Policy Section"),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          policy_id: { type: "string", description: "Policy ID" },
          section_id: { type: "string", description: "Section ID" },
        },
        required: ["client_id", "policy_id", "section_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.deletePolicySection(
        args.client_id as string,
        args.policy_id as string,
        args.section_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_policies_map",
      description:
        "⚠ HIGH-IMPACT. Map a ControlMap policy to framework objectives and/or controls. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Map Policy to Objectives and Controls", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          policy_id: { type: "string", description: "Policy ID" },
          objectives: { type: "array", items: { type: "object" }, description: "Framework objectives to map" },
          control_codes: { type: "array", items: { type: "string" }, description: "Control codes to map" },
        },
        required: ["client_id", "policy_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.mapPolicy(
        args.client_id as string,
        args.policy_id as string,
        bodyExcept(args, ["client_id", "policy_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_policies_unmap",
      description:
        "⚠ HIGH-IMPACT. Bulk-remove mappings between a ControlMap policy and framework objectives and/or controls. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Unmap Policy from Objectives and Controls", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          policy_id: { type: "string", description: "Policy ID" },
          objectives: { type: "array", items: { type: "object" }, description: "Framework objectives to unmap" },
          control_codes: { type: "array", items: { type: "string" }, description: "Control codes to unmap" },
        },
        required: ["client_id", "policy_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.unmapPolicy(
        args.client_id as string,
        args.policy_id as string,
        bodyExcept(args, ["client_id", "policy_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_policies_list_summaries",
      description: `List policy overviews across all ControlMap clients. ${PAGINATION_NOTE} Filterable by client tenant ID or name.`,
      inputSchema: {
        type: "object" as const,
        properties: { ...summaryListProps },
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.listPolicySummaries(params(args, SUMMARY_PARAM_MAP) as never),
  },
  {
    tool: {
      name: "scalepad_cm_procedures_search",
      description: `Search a ControlMap client's procedures (POST search with a structured filter body; omit filter to list all). ${PAGINATION_NOTE}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          ...searchBodyProps,
        },
        required: ["client_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.searchProcedures(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_procedures_create",
      description:
        "⚠ HIGH-IMPACT. Create a procedure for a ControlMap client. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Client Procedure", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          title: { type: "string", description: "Procedure title" },
          description: { type: "string", description: "Procedure description" },
        },
        required: ["client_id", "title"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.createProcedure(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_procedures_get",
      description: "Get a single ControlMap procedure by ID for a client.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          procedure_id: { type: "string", description: "Procedure ID" },
        },
        required: ["client_id", "procedure_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.getProcedure(
        args.client_id as string,
        args.procedure_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_procedures_update",
      description:
        "⚠ HIGH-IMPACT. Partially update a ControlMap procedure (title, description, code, status, data classification, review date, owner, approver, team, tags). Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Client Procedure", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          procedure_id: { type: "string", description: "Procedure ID" },
          title: { type: "string", description: "Title" },
          description: { type: "string", description: "Description" },
          code: { type: "string", description: "Code" },
          status: { type: "string", description: "Status" },
          data_classification: { type: "string", description: "Data classification" },
          review_date: { type: "string", description: "Review date, ISO 8601" },
          owner: { type: "string", description: "Owner" },
          approver: { type: "string", description: "Approver" },
          team: { type: "string", description: "Team" },
          tags: { type: "array", items: { type: "string" }, description: "Tags" },
        },
        required: ["client_id", "procedure_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.updateProcedure(
        args.client_id as string,
        args.procedure_id as string,
        bodyExcept(args, ["client_id", "procedure_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_procedures_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a ControlMap procedure. Confirm with the user before invoking.",
      annotations: irreversibleAnnotations("Delete Client Procedure"),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          procedure_id: { type: "string", description: "Procedure ID" },
        },
        required: ["client_id", "procedure_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.deleteProcedure(
        args.client_id as string,
        args.procedure_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_procedures_map",
      description:
        "⚠ HIGH-IMPACT. Map a ControlMap procedure to framework objectives, policies, and/or controls. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Map Procedure to Related Items", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          procedure_id: { type: "string", description: "Procedure ID" },
          objectives: { type: "array", items: { type: "object" }, description: "Framework objectives to map" },
          policy_codes: { type: "array", items: { type: "string" }, description: "Policy codes to map" },
          control_codes: { type: "array", items: { type: "string" }, description: "Control codes to map" },
        },
        required: ["client_id", "procedure_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.mapProcedure(
        args.client_id as string,
        args.procedure_id as string,
        bodyExcept(args, ["client_id", "procedure_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_procedures_unmap",
      description:
        "⚠ HIGH-IMPACT. Bulk-remove mappings between a ControlMap procedure and framework objectives, policies, and/or controls. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Unmap Procedure from Related Items", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          procedure_id: { type: "string", description: "Procedure ID" },
          objectives: { type: "array", items: { type: "object" }, description: "Framework objectives to unmap" },
          policy_codes: { type: "array", items: { type: "string" }, description: "Policy codes to unmap" },
          control_codes: { type: "array", items: { type: "string" }, description: "Control codes to unmap" },
        },
        required: ["client_id", "procedure_id"],
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.unmapProcedure(
        args.client_id as string,
        args.procedure_id as string,
        bodyExcept(args, ["client_id", "procedure_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_procedures_list_summaries",
      description: `List procedure overviews across all ControlMap clients. ${PAGINATION_NOTE} Filterable by client tenant ID or name.`,
      inputSchema: {
        type: "object" as const,
        properties: { ...summaryListProps },
      },
    },
    invoke: (client, args) =>
      client.cmPolicies.listProcedureSummaries(params(args, SUMMARY_PARAM_MAP) as never),
  },

  // -------------------------------------------------------------------------
  // cmFrameworks — framework objectives
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_cm_objectives_search",
      description: `Search the objectives of a specific compliance framework for a ControlMap client (POST search with a structured filter body). ${PAGINATION_NOTE}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          framework_id: { type: "string", description: "Framework ID" },
          ...searchBodyProps,
        },
        required: ["client_id", "framework_id"],
      },
    },
    invoke: (client, args) =>
      client.cmFrameworks.searchObjectives(
        args.client_id as string,
        args.framework_id as string,
        bodyExcept(args, ["client_id", "framework_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_objectives_get",
      description: "Get a single framework objective by ID for a ControlMap client.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          framework_id: { type: "string", description: "Framework ID" },
          objective_id: { type: "string", description: "Objective ID" },
        },
        required: ["client_id", "framework_id", "objective_id"],
      },
    },
    invoke: (client, args) =>
      client.cmFrameworks.getObjective(
        args.client_id as string,
        args.framework_id as string,
        args.objective_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_objectives_get_summary",
      description:
        "Get the framework objective summary for a single ControlMap client (progress across frameworks).",
      inputSchema: {
        type: "object" as const,
        properties: { client_id: clientIdProp },
        required: ["client_id"],
      },
    },
    invoke: (client, args) =>
      client.cmFrameworks.getObjectiveSummary(args.client_id as string),
  },
  {
    tool: {
      name: "scalepad_cm_objectives_list_summaries",
      description: `List framework objective overviews across all ControlMap clients. ${PAGINATION_NOTE} Filterable by client tenant ID or name.`,
      inputSchema: {
        type: "object" as const,
        properties: { ...summaryListProps },
      },
    },
    invoke: (client, args) =>
      client.cmFrameworks.listObjectiveSummaries(params(args, SUMMARY_PARAM_MAP) as never),
  },

  // -------------------------------------------------------------------------
  // cmAssessments — assessment questions, answers, responses
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_cm_assessments_list_summaries",
      description: `List assessment overviews across all ControlMap clients. ${PAGINATION_NOTE} Filterable by client tenant ID or name.`,
      inputSchema: {
        type: "object" as const,
        properties: { ...summaryListProps },
      },
    },
    invoke: (client, args) =>
      client.cmAssessments.listSummaries(params(args, SUMMARY_PARAM_MAP) as never),
  },
  {
    tool: {
      name: "scalepad_cm_assessments_get_summary",
      description:
        "Get the assessment summary for a single ControlMap client. Set include_framework_assessment_stats for per-framework stats.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          include_framework_assessment_stats: {
            type: "boolean",
            description: "Include per-framework assessment statistics",
          },
        },
        required: ["client_id"],
      },
    },
    invoke: (client, args) =>
      client.cmAssessments.getSummary(
        args.client_id as string,
        params(args, {
          include_framework_assessment_stats: "include_framework_assessment_stats",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_assessments_search_questions",
      description: `Search a ControlMap client's assessment questions (POST search with a structured filter body and optional rules). ${PAGINATION_NOTE}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          ...searchBodyProps,
          rules: { type: "object", description: "Additional rule constraints for the question search" },
        },
        required: ["client_id"],
      },
    },
    invoke: (client, args) =>
      client.cmAssessments.searchQuestions(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_assessments_get_question",
      description: "Get a single assessment question (with its answer and responses) by question code for a ControlMap client.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          question_code: { type: "string", description: "Assessment question code" },
        },
        required: ["client_id", "question_code"],
      },
    },
    invoke: (client, args) =>
      client.cmAssessments.getQuestion(
        args.client_id as string,
        args.question_code as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_assessments_save_answer",
      description:
        "⚠ HIGH-IMPACT. Save (set or replace) the answer to an assessment question for a ControlMap client. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Save Assessment Question Answer", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          question_code: { type: "string", description: "Assessment question code" },
          answer: { type: "string", description: "The answer value to save" },
        },
        required: ["client_id", "question_code", "answer"],
      },
    },
    invoke: (client, args) =>
      client.cmAssessments.saveAnswer(
        args.client_id as string,
        args.question_code as string,
        bodyExcept(args, ["client_id", "question_code"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_assessments_clear_answer",
      description:
        "⚠ HIGH-IMPACT. Clear the saved answer of an assessment question for a ControlMap client (the question reverts to unanswered). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Clear Assessment Question Answer", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          question_code: { type: "string", description: "Assessment question code" },
        },
        required: ["client_id", "question_code"],
      },
    },
    invoke: (client, args) =>
      client.cmAssessments.clearAnswer(
        args.client_id as string,
        args.question_code as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_assessments_map_question",
      description:
        "⚠ HIGH-IMPACT. Map an assessment question to evidence, action items, policies, and/or procedures for a ControlMap client. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Map Assessment Question to Items", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          question_code: { type: "string", description: "Assessment question code" },
          evidence_codes: { type: "array", items: { type: "string" }, description: "Evidence codes to map" },
          action_item_codes: { type: "array", items: { type: "string" }, description: "Action item codes to map" },
          policy_codes: { type: "array", items: { type: "string" }, description: "Policy codes to map" },
          procedure_codes: { type: "array", items: { type: "string" }, description: "Procedure codes to map" },
        },
        required: ["client_id", "question_code"],
      },
    },
    invoke: (client, args) =>
      client.cmAssessments.mapQuestion(
        args.client_id as string,
        args.question_code as string,
        bodyExcept(args, ["client_id", "question_code"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_assessments_unmap_question",
      description:
        "⚠ HIGH-IMPACT. Remove mappings between an assessment question and evidence, action items, policies, and/or procedures for a ControlMap client. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Unmap Assessment Question from Items", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          question_code: { type: "string", description: "Assessment question code" },
          evidence_codes: { type: "array", items: { type: "string" }, description: "Evidence codes to unmap" },
          action_item_codes: { type: "array", items: { type: "string" }, description: "Action item codes to unmap" },
          policy_codes: { type: "array", items: { type: "string" }, description: "Policy codes to unmap" },
          procedure_codes: { type: "array", items: { type: "string" }, description: "Procedure codes to unmap" },
        },
        required: ["client_id", "question_code"],
      },
    },
    invoke: (client, args) =>
      client.cmAssessments.unmapQuestion(
        args.client_id as string,
        args.question_code as string,
        bodyExcept(args, ["client_id", "question_code"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_assessments_create_response",
      description:
        "⚠ HIGH-IMPACT. Add a free-text response to an assessment question for a ControlMap client (attributed via provided_by). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Assessment Question Response", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          question_code: { type: "string", description: "Assessment question code" },
          response: { type: "string", description: "Response text" },
          provided_by: { type: "string", description: "Who provided the response" },
        },
        required: ["client_id", "question_code", "response"],
      },
    },
    invoke: (client, args) =>
      client.cmAssessments.createResponse(
        args.client_id as string,
        args.question_code as string,
        bodyExcept(args, ["client_id", "question_code"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_assessments_update_response",
      description:
        "⚠ HIGH-IMPACT. Update an existing response on an assessment question for a ControlMap client (addressed by response id in the body). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Assessment Question Response", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          question_code: { type: "string", description: "Assessment question code" },
          id: { type: "string", description: "Response ID to update" },
          response: { type: "string", description: "Response text" },
          provided_by: { type: "string", description: "Who provided the response" },
        },
        required: ["client_id", "question_code", "id"],
      },
    },
    invoke: (client, args) =>
      client.cmAssessments.updateResponse(
        args.client_id as string,
        args.question_code as string,
        bodyExcept(args, ["client_id", "question_code"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_assessments_delete_response",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a response from an assessment question for a ControlMap client. Confirm with the user before invoking.",
      annotations: irreversibleAnnotations("Delete Assessment Question Response"),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          question_code: { type: "string", description: "Assessment question code" },
          response_id: { type: "string", description: "Response ID" },
        },
        required: ["client_id", "question_code", "response_id"],
      },
    },
    invoke: (client, args) =>
      client.cmAssessments.deleteResponse(
        args.client_id as string,
        args.question_code as string,
        args.response_id as string
      ),
  },

  // -------------------------------------------------------------------------
  // cmActionItems — remediation action items
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_cm_action_items_search",
      description: `Search a ControlMap client's action items (POST search with a structured filter body; omit filter to list all). ${PAGINATION_NOTE}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          ...searchBodyProps,
        },
        required: ["client_id"],
      },
    },
    invoke: (client, args) =>
      client.cmActionItems.search(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_action_items_get",
      description: "Get a single ControlMap action item by ID for a client.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          action_item_id: { type: "string", description: "Action item ID" },
        },
        required: ["client_id", "action_item_id"],
      },
    },
    invoke: (client, args) =>
      client.cmActionItems.get(
        args.client_id as string,
        args.action_item_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_action_items_create",
      description:
        "⚠ HIGH-IMPACT. Create an action item for a ControlMap client (weakness, corrective action, priority, responsible person/department, effort, roadmap, currency). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Action Item", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          weakness_name: { type: "string", description: "Weakness name" },
          weakness_description: { type: "string", description: "Weakness description" },
          corrective_action: { type: "string", description: "Planned corrective action" },
          status: { type: "string", description: "Action item status" },
          priority: { type: "string", description: "Priority" },
          responsible_person: { type: "string", description: "Responsible person" },
          responsible_department: { type: "string", description: "Responsible department" },
          efforts_in_hours: { type: "number", description: "Estimated effort in hours" },
          roadmap: { type: "string", description: "Roadmap placement" },
          currency: { type: "string", description: "Currency for cost fields (ISO 4217)" },
        },
        required: ["client_id", "weakness_name"],
      },
    },
    invoke: (client, args) =>
      client.cmActionItems.create(
        args.client_id as string,
        bodyExcept(args, ["client_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_action_items_update",
      description:
        "⚠ HIGH-IMPACT. Partially update a ControlMap action item (weakness, corrective action, status, priority, responsible person/department, effort, roadmap, planned start date). Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Action Item", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          action_item_id: { type: "string", description: "Action item ID" },
          weakness_name: { type: "string", description: "Weakness name" },
          weakness_description: { type: "string", description: "Weakness description" },
          corrective_action: { type: "string", description: "Planned corrective action" },
          status: { type: "string", description: "Action item status" },
          priority: { type: "string", description: "Priority" },
          responsible_person: { type: "string", description: "Responsible person" },
          responsible_department: { type: "string", description: "Responsible department" },
          efforts_in_hours: { type: "number", description: "Estimated effort in hours" },
          roadmap: { type: "string", description: "Roadmap placement" },
          planned_start_date: { type: "string", description: "Planned start date, ISO 8601" },
        },
        required: ["client_id", "action_item_id"],
      },
    },
    invoke: (client, args) =>
      client.cmActionItems.update(
        args.client_id as string,
        args.action_item_id as string,
        bodyExcept(args, ["client_id", "action_item_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_action_items_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a ControlMap action item. Confirm with the user before invoking.",
      annotations: irreversibleAnnotations("Delete Action Item"),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          action_item_id: { type: "string", description: "Action item ID" },
        },
        required: ["client_id", "action_item_id"],
      },
    },
    invoke: (client, args) =>
      client.cmActionItems.delete(
        args.client_id as string,
        args.action_item_id as string
      ),
  },
  {
    tool: {
      name: "scalepad_cm_action_items_map",
      description:
        "⚠ HIGH-IMPACT. Map a ControlMap action item to objectives, assessment questions, risks, controls, assets, and/or asset types. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Map Action Item to Related Items", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          action_item_id: { type: "string", description: "Action item ID" },
          objective_codes: { type: "array", items: { type: "string" }, description: "Framework objective codes to map" },
          question_codes: { type: "array", items: { type: "string" }, description: "Assessment question codes to map" },
          risk_codes: { type: "array", items: { type: "string" }, description: "Risk codes to map" },
          control_codes: { type: "array", items: { type: "string" }, description: "Control codes to map" },
          asset_codes: { type: "array", items: { type: "string" }, description: "Asset codes to map" },
          asset_type_names: { type: "array", items: { type: "string" }, description: "Asset type names to map" },
        },
        required: ["client_id", "action_item_id"],
      },
    },
    invoke: (client, args) =>
      client.cmActionItems.map(
        args.client_id as string,
        args.action_item_id as string,
        bodyExcept(args, ["client_id", "action_item_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_action_items_unmap",
      description:
        "⚠ HIGH-IMPACT. Bulk-remove mappings between a ControlMap action item and objectives, assessment questions, risks, controls, assets, and/or asset types. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Unmap Action Item from Related Items", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          action_item_id: { type: "string", description: "Action item ID" },
          objective_codes: { type: "array", items: { type: "string" }, description: "Framework objective codes to unmap" },
          question_codes: { type: "array", items: { type: "string" }, description: "Assessment question codes to unmap" },
          risk_codes: { type: "array", items: { type: "string" }, description: "Risk codes to unmap" },
          control_codes: { type: "array", items: { type: "string" }, description: "Control codes to unmap" },
          asset_codes: { type: "array", items: { type: "string" }, description: "Asset codes to unmap" },
          asset_type_names: { type: "array", items: { type: "string" }, description: "Asset type names to unmap" },
        },
        required: ["client_id", "action_item_id"],
      },
    },
    invoke: (client, args) =>
      client.cmActionItems.unmap(
        args.client_id as string,
        args.action_item_id as string,
        bodyExcept(args, ["client_id", "action_item_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_action_items_upload_document",
      description:
        "⚠ HIGH-IMPACT. Upload a supporting document (multipart, up to 10 MB) to a ControlMap action item. For larger files use scalepad_cm_action_items_generate_signed_urls. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Upload Document to Action Item", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          action_item_id: { type: "string", description: "Action item ID" },
          file: { type: "string", description: "File content, base64-encoded" },
          file_name: { type: "string", description: "File name" },
        },
        required: ["client_id", "action_item_id", "file"],
      },
    },
    invoke: (client, args) =>
      client.cmActionItems.uploadDocument(
        args.client_id as string,
        args.action_item_id as string,
        bodyExcept(args, ["client_id", "action_item_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_action_items_generate_signed_urls",
      description:
        "⚠ HIGH-IMPACT. Generate signed upload URLs for a document on a ControlMap action item (preferred for files over 10 MB). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Generate Signed URLs for Action Item", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: clientIdProp,
          action_item_id: { type: "string", description: "Action item ID" },
          file_name: { type: "string", description: "Name of the file to upload" },
          file_size_bytes: { type: "number", description: "File size in bytes" },
        },
        required: ["client_id", "action_item_id", "file_name", "file_size_bytes"],
      },
    },
    invoke: (client, args) =>
      client.cmActionItems.createDocumentSignedUrl(
        args.client_id as string,
        args.action_item_id as string,
        bodyExcept(args, ["client_id", "action_item_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_cm_action_items_list_summaries",
      description: `List action-item summaries across all ControlMap clients. ${PAGINATION_NOTE} Filterable by client ID, tenant ID, or name.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_client_id: { type: "string", description: "Filter by client ID (filter[client.id])" },
          ...summaryListProps,
        },
      },
    },
    invoke: (client, args) =>
      client.cmActionItems.listSummaries(
        params(args, {
          filter_client_id: "filter[client.id]",
          ...SUMMARY_PARAM_MAP,
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
      content: [{ type: "text", text: `Unknown ControlMap tool: ${toolName}` }],
      isError: true,
    };
  }

  // Destructive default: ask for confirmation; a null answer (client without
  // elicitation support) proceeds with the original behavior.
  if (def.tool.annotations?.destructiveHint) {
    let confirmed: boolean | null = null;
    try {
      confirmed = await elicitConfirmation(
        `${String(def.tool.annotations.title ?? toolName)} modifies ControlMap data. Proceed?`
      );
    } catch {
      confirmed = null;
    }
    if (confirmed === false) {
      return {
        content: [
          { type: "text", text: `Cancelled: ${toolName} was not executed.` },
        ],
      };
    }
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
