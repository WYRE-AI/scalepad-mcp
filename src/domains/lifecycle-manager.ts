/**
 * Lifecycle Manager domain handler
 *
 * Tools for the ScalePad Lifecycle Manager API (US-only): engagement and
 * roadmap workflows — clients/contacts, hardware assets and warranties,
 * initiatives, goals, meetings, action items, assessments, deliverables,
 * budgets, contracts, and workspace utilities (notes, insights, UI state).
 *
 * List endpoints use cursor pagination (page_size 1-200, default 25; pass the
 * cursor from the previous response). Several export endpoints return binary
 * CSV/PDF/XLSX payloads. Endpoints return 402 when the account has no active
 * Lifecycle Manager subscription.
 *
 * Every state-mutating tool is annotated destructive and confirmed with the
 * user (elicitation permitting) before the API is called.
 */
import type { Tool } from "@modelcontextprotocol/server";
import type { ScalePadClient } from "@wyre-technology/node-scalepad";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { getClient } from "../utils/client.js";
import { logger } from "../utils/logger.js";
import { elicitText, elicitConfirmation } from "../utils/elicitation.js";

type JsonSchema = NonNullable<Tool["inputSchema"]["properties"]>[string];

/** JSON Schema property shorthands (all hand-written literals underneath). */
const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string): JsonSchema => ({ type: "number", description });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const obj = (description: string): JsonSchema => ({ type: "object", description });
const arr = (description: string): JsonSchema => ({ type: "array", description });
const strArr = (description: string): JsonSchema => ({
  type: "array",
  items: { type: "string" },
  description,
});
/** A property whose type the API leaves open (rich-text JSON, period objects, …). */
const freeform = (description: string): JsonSchema => ({ description });

/** The shared cursor-pagination properties for Lifecycle Manager list tools. */
const paginationProps: Record<string, JsonSchema> = {
  page_size: {
    type: "number",
    description: "Results per page (1-200; API default 25).",
  },
  cursor: {
    type: "string",
    description:
      "Opaque pagination cursor from the previous response; omit for the first page.",
  },
};

const sortProp: Record<string, JsonSchema> = {
  sort: {
    type: "string",
    description: 'Sort field; prefix with "-" for descending.',
  },
};

/** A `filter` object property whose keys map to the API's filter[<key>] params. */
function filters(keys: string[]): Record<string, JsonSchema> {
  return {
    filter: {
      type: "object",
      description:
        `Optional filters, keyed by API filter name and sent as filter[<key>]=<value>. ` +
        `Supported keys: ${keys.join(", ")}.`,
    },
  };
}

function schema(
  properties: Record<string, JsonSchema>,
  required?: string[]
): Tool["inputSchema"] {
  if (required && required.length > 0) {
    return { type: "object" as const, properties, required };
  }
  return { type: "object" as const, properties };
}

/** Schema for the plain get-by-id tools. */
function idSchema(description: string): Tool["inputSchema"] {
  return schema({ id: str(description) }, ["id"]);
}

/** Read a required string argument or fail the call with a clear message. */
function req(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    throw new Error(`${name} is required`);
  }
  return String(value);
}

/**
 * Pick the given keys (when present) into a body object. The result is cast to
 * the SDK payload type expected at the call site — tool inputSchemas mirror the
 * payload shapes, so the cast is the trust boundary for client-supplied args.
 */
function pick<T = Record<string, unknown>>(
  args: Record<string, unknown>,
  keys: string[]
): T {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out as T;
}

/**
 * Map tool args onto SDK query params. Entries of the `filter` object become
 * filter[<key>] params; everything else (page_size, cursor, sort, search, …)
 * passes through as-is. `exclude` drops args already consumed as path params.
 */
function listParams(
  args: Record<string, unknown>,
  exclude: string[] = []
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || exclude.includes(key)) continue;
    if (key === "filter" && typeof value === "object") {
      for (const [fk, fv] of Object.entries(value as Record<string, unknown>)) {
        if (fv !== undefined && fv !== null) params[`filter[${fk}]`] = fv;
      }
    } else {
      params[key] = value;
    }
  }
  return params;
}

const IRREVERSIBLE = "⚠ DESTRUCTIVE — IRREVERSIBLE.";
const HIGH_IMPACT = "⚠ HIGH-IMPACT.";
const CONFIRM = "Confirm with the user before invoking.";

interface ElicitFilterSpec {
  message: string;
  /** Arg to set with the elicited value. */
  argName: string;
  /** When true, argName is a key inside the `filter` object arg. */
  isFilterKey?: boolean;
}

interface ToolSpec {
  tool: Tool;
  /** Zero-filter list default: offer a narrowing filter before listing everything. */
  emptyFilterElicit?: ElicitFilterSpec;
  /** Mutating tools: build the confirmation prompt shown before the call. */
  confirm?: (args: Record<string, unknown>) => string;
  call: (client: ScalePadClient, args: Record<string, unknown>) => Promise<unknown>;
}

/** Build a read-only tool spec (no destructive annotations, no warning prefix). */
function ro(
  name: string,
  description: string,
  inputSchema: Tool["inputSchema"],
  call: ToolSpec["call"],
  emptyFilterElicit?: ElicitFilterSpec
): ToolSpec {
  const spec: ToolSpec = { tool: { name, description, inputSchema }, call };
  if (emptyFilterElicit) spec.emptyFilterElicit = emptyFilterElicit;
  return spec;
}

function mutatingAnnotations(title: string, idempotentHint: boolean) {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint,
    openWorldHint: true,
  };
}

/** Build a reversible state-mutating tool spec (HIGH-IMPACT). */
function hi(
  name: string,
  title: string,
  idempotent: boolean,
  description: string,
  inputSchema: Tool["inputSchema"],
  confirm: (args: Record<string, unknown>) => string,
  call: ToolSpec["call"]
): ToolSpec {
  return {
    tool: {
      name,
      description: `${HIGH_IMPACT} ${description} ${CONFIRM}`,
      inputSchema,
      annotations: mutatingAnnotations(title, idempotent),
    },
    confirm,
    call,
  };
}

/** Build an irreversible state-mutating tool spec (DESTRUCTIVE). */
function irrev(
  name: string,
  title: string,
  idempotent: boolean,
  description: string,
  inputSchema: Tool["inputSchema"],
  confirm: (args: Record<string, unknown>) => string,
  call: ToolSpec["call"]
): ToolSpec {
  return {
    tool: {
      name,
      description: `${IRREVERSIBLE} ${description} ${CONFIRM}`,
      inputSchema,
      annotations: mutatingAnnotations(title, idempotent),
    },
    confirm,
    call,
  };
}

const specs: ToolSpec[] = [
  // ── lmClients ──────────────────────────────────────────────────────────────
  ro(
    "scalepad_lm_contacts_list",
    "List Lifecycle Manager contacts (cursor-paginated; page_size 1-200, default 25). Filterable by client_id and hidden status.",
    schema({
      ...filters(["client_id", "is_hidden"]),
      ...sortProp,
      ...paginationProps,
    }),
    (c, a) => c.lmClients.listContacts(listParams(a)),
    {
      message:
        "No filters provided — this lists contacts across every client. Optionally enter a client_id to narrow the results (leave empty to list all).",
      argName: "client_id",
      isFilterKey: true,
    }
  ),
  hi(
    "scalepad_lm_contacts_hidden_status_update",
    "Update Contact Hidden Status",
    true,
    "Hide or unhide a Lifecycle Manager contact (sets is_hidden).",
    schema(
      {
        contact_id: str("Contact id"),
        is_hidden: bool("true to hide the contact, false to unhide"),
      },
      ["contact_id", "is_hidden"]
    ),
    (a) => `Set is_hidden=${String(a.is_hidden)} on contact ${String(a.contact_id)}.`,
    (c, a) =>
      c.lmClients.updateContactHiddenStatus(req(a, "contact_id"), {
        is_hidden: a.is_hidden as boolean,
      })
  ),
  ro(
    "scalepad_lm_contacts_get",
    "Get a Lifecycle Manager contact by id.",
    schema({ contact_id: str("Contact id") }, ["contact_id"]),
    (c, a) => c.lmClients.getContact(req(a, "contact_id"))
  ),
  ro(
    "scalepad_lm_clients_lookup",
    "Look up Lifecycle Manager clients by search term (cursor-paginated). Lighter-weight than the full clients list; returns client keys usable in create calls.",
    schema({
      search: str("Search term to match client names"),
      ...sortProp,
      ...paginationProps,
    }),
    (c, a) => c.lmClients.lookupClients(listParams(a))
  ),
  ro(
    "scalepad_lm_client_groups_lookup",
    "Look up the client groups a specific client belongs to (by client_key).",
    schema({ client_key: str("Client key") }, ["client_key"]),
    (c, a) => c.lmClients.lookupClientGroups({ client_key: req(a, "client_key") })
  ),
  ro(
    "scalepad_lm_client_members_lookup",
    "Look up members (users) associated with a Lifecycle Manager client, optionally filtered by a search term.",
    schema(
      {
        client_id: str("Client id"),
        search: str("Optional search term"),
      },
      ["client_id"]
    ),
    (c, a) =>
      c.lmClients.lookupClientMembers(req(a, "client_id"), listParams(a, ["client_id"]))
  ),
  ro(
    "scalepad_lm_clients_list",
    "List Lifecycle Manager clients (cursor-paginated; page_size 1-200, default 25), optionally narrowed by a search term.",
    schema({
      search: str("Search term to match client names"),
      ...sortProp,
      ...paginationProps,
    }),
    (c, a) => c.lmClients.listClients(listParams(a)),
    {
      message:
        "No filters provided — this lists every Lifecycle Manager client. Optionally enter a search term to narrow the results (leave empty to list all).",
      argName: "search",
    }
  ),
  ro(
    "scalepad_lm_client_groups_list",
    "List all Lifecycle Manager client groups (no filters or pagination).",
    schema({}),
    (c) => c.lmClients.listClientGroups()
  ),
  ro(
    "scalepad_lm_client_groups_get",
    "Get a Lifecycle Manager client group by id.",
    schema({ client_group_id: str("Client group id") }, ["client_group_id"]),
    (c, a) => c.lmClients.getClientGroup(req(a, "client_group_id"))
  ),
  hi(
    "scalepad_lm_client_groups_unassign",
    "Client Group Unassign",
    true,
    "Remove clients and/or users from a Lifecycle Manager client group.",
    schema(
      {
        client_group_id: str("Client group id"),
        client_keys: strArr("Client keys to remove from the group"),
        user_keys: strArr("User keys to remove from the group"),
      },
      ["client_group_id"]
    ),
    (a) => `Unassign clients/users from client group ${String(a.client_group_id)}.`,
    (c, a) =>
      c.lmClients.unassignClientGroup(
        req(a, "client_group_id"),
        pick(a, ["client_keys", "user_keys"])
      )
  ),
  hi(
    "scalepad_lm_client_groups_assign",
    "Client Group Assign",
    true,
    "Assign clients and/or users to a Lifecycle Manager client group.",
    schema(
      {
        client_group_id: str("Client group id"),
        client_keys: strArr("Client keys to add to the group"),
        user_keys: strArr("User keys to add to the group"),
      },
      ["client_group_id"]
    ),
    (a) => `Assign clients/users to client group ${String(a.client_group_id)}.`,
    (c, a) =>
      c.lmClients.assignClientGroup(
        req(a, "client_group_id"),
        pick(a, ["client_keys", "user_keys"])
      )
  ),
  ro(
    "scalepad_lm_client_contacts_lookup",
    "Look up contacts for a specific Lifecycle Manager client, optionally filtered by a search term.",
    schema(
      {
        client_id: str("Client id"),
        search: str("Optional search term"),
      },
      ["client_id"]
    ),
    (c, a) =>
      c.lmClients.lookupClientContacts(req(a, "client_id"), listParams(a, ["client_id"]))
  ),
  ro(
    "scalepad_lm_active_users_list",
    "List active Lifecycle Manager users (no filters or pagination).",
    schema({}),
    (c) => c.lmClients.listActiveUsers()
  ),

  // ── lmAssets ───────────────────────────────────────────────────────────────
  ro(
    "scalepad_lm_warranty_pricing_list",
    "List ScalePad warranty pricing records (cursor-paginated), optionally scoped to a client and warranty type.",
    schema({
      client_id: str("Client id to scope pricing to"),
      warranty_type: str("Warranty type to filter by"),
      ...sortProp,
      ...paginationProps,
    }),
    (c, a) => c.lmAssets.listWarrantyPricing(listParams(a)),
    {
      message:
        "No filters provided — this lists warranty pricing account-wide. Optionally enter a client_id to narrow the results (leave empty to list all).",
      argName: "client_id",
    }
  ),
  ro(
    "scalepad_lm_hardware_replacement_settings_get",
    "Get Lifecycle Manager hardware replacement settings, optionally for a specific client.",
    schema({ client_id: str("Client id") }),
    (c, a) => c.lmAssets.getHardwareReplacementSettings(listParams(a))
  ),
  ro(
    "scalepad_lm_hardware_dashboard_get",
    "Get the Lifecycle Manager hardware dashboard summary, optionally filtered by client.",
    schema({ ...filters(["client_id"]) }),
    (c, a) => c.lmAssets.getHardwareDashboard(listParams(a))
  ),
  ro(
    "scalepad_lm_hardware_overview_get",
    "Get the detailed overview for a single hardware asset (by hardware_key, optionally scoped to a client).",
    schema(
      {
        hardware_key: str("Hardware asset key"),
        client_id: str("Client id the asset belongs to"),
      },
      ["hardware_key"]
    ),
    (c, a) => c.lmAssets.getHardwareOverview(pick(a, ["hardware_key", "client_id"]))
  ),
  ro(
    "scalepad_lm_hardware_list",
    "List Lifecycle Manager hardware assets (cursor-paginated; page_size 1-200, default 25). Searchable, client-scopable, and filterable by age, assigned end user, backup status, ScalePad warranty, initiative count, installed software, integration sources, manufacturer, memory, and processor.",
    schema({
      search: str("Search term to match asset names/serials"),
      client_id: str("Client id to scope assets to"),
      ...filters([
        "age",
        "assignedenduser",
        "configuredbackup",
        "hasscalepadwarranty",
        "initiativecount",
        "installedsoftware",
        "installedsoftwarecategory",
        "integrationsources",
        "manufacturer.name",
        "memory",
        "processor",
      ]),
      ...sortProp,
      ...paginationProps,
    }),
    (c, a) => c.lmAssets.listHardwareAssets(listParams(a)),
    {
      message:
        "No filters provided — this lists hardware across every client. Optionally enter a search term to narrow the results (leave empty to list all).",
      argName: "search",
    }
  ),
  ro(
    "scalepad_lm_hardware_lifecycles_list",
    "List active hardware lifecycle records (cursor-paginated), filterable by client_id and serial_number.",
    schema({
      ...filters(["client_id", "serial_number"]),
      ...paginationProps,
    }),
    (c, a) => c.lmAssets.listHardwareLifecycles(listParams(a))
  ),
  ro(
    "scalepad_lm_hardware_attached_initiatives_lookup",
    "List the initiatives a hardware asset is attached to (by hardware_key).",
    schema({ hardware_key: str("Hardware asset key") }, ["hardware_key"]),
    (c, a) =>
      c.lmAssets.lookupAttachedInitiatives({ hardware_key: req(a, "hardware_key") })
  ),
  ro(
    "scalepad_lm_hardware_attached_agreements_lookup",
    "List the agreements/contracts a hardware asset is attached to (by hardware_key).",
    schema({ hardware_key: str("Hardware asset key") }, ["hardware_key"]),
    (c, a) =>
      c.lmAssets.lookupAttachedAgreements({ hardware_key: req(a, "hardware_key") })
  ),

  // ── lmInitiatives ──────────────────────────────────────────────────────────
  ro(
    "scalepad_lm_roadmap_spreadsheet_generate",
    "Generate a roadmap spreadsheet (XLSX) for a client. Returns a binary payload; read-only export.",
    schema(
      {
        client_id: str("Client id"),
        roadmap_download_payload: obj(
          "Roadmap download options (columns, filters, grouping) per the ScalePad docs"
        ),
      },
      ["client_id"]
    ),
    (c, a) =>
      c.lmInitiatives.generateRoadmapSpreadsheet(
        pick(a, ["client_id", "roadmap_download_payload"])
      )
  ),
  ro(
    "scalepad_lm_roadmap_pdf_generate",
    "Generate a roadmap PDF for a client. Returns a binary payload; read-only export.",
    schema(
      {
        client_id: str("Client id"),
        roadmap_download_payload: obj(
          "Roadmap download options (columns, filters, grouping) per the ScalePad docs"
        ),
      },
      ["client_id"]
    ),
    (c, a) =>
      c.lmInitiatives.generateRoadmapPdf(
        pick(a, ["client_id", "roadmap_download_payload"])
      )
  ),
  ro(
    "scalepad_lm_roadmap_csv_generate",
    "Generate a roadmap CSV for a client. Returns a binary payload; read-only export.",
    schema(
      {
        client_id: str("Client id"),
        roadmap_download_payload: obj(
          "Roadmap download options (columns, filters, grouping) per the ScalePad docs"
        ),
      },
      ["client_id"]
    ),
    (c, a) =>
      c.lmInitiatives.generateRoadmapCsv(
        pick(a, ["client_id", "roadmap_download_payload"])
      )
  ),
  hi(
    "scalepad_lm_initiatives_status_update",
    "Update Initiative Status",
    true,
    "Update the status of a Lifecycle Manager initiative.",
    schema(
      {
        id: str("Initiative id"),
        status: str("New status value (e.g. not_scheduled, scheduled, completed)"),
      },
      ["id", "status"]
    ),
    (a) => `Set status of initiative ${String(a.id)} to "${String(a.status)}".`,
    (c, a) => c.lmInitiatives.updateStatus(req(a, "id"), { status: a.status as string })
  ),
  hi(
    "scalepad_lm_initiatives_schedule_update",
    "Schedule Initiative Fiscal Quarter",
    true,
    "Schedule a Lifecycle Manager initiative into a fiscal quarter.",
    schema(
      {
        id: str("Initiative id"),
        fiscal_quarter: freeform(
          "Fiscal quarter to schedule the initiative into (e.g. { year, quarter })"
        ),
      },
      ["id", "fiscal_quarter"]
    ),
    (a) => `Schedule initiative ${String(a.id)} into ${JSON.stringify(a.fiscal_quarter)}.`,
    (c, a) =>
      c.lmInitiatives.updateSchedule(req(a, "id"), { fiscal_quarter: a.fiscal_quarter })
  ),
  hi(
    "scalepad_lm_initiatives_recurring_update",
    "Update Initiative Recurring Investments",
    true,
    "Replace the recurring investment line items on a Lifecycle Manager initiative.",
    schema(
      {
        id: str("Initiative id"),
        recurring_line_items: arr("Recurring investment line items"),
      },
      ["id", "recurring_line_items"]
    ),
    (a) => `Replace recurring investments on initiative ${String(a.id)}.`,
    (c, a) =>
      c.lmInitiatives.updateRecurringInvestments(req(a, "id"), {
        recurring_line_items: a.recurring_line_items as unknown[],
      })
  ),
  hi(
    "scalepad_lm_initiatives_priority_update",
    "Update Initiative Priority",
    true,
    "Update the priority of a Lifecycle Manager initiative.",
    schema(
      {
        id: str("Initiative id"),
        priority: str("New priority value (e.g. low, medium, high)"),
      },
      ["id", "priority"]
    ),
    (a) => `Set priority of initiative ${String(a.id)} to "${String(a.priority)}".`,
    (c, a) => c.lmInitiatives.updatePriority(req(a, "id"), { priority: a.priority as string })
  ),
  hi(
    "scalepad_lm_initiatives_budget_update",
    "Update Initiative One-Time Investments",
    true,
    "Replace the one-time investment (budget) line items on a Lifecycle Manager initiative.",
    schema(
      {
        id: str("Initiative id"),
        budget_line_items: arr("One-time investment (budget) line items"),
      },
      ["id", "budget_line_items"]
    ),
    (a) => `Replace one-time investments on initiative ${String(a.id)}.`,
    (c, a) =>
      c.lmInitiatives.updateOneTimeInvestments(req(a, "id"), {
        budget_line_items: a.budget_line_items as unknown[],
      })
  ),
  hi(
    "scalepad_lm_initiatives_assigned_user_update",
    "Update Initiative Assigned User",
    true,
    "Assign a Lifecycle Manager initiative to a user.",
    schema(
      {
        initiative_id: str("Initiative id"),
        assigned_user_id: str("User id to assign"),
      },
      ["initiative_id", "assigned_user_id"]
    ),
    (a) =>
      `Assign initiative ${String(a.initiative_id)} to user ${String(a.assigned_user_id)}.`,
    (c, a) =>
      c.lmInitiatives.updateAssignedUser(req(a, "initiative_id"), {
        assigned_user_id: a.assigned_user_id as string,
      })
  ),
  ro(
    "scalepad_lm_initiatives_ticket_get",
    "Get the linked PSA ticket state for a Lifecycle Manager initiative.",
    schema({ initiative_id: str("Initiative id") }, ["initiative_id"]),
    (c, a) => c.lmInitiatives.getTicket(req(a, "initiative_id"))
  ),
  hi(
    "scalepad_lm_initiatives_ticket_create",
    "Create and Link Initiative Ticket",
    false,
    "Create a PSA ticket and link it to a Lifecycle Manager initiative. Use scalepad_lm_ticket_create_fields_get for the available field definitions.",
    schema(
      {
        initiative_id: str("Initiative id"),
        field_values: freeform("PSA ticket field values (per the ticket create-fields)"),
      },
      ["initiative_id", "field_values"]
    ),
    (a) => `Create and link a PSA ticket to initiative ${String(a.initiative_id)}.`,
    (c, a) =>
      c.lmInitiatives.createTicket(req(a, "initiative_id"), {
        field_values: a.field_values,
      })
  ),
  hi(
    "scalepad_lm_initiatives_ticket_detach",
    "Detach Initiative Ticket",
    true,
    "Detach the PSA ticket linked to a Lifecycle Manager initiative (the ticket itself is not deleted).",
    schema({ initiative_id: str("Initiative id") }, ["initiative_id"]),
    (a) => `Detach the linked PSA ticket from initiative ${String(a.initiative_id)}.`,
    (c, a) => c.lmInitiatives.detachTicket(req(a, "initiative_id"))
  ),
  hi(
    "scalepad_lm_initiative_templates_duplicate",
    "Duplicate Initiative Template",
    false,
    "Duplicate a Lifecycle Manager initiative template (creates a new template copy).",
    schema({ initiative_template_id: str("Initiative template id") }, [
      "initiative_template_id",
    ]),
    (a) => `Duplicate initiative template ${String(a.initiative_template_id)}.`,
    (c, a) => c.lmInitiatives.duplicateTemplate(req(a, "initiative_template_id"))
  ),
  ro(
    "scalepad_lm_initiative_templates_get",
    "Get a Lifecycle Manager initiative template by id.",
    schema({ initiative_template_id: str("Initiative template id") }, [
      "initiative_template_id",
    ]),
    (c, a) => c.lmInitiatives.getTemplate(req(a, "initiative_template_id"))
  ),
  hi(
    "scalepad_lm_initiative_templates_update",
    "Update Initiative Template",
    true,
    "Update a Lifecycle Manager initiative template.",
    schema(
      {
        initiative_template_id: str("Initiative template id"),
        initiative_template: obj("The updated initiative template payload"),
      },
      ["initiative_template_id", "initiative_template"]
    ),
    (a) => `Update initiative template ${String(a.initiative_template_id)}.`,
    (c, a) =>
      c.lmInitiatives.updateTemplate(req(a, "initiative_template_id"), {
        initiative_template: a.initiative_template as Record<string, unknown>,
      })
  ),
  irrev(
    "scalepad_lm_initiative_templates_delete",
    "Delete Initiative Template",
    true,
    "Permanently delete a Lifecycle Manager initiative template.",
    schema({ initiative_template_id: str("Initiative template id") }, [
      "initiative_template_id",
    ]),
    (a) => `Permanently delete initiative template ${String(a.initiative_template_id)}.`,
    (c, a) => c.lmInitiatives.deleteTemplate(req(a, "initiative_template_id"))
  ),
  ro(
    "scalepad_lm_initiative_templates_list",
    "List Lifecycle Manager initiative templates (cursor-paginated; page_size 1-200, default 25).",
    schema({ ...paginationProps }),
    (c, a) => c.lmInitiatives.listTemplates(listParams(a))
  ),
  hi(
    "scalepad_lm_initiative_templates_create",
    "Create Initiative Template",
    false,
    "Create a new Lifecycle Manager initiative template.",
    schema({ initiative_template: obj("The initiative template payload") }, [
      "initiative_template",
    ]),
    () => "Create a new initiative template.",
    (c, a) =>
      c.lmInitiatives.createTemplate({ initiative_template: a.initiative_template as Record<string, unknown> })
  ),
  hi(
    "scalepad_lm_initiatives_template_apply",
    "Apply Initiative Template",
    false,
    "Apply an initiative template to an existing Lifecycle Manager initiative (overwrites templated fields).",
    schema(
      {
        initiative_id: str("Initiative id"),
        initiative_template_id: str("Initiative template id to apply"),
      },
      ["initiative_id", "initiative_template_id"]
    ),
    (a) =>
      `Apply template ${String(a.initiative_template_id)} to initiative ${String(a.initiative_id)}.`,
    (c, a) =>
      c.lmInitiatives.applyTemplate(
        req(a, "initiative_id"),
        req(a, "initiative_template_id")
      )
  ),
  ro(
    "scalepad_lm_initiatives_quotes_list",
    "List the Quoter quotes attached to a Lifecycle Manager initiative.",
    schema({ initiative_id: str("Initiative id") }, ["initiative_id"]),
    (c, a) => c.lmInitiatives.listQuotes(req(a, "initiative_id"))
  ),
  ro(
    "scalepad_lm_initiatives_pdf_get",
    "Download a Lifecycle Manager initiative as a PDF. Returns a binary payload; read-only export.",
    schema({ initiative_id: str("Initiative id") }, ["initiative_id"]),
    (c, a) => c.lmInitiatives.downloadPdf(req(a, "initiative_id"))
  ),
  ro(
    "scalepad_lm_initiatives_opportunity_get",
    "Get the PSA opportunity linked to a Lifecycle Manager initiative.",
    schema({ initiative_id: str("Initiative id") }, ["initiative_id"]),
    (c, a) => c.lmInitiatives.getOpportunity(req(a, "initiative_id"))
  ),
  hi(
    "scalepad_lm_initiatives_opportunity_create",
    "Create Initiative Opportunity",
    false,
    "Create a PSA opportunity and link it to a Lifecycle Manager initiative. Use scalepad_lm_opportunity_create_fields_get for the available field definitions.",
    schema(
      {
        initiative_id: str("Initiative id"),
        field_values: freeform(
          "PSA opportunity field values (per the opportunity create-fields)"
        ),
      },
      ["initiative_id", "field_values"]
    ),
    (a) => `Create and link a PSA opportunity to initiative ${String(a.initiative_id)}.`,
    (c, a) =>
      c.lmInitiatives.createOpportunity(req(a, "initiative_id"), {
        field_values: a.field_values,
      })
  ),
  irrev(
    "scalepad_lm_initiatives_opportunity_delete",
    "Delete Initiative Opportunity",
    true,
    "Delete the PSA opportunity linked to a Lifecycle Manager initiative.",
    schema({ initiative_id: str("Initiative id") }, ["initiative_id"]),
    (a) => `Delete the linked opportunity of initiative ${String(a.initiative_id)}.`,
    (c, a) => c.lmInitiatives.deleteOpportunity(req(a, "initiative_id"))
  ),
  hi(
    "scalepad_lm_initiatives_opportunity_attach",
    "Attach Initiative Opportunity",
    true,
    "Attach an existing PSA opportunity to a Lifecycle Manager initiative.",
    schema(
      {
        initiative_id: str("Initiative id"),
        opportunity_id: str("Opportunity id to attach"),
      },
      ["initiative_id", "opportunity_id"]
    ),
    (a) =>
      `Attach opportunity ${String(a.opportunity_id)} to initiative ${String(a.initiative_id)}.`,
    (c, a) =>
      c.lmInitiatives.attachOpportunity(req(a, "initiative_id"), req(a, "opportunity_id"))
  ),
  ro(
    "scalepad_lm_initiatives_meetings_list",
    "List the meetings attached to a Lifecycle Manager initiative.",
    schema({ initiative_id: str("Initiative id") }, ["initiative_id"]),
    (c, a) => c.lmInitiatives.listMeetings(req(a, "initiative_id"))
  ),
  hi(
    "scalepad_lm_initiatives_meetings_attach",
    "Attach Meeting to Initiative",
    true,
    "Attach a meeting to a Lifecycle Manager initiative.",
    schema(
      {
        initiative_id: str("Initiative id"),
        meeting_id: str("Meeting id to attach"),
      },
      ["initiative_id", "meeting_id"]
    ),
    (a) => `Attach meeting ${String(a.meeting_id)} to initiative ${String(a.initiative_id)}.`,
    (c, a) =>
      c.lmInitiatives.attachMeeting(req(a, "initiative_id"), req(a, "meeting_id"))
  ),
  hi(
    "scalepad_lm_initiatives_meetings_detach",
    "Detach Meeting from Initiative",
    true,
    "Detach a meeting from a Lifecycle Manager initiative (the meeting itself is not deleted).",
    schema(
      {
        initiative_id: str("Initiative id"),
        meeting_id: str("Meeting id to detach"),
      },
      ["initiative_id", "meeting_id"]
    ),
    (a) =>
      `Detach meeting ${String(a.meeting_id)} from initiative ${String(a.initiative_id)}.`,
    (c, a) =>
      c.lmInitiatives.detachMeeting(req(a, "initiative_id"), req(a, "meeting_id"))
  ),
  ro(
    "scalepad_lm_initiatives_list_v2",
    "List Lifecycle Manager initiatives via the v2 endpoint (cursor-paginated; page_size 1-200, default 25). Filterable by client, status, priority, schedule, assigned user, and created/updated timestamps.",
    schema({
      ...filters([
        "client.id",
        "status",
        "priority",
        "scheduled",
        "scheduled_period",
        "assigned_user_id",
        "created_at",
        "updated_at",
      ]),
      ...paginationProps,
    }),
    (c, a) => c.lmInitiatives.listV2(listParams(a)),
    {
      message:
        "No filters provided — this lists initiatives across every client. Optionally enter a client id to narrow the results (leave empty to list all).",
      argName: "client.id",
      isFilterKey: true,
    }
  ),
  ro(
    "scalepad_lm_initiatives_goals_list",
    "List the goals attached to a Lifecycle Manager initiative.",
    schema({ initiative_id: str("Initiative id") }, ["initiative_id"]),
    (c, a) => c.lmInitiatives.listGoals(req(a, "initiative_id"))
  ),
  hi(
    "scalepad_lm_initiatives_goals_attach",
    "Attach Goal to Initiative",
    true,
    "Attach a goal to a Lifecycle Manager initiative.",
    schema(
      {
        initiative_id: str("Initiative id"),
        goal_id: str("Goal id to attach"),
      },
      ["initiative_id", "goal_id"]
    ),
    (a) => `Attach goal ${String(a.goal_id)} to initiative ${String(a.initiative_id)}.`,
    (c, a) => c.lmInitiatives.attachGoal(req(a, "initiative_id"), req(a, "goal_id"))
  ),
  hi(
    "scalepad_lm_initiatives_goals_detach",
    "Detach Goal from Initiative",
    true,
    "Detach a goal from a Lifecycle Manager initiative (the goal itself is not deleted).",
    schema(
      {
        initiative_id: str("Initiative id"),
        goal_id: str("Goal id to detach"),
      },
      ["initiative_id", "goal_id"]
    ),
    (a) => `Detach goal ${String(a.goal_id)} from initiative ${String(a.initiative_id)}.`,
    (c, a) => c.lmInitiatives.detachGoal(req(a, "initiative_id"), req(a, "goal_id"))
  ),
  ro(
    "scalepad_lm_initiatives_get",
    "Get a Lifecycle Manager initiative by id.",
    idSchema("Initiative id"),
    (c, a) => c.lmInitiatives.get(req(a, "id"))
  ),
  hi(
    "scalepad_lm_initiatives_update",
    "Update Initiative",
    true,
    "Update a Lifecycle Manager initiative's name and executive summary.",
    schema(
      {
        id: str("Initiative id"),
        name: str("New initiative name"),
        executive_summary: str("Executive summary (plain text)"),
        executive_summary_json: freeform("Executive summary (rich-text JSON)"),
      },
      ["id"]
    ),
    (a) => `Update initiative ${String(a.id)}.`,
    (c, a) =>
      c.lmInitiatives.update(
        req(a, "id"),
        pick(a, ["name", "executive_summary", "executive_summary_json"])
      )
  ),
  irrev(
    "scalepad_lm_initiatives_delete",
    "Delete Initiative",
    true,
    "Permanently delete a Lifecycle Manager initiative.",
    idSchema("Initiative id"),
    (a) => `Permanently delete initiative ${String(a.id)}.`,
    (c, a) => c.lmInitiatives.delete(req(a, "id"))
  ),
  ro(
    "scalepad_lm_initiatives_list",
    "List Lifecycle Manager initiatives (cursor-paginated; page_size 1-200, default 25). Filterable by client, status, priority, schedule, assigned user, and created/updated timestamps.",
    schema({
      ...filters([
        "client.id",
        "status",
        "priority",
        "scheduled",
        "scheduled_period",
        "assigned_user_id",
        "created_at",
        "updated_at",
      ]),
      ...paginationProps,
    }),
    (c, a) => c.lmInitiatives.list(listParams(a)),
    {
      message:
        "No filters provided — this lists initiatives across every client. Optionally enter a client id to narrow the results (leave empty to list all).",
      argName: "client.id",
      isFilterKey: true,
    }
  ),
  hi(
    "scalepad_lm_initiatives_create",
    "Create Initiative",
    false,
    "Create a new Lifecycle Manager initiative for a client.",
    schema(
      {
        client_key: str("Client key (from clients lookup)"),
        name: str("Initiative name"),
        executive_summary: str("Executive summary (plain text)"),
        executive_summary_json: freeform("Executive summary (rich-text JSON)"),
      },
      ["client_key", "name"]
    ),
    (a) => `Create initiative "${String(a.name)}" for client ${String(a.client_key)}.`,
    (c, a) =>
      c.lmInitiatives.create(
        pick(a, ["client_key", "name", "executive_summary", "executive_summary_json"])
      )
  ),
  hi(
    "scalepad_lm_initiatives_assets_detach",
    "Detach Assets from Initiative",
    true,
    "Detach hardware assets from a Lifecycle Manager initiative (the assets themselves are not deleted).",
    schema(
      {
        initiative_id: str("Initiative id"),
        hardware_keys: strArr("Hardware asset keys to detach"),
      },
      ["initiative_id", "hardware_keys"]
    ),
    (a) => `Detach hardware assets from initiative ${String(a.initiative_id)}.`,
    (c, a) =>
      c.lmInitiatives.detachAssets(req(a, "initiative_id"), {
        hardware_keys: a.hardware_keys as string[],
      })
  ),
  hi(
    "scalepad_lm_initiatives_assets_attach",
    "Attach Assets to Initiative",
    true,
    "Attach hardware assets to a Lifecycle Manager initiative.",
    schema(
      {
        initiative_id: str("Initiative id"),
        hardware_keys: strArr("Hardware asset keys to attach"),
      },
      ["initiative_id", "hardware_keys"]
    ),
    (a) => `Attach hardware assets to initiative ${String(a.initiative_id)}.`,
    (c, a) =>
      c.lmInitiatives.attachAssets(req(a, "initiative_id"), {
        hardware_keys: a.hardware_keys as string[],
      })
  ),
  ro(
    "scalepad_lm_initiatives_action_items_list",
    "List the action items attached to a Lifecycle Manager initiative.",
    schema({ initiative_id: str("Initiative id") }, ["initiative_id"]),
    (c, a) => c.lmInitiatives.listActionItems(req(a, "initiative_id"))
  ),
  hi(
    "scalepad_lm_initiatives_action_items_attach",
    "Attach Action Item to Initiative",
    true,
    "Attach an action item to a Lifecycle Manager initiative.",
    schema(
      {
        initiative_id: str("Initiative id"),
        action_item_id: str("Action item id to attach"),
      },
      ["initiative_id", "action_item_id"]
    ),
    (a) =>
      `Attach action item ${String(a.action_item_id)} to initiative ${String(a.initiative_id)}.`,
    (c, a) =>
      c.lmInitiatives.attachActionItem(req(a, "initiative_id"), req(a, "action_item_id"))
  ),
  hi(
    "scalepad_lm_initiatives_action_items_detach",
    "Detach Action Item from Initiative",
    true,
    "Detach an action item from a Lifecycle Manager initiative (the action item itself is not deleted).",
    schema(
      {
        initiative_id: str("Initiative id"),
        action_item_id: str("Action item id to detach"),
      },
      ["initiative_id", "action_item_id"]
    ),
    (a) =>
      `Detach action item ${String(a.action_item_id)} from initiative ${String(a.initiative_id)}.`,
    (c, a) =>
      c.lmInitiatives.detachActionItem(req(a, "initiative_id"), req(a, "action_item_id"))
  ),

  // ── lmGoals ────────────────────────────────────────────────────────────────
  ro(
    "scalepad_lm_goal_templates_get",
    "Get a Lifecycle Manager goal template by id.",
    schema({ goal_template_id: str("Goal template id") }, ["goal_template_id"]),
    (c, a) => c.lmGoals.getTemplate(req(a, "goal_template_id"))
  ),
  hi(
    "scalepad_lm_goal_templates_update",
    "Update Goal Template",
    true,
    "Update a Lifecycle Manager goal template.",
    schema(
      {
        goal_template_id: str("Goal template id"),
        goal_template: obj("The updated goal template payload"),
      },
      ["goal_template_id", "goal_template"]
    ),
    (a) => `Update goal template ${String(a.goal_template_id)}.`,
    (c, a) =>
      c.lmGoals.updateTemplate(req(a, "goal_template_id"), {
        goal_template: a.goal_template as Record<string, unknown>,
      })
  ),
  irrev(
    "scalepad_lm_goal_templates_delete",
    "Delete Goal Template",
    true,
    "Permanently delete a Lifecycle Manager goal template.",
    schema({ goal_template_id: str("Goal template id") }, ["goal_template_id"]),
    (a) => `Permanently delete goal template ${String(a.goal_template_id)}.`,
    (c, a) => c.lmGoals.deleteTemplate(req(a, "goal_template_id"))
  ),
  ro(
    "scalepad_lm_goal_templates_list",
    "List Lifecycle Manager goal templates, filterable by title.",
    schema({ ...filters(["title"]) }),
    (c, a) => c.lmGoals.listTemplates(listParams(a))
  ),
  hi(
    "scalepad_lm_goal_templates_create",
    "Create Goal Template",
    false,
    "Create a new Lifecycle Manager goal template.",
    schema({ goal_template: obj("The goal template payload") }, ["goal_template"]),
    () => "Create a new goal template.",
    (c, a) => c.lmGoals.createTemplate({ goal_template: a.goal_template as Record<string, unknown> })
  ),
  hi(
    "scalepad_lm_goals_status_update",
    "Update Goal Status",
    true,
    "Update the status of a Lifecycle Manager goal.",
    schema(
      {
        id: str("Goal id"),
        status: str("New status value"),
      },
      ["id", "status"]
    ),
    (a) => `Set status of goal ${String(a.id)} to "${String(a.status)}".`,
    (c, a) => c.lmGoals.updateStatus(req(a, "id"), { status: a.status as string })
  ),
  hi(
    "scalepad_lm_goals_schedule_update",
    "Update Goal Schedule",
    true,
    "Update the target period (schedule) of a Lifecycle Manager goal.",
    schema(
      {
        id: str("Goal id"),
        target_period: freeform(
          "Target period for the goal (e.g. { year, quarter } or { year, half })"
        ),
      },
      ["id", "target_period"]
    ),
    (a) => `Reschedule goal ${String(a.id)} to ${JSON.stringify(a.target_period)}.`,
    (c, a) => c.lmGoals.updateSchedule(req(a, "id"), { target_period: a.target_period })
  ),
  ro(
    "scalepad_lm_goals_meetings_list",
    "List the meetings attached to a Lifecycle Manager goal.",
    schema({ goal_id: str("Goal id") }, ["goal_id"]),
    (c, a) => c.lmGoals.listMeetings(req(a, "goal_id"))
  ),
  hi(
    "scalepad_lm_goals_meetings_attach",
    "Attach Meeting to Goal",
    true,
    "Attach a meeting to a Lifecycle Manager goal.",
    schema(
      {
        goal_id: str("Goal id"),
        meeting_id: str("Meeting id to attach"),
      },
      ["goal_id", "meeting_id"]
    ),
    (a) => `Attach meeting ${String(a.meeting_id)} to goal ${String(a.goal_id)}.`,
    (c, a) => c.lmGoals.attachMeeting(req(a, "goal_id"), req(a, "meeting_id"))
  ),
  hi(
    "scalepad_lm_goals_meetings_detach",
    "Detach Meeting from Goal",
    true,
    "Detach a meeting from a Lifecycle Manager goal (the meeting itself is not deleted).",
    schema(
      {
        goal_id: str("Goal id"),
        meeting_id: str("Meeting id to detach"),
      },
      ["goal_id", "meeting_id"]
    ),
    (a) => `Detach meeting ${String(a.meeting_id)} from goal ${String(a.goal_id)}.`,
    (c, a) => c.lmGoals.detachMeeting(req(a, "goal_id"), req(a, "meeting_id"))
  ),
  ro(
    "scalepad_lm_goals_initiatives_list",
    "List the initiatives attached to a Lifecycle Manager goal.",
    schema({ goal_id: str("Goal id") }, ["goal_id"]),
    (c, a) => c.lmGoals.listInitiatives(req(a, "goal_id"))
  ),
  hi(
    "scalepad_lm_goals_initiatives_attach",
    "Attach Initiative to Goal",
    true,
    "Attach an initiative to a Lifecycle Manager goal.",
    schema(
      {
        goal_id: str("Goal id"),
        initiative_id: str("Initiative id to attach"),
      },
      ["goal_id", "initiative_id"]
    ),
    (a) => `Attach initiative ${String(a.initiative_id)} to goal ${String(a.goal_id)}.`,
    (c, a) => c.lmGoals.attachInitiative(req(a, "goal_id"), req(a, "initiative_id"))
  ),
  hi(
    "scalepad_lm_goals_initiatives_detach",
    "Detach Initiative from Goal",
    true,
    "Detach an initiative from a Lifecycle Manager goal (the initiative itself is not deleted).",
    schema(
      {
        goal_id: str("Goal id"),
        initiative_id: str("Initiative id to detach"),
      },
      ["goal_id", "initiative_id"]
    ),
    (a) => `Detach initiative ${String(a.initiative_id)} from goal ${String(a.goal_id)}.`,
    (c, a) => c.lmGoals.detachInitiative(req(a, "goal_id"), req(a, "initiative_id"))
  ),
  ro(
    "scalepad_lm_goals_get",
    "Get a Lifecycle Manager goal by id.",
    idSchema("Goal id"),
    (c, a) => c.lmGoals.get(req(a, "id"))
  ),
  hi(
    "scalepad_lm_goals_update",
    "Update Goal",
    true,
    "Update a Lifecycle Manager goal (title, description, status, target period).",
    schema(
      {
        id: str("Goal id"),
        title: str("New goal title"),
        description: str("Goal description (plain text)"),
        description_json: freeform("Goal description (rich-text JSON)"),
        status: str("Goal status"),
        target_period: freeform("Target period (e.g. { year, quarter })"),
      },
      ["id"]
    ),
    (a) => `Update goal ${String(a.id)}.`,
    (c, a) =>
      c.lmGoals.update(
        req(a, "id"),
        pick(a, ["title", "description", "description_json", "status", "target_period"])
      )
  ),
  irrev(
    "scalepad_lm_goals_delete",
    "Delete Goal",
    true,
    "Permanently delete a Lifecycle Manager goal.",
    idSchema("Goal id"),
    (a) => `Permanently delete goal ${String(a.id)}.`,
    (c, a) => c.lmGoals.delete(req(a, "id"))
  ),
  hi(
    "scalepad_lm_goals_create_from_template",
    "Create Goal from Template",
    false,
    "Create a new Lifecycle Manager goal from a goal template.",
    schema(
      {
        goal_template_id: str("Goal template id"),
        title: str("Goal title"),
        client_key: str("Client key (from clients lookup)"),
      },
      ["goal_template_id", "client_key"]
    ),
    (a) =>
      `Create a goal from template ${String(a.goal_template_id)} for client ${String(a.client_key)}.`,
    (c, a) =>
      c.lmGoals.createFromTemplate(
        req(a, "goal_template_id"),
        pick(a, ["title", "client_key"])
      )
  ),
  ro(
    "scalepad_lm_goals_list",
    "List Lifecycle Manager goals (cursor-paginated; page_size 1-200, default 25). Filterable by client, title, status, and target period (year/half/quarter).",
    schema({
      ...filters([
        "client.id",
        "title",
        "status",
        "period.year",
        "period.half",
        "period.quarter",
      ]),
      ...sortProp,
      ...paginationProps,
    }),
    (c, a) => c.lmGoals.list(listParams(a)),
    {
      message:
        "No filters provided — this lists goals across every client. Optionally enter a client id to narrow the results (leave empty to list all).",
      argName: "client.id",
      isFilterKey: true,
    }
  ),
  hi(
    "scalepad_lm_goals_create",
    "Create Goal",
    false,
    "Create a new Lifecycle Manager goal for a client.",
    schema(
      {
        client_key: str("Client key (from clients lookup)"),
        title: str("Goal title"),
        description: str("Goal description (plain text)"),
        status: str("Initial goal status"),
        target_period: freeform("Target period (e.g. { year, quarter })"),
      },
      ["client_key", "title"]
    ),
    (a) => `Create goal "${String(a.title)}" for client ${String(a.client_key)}.`,
    (c, a) =>
      c.lmGoals.create(
        pick(a, ["client_key", "title", "description", "status", "target_period"])
      )
  ),
  ro(
    "scalepad_lm_goals_action_items_list",
    "List the action items attached to a Lifecycle Manager goal.",
    schema({ goal_id: str("Goal id") }, ["goal_id"]),
    (c, a) => c.lmGoals.listActionItems(req(a, "goal_id"))
  ),
  hi(
    "scalepad_lm_goals_action_items_attach",
    "Attach Action Item to Goal",
    true,
    "Attach an action item to a Lifecycle Manager goal.",
    schema(
      {
        goal_id: str("Goal id"),
        action_item_id: str("Action item id to attach"),
      },
      ["goal_id", "action_item_id"]
    ),
    (a) => `Attach action item ${String(a.action_item_id)} to goal ${String(a.goal_id)}.`,
    (c, a) => c.lmGoals.attachActionItem(req(a, "goal_id"), req(a, "action_item_id"))
  ),
  hi(
    "scalepad_lm_goals_action_items_detach",
    "Detach Action Item from Goal",
    true,
    "Detach an action item from a Lifecycle Manager goal (the action item itself is not deleted).",
    schema(
      {
        goal_id: str("Goal id"),
        action_item_id: str("Action item id to detach"),
      },
      ["goal_id", "action_item_id"]
    ),
    (a) =>
      `Detach action item ${String(a.action_item_id)} from goal ${String(a.goal_id)}.`,
    (c, a) => c.lmGoals.detachActionItem(req(a, "goal_id"), req(a, "action_item_id"))
  ),

  // ── lmMeetings ─────────────────────────────────────────────────────────────
  hi(
    "scalepad_lm_meetings_update_v2",
    "Update Meeting (v2)",
    true,
    "Update a Lifecycle Manager meeting via the v2 endpoint (title, type, start/end, agenda).",
    schema(
      {
        id: str("Meeting id"),
        title: str("Meeting title"),
        type: str("Meeting type"),
        starts_at: str("Start time (ISO 8601)"),
        ends_at: str("End time (ISO 8601)"),
        agenda_json: freeform("Meeting agenda (rich-text JSON)"),
      },
      ["id"]
    ),
    (a) => `Update meeting ${String(a.id)} (v2).`,
    (c, a) =>
      c.lmMeetings.updateV2(
        req(a, "id"),
        pick(a, ["title", "type", "starts_at", "ends_at", "agenda_json"])
      )
  ),
  hi(
    "scalepad_lm_meeting_types_update",
    "Update Meeting Type",
    true,
    "Rename a Lifecycle Manager meeting type.",
    schema(
      {
        meeting_type_id: str("Meeting type id"),
        label: str("New meeting type label"),
      },
      ["meeting_type_id", "label"]
    ),
    (a) =>
      `Rename meeting type ${String(a.meeting_type_id)} to "${String(a.label)}".`,
    (c, a) => c.lmMeetings.updateMeetingType(req(a, "meeting_type_id"), { label: a.label as string })
  ),
  irrev(
    "scalepad_lm_meeting_types_delete",
    "Delete Meeting Type",
    true,
    "Permanently delete a Lifecycle Manager meeting type.",
    schema({ meeting_type_id: str("Meeting type id") }, ["meeting_type_id"]),
    (a) => `Permanently delete meeting type ${String(a.meeting_type_id)}.`,
    (c, a) => c.lmMeetings.deleteMeetingType(req(a, "meeting_type_id"))
  ),
  ro(
    "scalepad_lm_meeting_types_list",
    "List Lifecycle Manager meeting types (no filters or pagination).",
    schema({}),
    (c) => c.lmMeetings.listMeetingTypes()
  ),
  hi(
    "scalepad_lm_meeting_types_create",
    "Create Meeting Type",
    false,
    "Create a new Lifecycle Manager meeting type.",
    schema({ label: str("Meeting type label") }, ["label"]),
    (a) => `Create meeting type "${String(a.label)}".`,
    (c, a) => c.lmMeetings.createMeetingType({ label: a.label as string })
  ),
  ro(
    "scalepad_lm_meetings_initiatives_list",
    "List the initiatives attached to a Lifecycle Manager meeting.",
    schema({ meeting_id: str("Meeting id") }, ["meeting_id"]),
    (c, a) => c.lmMeetings.listInitiatives(req(a, "meeting_id"))
  ),
  hi(
    "scalepad_lm_meetings_initiatives_attach",
    "Attach Initiative to Meeting",
    true,
    "Attach an initiative to a Lifecycle Manager meeting.",
    schema(
      {
        meeting_id: str("Meeting id"),
        initiative_id: str("Initiative id to attach"),
      },
      ["meeting_id", "initiative_id"]
    ),
    (a) =>
      `Attach initiative ${String(a.initiative_id)} to meeting ${String(a.meeting_id)}.`,
    (c, a) =>
      c.lmMeetings.attachInitiative(req(a, "meeting_id"), req(a, "initiative_id"))
  ),
  hi(
    "scalepad_lm_meetings_initiatives_detach",
    "Detach Initiative from Meeting",
    true,
    "Detach an initiative from a Lifecycle Manager meeting (the initiative itself is not deleted).",
    schema(
      {
        meeting_id: str("Meeting id"),
        initiative_id: str("Initiative id to detach"),
      },
      ["meeting_id", "initiative_id"]
    ),
    (a) =>
      `Detach initiative ${String(a.initiative_id)} from meeting ${String(a.meeting_id)}.`,
    (c, a) =>
      c.lmMeetings.detachInitiative(req(a, "meeting_id"), req(a, "initiative_id"))
  ),
  ro(
    "scalepad_lm_meetings_goals_list",
    "List the goals attached to a Lifecycle Manager meeting.",
    schema({ meeting_id: str("Meeting id") }, ["meeting_id"]),
    (c, a) => c.lmMeetings.listGoals(req(a, "meeting_id"))
  ),
  hi(
    "scalepad_lm_meetings_goals_attach",
    "Attach Goal to Meeting",
    true,
    "Attach a goal to a Lifecycle Manager meeting.",
    schema(
      {
        meeting_id: str("Meeting id"),
        goal_id: str("Goal id to attach"),
      },
      ["meeting_id", "goal_id"]
    ),
    (a) => `Attach goal ${String(a.goal_id)} to meeting ${String(a.meeting_id)}.`,
    (c, a) => c.lmMeetings.attachGoal(req(a, "meeting_id"), req(a, "goal_id"))
  ),
  hi(
    "scalepad_lm_meetings_goals_detach",
    "Detach Goal from Meeting",
    true,
    "Detach a goal from a Lifecycle Manager meeting (the goal itself is not deleted).",
    schema(
      {
        meeting_id: str("Meeting id"),
        goal_id: str("Goal id to detach"),
      },
      ["meeting_id", "goal_id"]
    ),
    (a) => `Detach goal ${String(a.goal_id)} from meeting ${String(a.meeting_id)}.`,
    (c, a) => c.lmMeetings.detachGoal(req(a, "meeting_id"), req(a, "goal_id"))
  ),
  ro(
    "scalepad_lm_meetings_get",
    "Get a Lifecycle Manager meeting by id.",
    idSchema("Meeting id"),
    (c, a) => c.lmMeetings.get(req(a, "id"))
  ),
  hi(
    "scalepad_lm_meetings_update",
    "Update Meeting",
    true,
    "Update a Lifecycle Manager meeting via the v1 endpoint (title, type, start/end, agenda). Prefer scalepad_lm_meetings_update_v2.",
    schema(
      {
        id: str("Meeting id"),
        title: str("Meeting title"),
        type: str("Meeting type"),
        starts_at: str("Start time (ISO 8601)"),
        ends_at: str("End time (ISO 8601)"),
        agenda_json: freeform("Meeting agenda (rich-text JSON)"),
      },
      ["id"]
    ),
    (a) => `Update meeting ${String(a.id)}.`,
    (c, a) =>
      c.lmMeetings.update(
        req(a, "id"),
        pick(a, ["title", "type", "starts_at", "ends_at", "agenda_json"])
      )
  ),
  irrev(
    "scalepad_lm_meetings_delete",
    "Delete Meeting",
    true,
    "Permanently delete a Lifecycle Manager meeting.",
    idSchema("Meeting id"),
    (a) => `Permanently delete meeting ${String(a.id)}.`,
    (c, a) => c.lmMeetings.delete(req(a, "id"))
  ),
  hi(
    "scalepad_lm_meetings_create_v2",
    "Create Meeting (v2)",
    false,
    "Create a new Lifecycle Manager meeting via the v2 endpoint.",
    schema(
      {
        client_key: str("Client key (from clients lookup)"),
        title: str("Meeting title"),
        type: str("Meeting type"),
        starts_at: str("Start time (ISO 8601)"),
        ends_at: str("End time (ISO 8601)"),
        agenda_json: freeform("Meeting agenda (rich-text JSON)"),
      },
      ["client_key", "title"]
    ),
    (a) => `Create meeting "${String(a.title)}" for client ${String(a.client_key)} (v2).`,
    (c, a) =>
      c.lmMeetings.createV2(
        pick(a, ["client_key", "title", "type", "starts_at", "ends_at", "agenda_json"])
      )
  ),
  ro(
    "scalepad_lm_meetings_list",
    "List Lifecycle Manager meetings (cursor-paginated; page_size 1-200, default 25), filterable by client.",
    schema({
      ...filters(["client.id"]),
      ...paginationProps,
    }),
    (c, a) => c.lmMeetings.list(listParams(a)),
    {
      message:
        "No filters provided — this lists meetings across every client. Optionally enter a client id to narrow the results (leave empty to list all).",
      argName: "client.id",
      isFilterKey: true,
    }
  ),
  hi(
    "scalepad_lm_meetings_create",
    "Create Meeting",
    false,
    "Create a new Lifecycle Manager meeting via the v1 endpoint. Prefer scalepad_lm_meetings_create_v2.",
    schema(
      {
        client_key: str("Client key (from clients lookup)"),
        title: str("Meeting title"),
        type: str("Meeting type"),
        starts_at: str("Start time (ISO 8601)"),
        ends_at: str("End time (ISO 8601)"),
        agenda_json: freeform("Meeting agenda (rich-text JSON)"),
      },
      ["client_key", "title"]
    ),
    (a) => `Create meeting "${String(a.title)}" for client ${String(a.client_key)}.`,
    (c, a) =>
      c.lmMeetings.create(
        pick(a, ["client_key", "title", "type", "starts_at", "ends_at", "agenda_json"])
      )
  ),
  hi(
    "scalepad_lm_meetings_completion_status_update",
    "Update Meeting Completion Status",
    true,
    "Mark a Lifecycle Manager meeting completed or not completed.",
    schema(
      {
        id: str("Meeting id"),
        is_completed: bool("true to mark completed, false to reopen"),
      },
      ["id", "is_completed"]
    ),
    (a) => `Set is_completed=${String(a.is_completed)} on meeting ${String(a.id)}.`,
    (c, a) =>
      c.lmMeetings.updateCompletionStatus(req(a, "id"), {
        is_completed: a.is_completed as boolean,
      })
  ),
  hi(
    "scalepad_lm_meetings_user_attendees_remove",
    "Remove Meeting User Attendees",
    true,
    "Remove user attendees from a Lifecycle Manager meeting.",
    schema(
      {
        id: str("Meeting id"),
        user_keys: strArr("User keys to remove"),
      },
      ["id", "user_keys"]
    ),
    (a) => `Remove user attendees from meeting ${String(a.id)}.`,
    (c, a) => c.lmMeetings.removeUserAttendees(req(a, "id"), { user_keys: a.user_keys as string[] })
  ),
  hi(
    "scalepad_lm_meetings_user_attendees_add",
    "Add Meeting User Attendees",
    true,
    "Add user attendees to a Lifecycle Manager meeting.",
    schema(
      {
        id: str("Meeting id"),
        user_keys: strArr("User keys to add"),
      },
      ["id", "user_keys"]
    ),
    (a) => `Add user attendees to meeting ${String(a.id)}.`,
    (c, a) => c.lmMeetings.addUserAttendees(req(a, "id"), { user_keys: a.user_keys as string[] })
  ),
  hi(
    "scalepad_lm_meetings_contact_attendees_remove",
    "Remove Meeting Contact Attendees",
    true,
    "Remove contact attendees from a Lifecycle Manager meeting.",
    schema(
      {
        id: str("Meeting id"),
        contact_keys: strArr("Contact keys to remove"),
      },
      ["id", "contact_keys"]
    ),
    (a) => `Remove contact attendees from meeting ${String(a.id)}.`,
    (c, a) =>
      c.lmMeetings.removeContactAttendees(req(a, "id"), { contact_keys: a.contact_keys as string[] })
  ),
  hi(
    "scalepad_lm_meetings_contact_attendees_add",
    "Add Meeting Contact Attendees",
    true,
    "Add contact attendees to a Lifecycle Manager meeting.",
    schema(
      {
        id: str("Meeting id"),
        contact_keys: strArr("Contact keys to add"),
      },
      ["id", "contact_keys"]
    ),
    (a) => `Add contact attendees to meeting ${String(a.id)}.`,
    (c, a) =>
      c.lmMeetings.addContactAttendees(req(a, "id"), { contact_keys: a.contact_keys as string[] })
  ),
  ro(
    "scalepad_lm_meetings_action_items_list",
    "List the action items attached to a Lifecycle Manager meeting.",
    schema({ meeting_id: str("Meeting id") }, ["meeting_id"]),
    (c, a) => c.lmMeetings.listActionItems(req(a, "meeting_id"))
  ),
  hi(
    "scalepad_lm_meetings_action_items_attach",
    "Attach Action Item to Meeting",
    true,
    "Attach an action item to a Lifecycle Manager meeting.",
    schema(
      {
        meeting_id: str("Meeting id"),
        action_item_id: str("Action item id to attach"),
      },
      ["meeting_id", "action_item_id"]
    ),
    (a) =>
      `Attach action item ${String(a.action_item_id)} to meeting ${String(a.meeting_id)}.`,
    (c, a) =>
      c.lmMeetings.attachActionItem(req(a, "meeting_id"), req(a, "action_item_id"))
  ),
  hi(
    "scalepad_lm_meetings_action_items_detach",
    "Detach Action Item from Meeting",
    true,
    "Detach an action item from a Lifecycle Manager meeting (the action item itself is not deleted).",
    schema(
      {
        meeting_id: str("Meeting id"),
        action_item_id: str("Action item id to detach"),
      },
      ["meeting_id", "action_item_id"]
    ),
    (a) =>
      `Detach action item ${String(a.action_item_id)} from meeting ${String(a.meeting_id)}.`,
    (c, a) =>
      c.lmMeetings.detachActionItem(req(a, "meeting_id"), req(a, "action_item_id"))
  ),

  // ── lmActionItems ──────────────────────────────────────────────────────────
  hi(
    "scalepad_lm_action_items_reposition",
    "Reposition Action Item",
    false,
    "Reposition a Lifecycle Manager action item relative to another (before_id/after_id).",
    schema(
      {
        id: str("Action item id"),
        before_id: str("Place the item before this action item id"),
        after_id: str("Place the item after this action item id"),
      },
      ["id"]
    ),
    (a) => `Reposition action item ${String(a.id)}.`,
    (c, a) => c.lmActionItems.reposition(req(a, "id"), pick(a, ["before_id", "after_id"]))
  ),
  hi(
    "scalepad_lm_action_items_pin_update",
    "Update Action Item Pin Status",
    true,
    "Pin or unpin a Lifecycle Manager action item.",
    schema(
      {
        id: str("Action item id"),
        is_pinned: bool("true to pin, false to unpin"),
      },
      ["id", "is_pinned"]
    ),
    (a) => `Set is_pinned=${String(a.is_pinned)} on action item ${String(a.id)}.`,
    (c, a) => c.lmActionItems.updatePinStatus(req(a, "id"), { is_pinned: a.is_pinned as boolean })
  ),
  hi(
    "scalepad_lm_action_items_completion_status_update",
    "Update Action Item Completion Status",
    true,
    "Mark a Lifecycle Manager action item completed or not completed.",
    schema(
      {
        id: str("Action item id"),
        is_completed: bool("true to mark completed, false to reopen"),
      },
      ["id", "is_completed"]
    ),
    (a) => `Set is_completed=${String(a.is_completed)} on action item ${String(a.id)}.`,
    (c, a) =>
      c.lmActionItems.updateCompletionStatus(req(a, "id"), {
        is_completed: a.is_completed as boolean,
      })
  ),
  ro(
    "scalepad_lm_action_items_get",
    "Get a Lifecycle Manager action item by id.",
    idSchema("Action item id"),
    (c, a) => c.lmActionItems.get(req(a, "id"))
  ),
  hi(
    "scalepad_lm_action_items_update",
    "Update Action Item",
    true,
    "Update a Lifecycle Manager action item (description, assignees, due date, …).",
    schema(
      {
        id: str("Action item id"),
        update_payload: obj("The action item update payload"),
      },
      ["id", "update_payload"]
    ),
    (a) => `Update action item ${String(a.id)}.`,
    (c, a) =>
      c.lmActionItems.update(req(a, "id"), { update_payload: a.update_payload as Record<string, unknown> })
  ),
  irrev(
    "scalepad_lm_action_items_delete",
    "Delete Action Item",
    true,
    "Permanently delete a Lifecycle Manager action item.",
    idSchema("Action item id"),
    (a) => `Permanently delete action item ${String(a.id)}.`,
    (c, a) => c.lmActionItems.delete(req(a, "id"))
  ),
  ro(
    "scalepad_lm_action_items_list",
    "List Lifecycle Manager action items (cursor-paginated; page_size 1-200, default 25). Filterable by client, completion, overdue status, assignees, creator, and unassigned flag.",
    schema({
      ...filters([
        "client.id",
        "is_completed",
        "is_overdue",
        "assigned_user_ids",
        "created_by_user_id",
        "is_unassigned",
      ]),
      ...sortProp,
      ...paginationProps,
    }),
    (c, a) => c.lmActionItems.list(listParams(a)),
    {
      message:
        "No filters provided — this lists action items across every client. Optionally enter a client id to narrow the results (leave empty to list all).",
      argName: "client.id",
      isFilterKey: true,
    }
  ),
  hi(
    "scalepad_lm_action_items_create",
    "Create Action Item",
    false,
    "Create a new Lifecycle Manager action item for a client.",
    schema(
      {
        client_key: str("Client key (from clients lookup)"),
        description: str("Action item description (plain text)"),
        description_json: freeform("Action item description (rich-text JSON)"),
        assigned_user_ids: strArr("User ids to assign"),
        due_at: str("Due date (ISO 8601)"),
      },
      ["client_key", "description"]
    ),
    (a) => `Create an action item for client ${String(a.client_key)}.`,
    (c, a) =>
      c.lmActionItems.create(
        pick(a, [
          "client_key",
          "description",
          "description_json",
          "assigned_user_ids",
          "due_at",
        ])
      )
  ),

  // ── lmAssessments ──────────────────────────────────────────────────────────
  ro(
    "scalepad_lm_assessment_templates_get",
    "Get a Lifecycle Manager assessment template by id.",
    schema({ assessment_template_id: str("Assessment template id") }, [
      "assessment_template_id",
    ]),
    (c, a) => c.lmAssessments.getTemplate(req(a, "assessment_template_id"))
  ),
  hi(
    "scalepad_lm_assessment_templates_update",
    "Update Assessment Template",
    true,
    "Update a Lifecycle Manager assessment template.",
    schema(
      {
        assessment_template_id: str("Assessment template id"),
        assessment_template: obj("The updated assessment template payload"),
      },
      ["assessment_template_id", "assessment_template"]
    ),
    (a) => `Update assessment template ${String(a.assessment_template_id)}.`,
    (c, a) =>
      c.lmAssessments.updateTemplate(req(a, "assessment_template_id"), {
        assessment_template: a.assessment_template as Record<string, unknown>,
      })
  ),
  irrev(
    "scalepad_lm_assessment_templates_delete",
    "Delete Assessment Template",
    true,
    "Permanently delete a Lifecycle Manager assessment template.",
    schema({ assessment_template_id: str("Assessment template id") }, [
      "assessment_template_id",
    ]),
    (a) => `Permanently delete assessment template ${String(a.assessment_template_id)}.`,
    (c, a) => c.lmAssessments.deleteTemplate(req(a, "assessment_template_id"))
  ),
  ro(
    "scalepad_lm_assessment_templates_list",
    "List Lifecycle Manager assessment templates (no filters or pagination).",
    schema({}),
    (c) => c.lmAssessments.listTemplates()
  ),
  hi(
    "scalepad_lm_assessment_templates_create",
    "Create Assessment Template",
    false,
    "Create a new Lifecycle Manager assessment template.",
    schema({ assessment_template: obj("The assessment template payload") }, [
      "assessment_template",
    ]),
    () => "Create a new assessment template.",
    (c, a) =>
      c.lmAssessments.createTemplate({ assessment_template: a.assessment_template as Record<string, unknown> })
  ),
  hi(
    "scalepad_lm_assessments_question_public_comment_update",
    "Update Assessment Question Public Comment",
    true,
    "Update the public (client-visible) comment on an assessment question.",
    schema(
      {
        assessment_id: str("Assessment id"),
        question_id: str("Question id"),
        comment_plain_text: str("Comment (plain text)"),
        comment_json: freeform("Comment (rich-text JSON)"),
      },
      ["assessment_id", "question_id"]
    ),
    (a) =>
      `Update the public comment on question ${String(a.question_id)} of assessment ${String(a.assessment_id)}.`,
    (c, a) =>
      c.lmAssessments.updateQuestionPublicComment(
        req(a, "assessment_id"),
        req(a, "question_id"),
        pick(a, ["comment_plain_text", "comment_json"])
      )
  ),
  hi(
    "scalepad_lm_assessments_question_internal_comment_update",
    "Update Assessment Question Internal Comment",
    true,
    "Update the internal (team-only) comment on an assessment question.",
    schema(
      {
        assessment_id: str("Assessment id"),
        question_id: str("Question id"),
        comment_plain_text: str("Comment (plain text)"),
        comment_json: freeform("Comment (rich-text JSON)"),
      },
      ["assessment_id", "question_id"]
    ),
    (a) =>
      `Update the internal comment on question ${String(a.question_id)} of assessment ${String(a.assessment_id)}.`,
    (c, a) =>
      c.lmAssessments.updateQuestionInternalComment(
        req(a, "assessment_id"),
        req(a, "question_id"),
        pick(a, ["comment_plain_text", "comment_json"])
      )
  ),
  hi(
    "scalepad_lm_assessments_internal_comment_update",
    "Update Assessment Internal Comment",
    true,
    "Update the internal comment on a Lifecycle Manager assessment.",
    schema(
      {
        id: str("Assessment id"),
        internal_comment: str("Internal comment text"),
      },
      ["id", "internal_comment"]
    ),
    (a) => `Update the internal comment on assessment ${String(a.id)}.`,
    (c, a) =>
      c.lmAssessments.updateInternalComment(req(a, "id"), {
        internal_comment: a.internal_comment as string,
      })
  ),
  hi(
    "scalepad_lm_assessments_evaluate",
    "Evaluate Assessment",
    true,
    "Submit question evaluations for a Lifecycle Manager assessment.",
    schema(
      {
        id: str("Assessment id"),
        question_evaluations: arr("Question evaluation entries"),
      },
      ["id", "question_evaluations"]
    ),
    (a) => `Submit evaluations for assessment ${String(a.id)}.`,
    (c, a) =>
      c.lmAssessments.evaluate(req(a, "id"), {
        question_evaluations: a.question_evaluations as unknown[],
      })
  ),
  ro(
    "scalepad_lm_assessments_get",
    "Get a Lifecycle Manager assessment by id.",
    idSchema("Assessment id"),
    (c, a) => c.lmAssessments.get(req(a, "id"))
  ),
  hi(
    "scalepad_lm_assessments_update",
    "Update Assessment",
    true,
    "Update a Lifecycle Manager assessment (title, evaluator, evaluation date).",
    schema(
      {
        id: str("Assessment id"),
        title: str("Assessment title"),
        evaluate_user_id: str("Evaluating user id"),
        evaluate_at: str("Evaluation date (ISO 8601)"),
      },
      ["id"]
    ),
    (a) => `Update assessment ${String(a.id)}.`,
    (c, a) =>
      c.lmAssessments.update(
        req(a, "id"),
        pick(a, ["title", "evaluate_user_id", "evaluate_at"])
      )
  ),
  irrev(
    "scalepad_lm_assessments_delete",
    "Delete Assessment",
    true,
    "Permanently delete a Lifecycle Manager assessment.",
    idSchema("Assessment id"),
    (a) => `Permanently delete assessment ${String(a.id)}.`,
    (c, a) => c.lmAssessments.delete(req(a, "id"))
  ),
  ro(
    "scalepad_lm_assessments_list",
    "List Lifecycle Manager assessments (cursor-paginated; page_size 1-200, default 25). Filterable by client, status, and assessment template.",
    schema({
      ...filters(["client.id", "status", "assessment_template_id"]),
      ...paginationProps,
    }),
    (c, a) => c.lmAssessments.list(listParams(a)),
    {
      message:
        "No filters provided — this lists assessments across every client. Optionally enter a client id to narrow the results (leave empty to list all).",
      argName: "client.id",
      isFilterKey: true,
    }
  ),
  hi(
    "scalepad_lm_assessments_create",
    "Create Assessment",
    false,
    "Create a new Lifecycle Manager assessment for a client from an assessment template.",
    schema(
      {
        client_key: str("Client key (from clients lookup)"),
        title: str("Assessment title"),
        assessment_template_id: str("Assessment template id"),
        evaluate_user_id: str("Evaluating user id"),
        evaluate_at: str("Evaluation date (ISO 8601)"),
      },
      ["client_key", "title"]
    ),
    (a) => `Create assessment "${String(a.title)}" for client ${String(a.client_key)}.`,
    (c, a) =>
      c.lmAssessments.create(
        pick(a, [
          "client_key",
          "title",
          "assessment_template_id",
          "evaluate_user_id",
          "evaluate_at",
        ])
      )
  ),
  hi(
    "scalepad_lm_assessments_completion_status_update",
    "Update Assessment Completion Status",
    true,
    "Mark a Lifecycle Manager assessment completed or not completed.",
    schema(
      {
        id: str("Assessment id"),
        is_completed: bool("true to mark completed, false to reopen"),
      },
      ["id", "is_completed"]
    ),
    (a) => `Set is_completed=${String(a.is_completed)} on assessment ${String(a.id)}.`,
    (c, a) =>
      c.lmAssessments.updateCompletionStatus(req(a, "id"), {
        is_completed: a.is_completed as boolean,
      })
  ),

  // ── lmDeliverables ─────────────────────────────────────────────────────────
  ro(
    "scalepad_lm_deliverables_pdf_get",
    "Download a Lifecycle Manager deliverable as a PDF. Returns a binary payload; read-only export.",
    schema({ deliverable_id: str("Deliverable id") }, ["deliverable_id"]),
    (c, a) => c.lmDeliverables.downloadPdf(req(a, "deliverable_id"))
  ),
  ro(
    "scalepad_lm_deliverables_get",
    "Get a Lifecycle Manager deliverable by id.",
    schema({ deliverable_id: str("Deliverable id") }, ["deliverable_id"]),
    (c, a) => c.lmDeliverables.get(req(a, "deliverable_id"))
  ),
  hi(
    "scalepad_lm_deliverables_update",
    "Update Deliverable",
    true,
    "Patch-update a Lifecycle Manager deliverable (name, status, sections).",
    schema(
      {
        deliverable_id: str("Deliverable id"),
        name: str("Deliverable name"),
        status: str("Deliverable status"),
        sections: arr("Deliverable sections"),
      },
      ["deliverable_id"]
    ),
    (a) => `Update deliverable ${String(a.deliverable_id)}.`,
    (c, a) =>
      c.lmDeliverables.update(
        req(a, "deliverable_id"),
        pick(a, ["name", "status", "sections"])
      )
  ),
  irrev(
    "scalepad_lm_deliverables_delete",
    "Delete Deliverable",
    true,
    "Permanently delete a Lifecycle Manager deliverable.",
    schema({ deliverable_id: str("Deliverable id") }, ["deliverable_id"]),
    (a) => `Permanently delete deliverable ${String(a.deliverable_id)}.`,
    (c, a) => c.lmDeliverables.delete(req(a, "deliverable_id"))
  ),
  hi(
    "scalepad_lm_deliverables_create_from_template",
    "Create Deliverable from Template",
    false,
    "Create a new deliverable for a client from an existing deliverable template.",
    schema(
      {
        client_id: str("Client id"),
        template_id: str("Deliverable template id"),
        name: str("Name for the new deliverable"),
      },
      ["client_id", "template_id"]
    ),
    (a) =>
      `Create a deliverable from template ${String(a.template_id)} for client ${String(a.client_id)}.`,
    (c, a) =>
      c.lmDeliverables.createFromTemplate(
        req(a, "client_id"),
        req(a, "template_id"),
        pick(a, ["name"])
      )
  ),
  ro(
    "scalepad_lm_client_deliverables_list",
    "List all deliverables for a specific Lifecycle Manager client.",
    schema({ client_id: str("Client id") }, ["client_id"]),
    (c, a) => c.lmDeliverables.listForClient(req(a, "client_id"))
  ),
  hi(
    "scalepad_lm_deliverables_create",
    "Create Deliverable",
    false,
    "Create a new deliverable for a Lifecycle Manager client.",
    schema(
      {
        client_id: str("Client id"),
        name: str("Deliverable name"),
        sections: arr("Deliverable sections"),
      },
      ["client_id", "name"]
    ),
    (a) => `Create deliverable "${String(a.name)}" for client ${String(a.client_id)}.`,
    (c, a) =>
      c.lmDeliverables.createForClient(req(a, "client_id"), pick(a, ["name", "sections"]))
  ),
  ro(
    "scalepad_lm_deliverables_catalog_components_list",
    "List the deliverable catalog components available for a specific client.",
    schema({ client_id: str("Client id") }, ["client_id"]),
    (c, a) => c.lmDeliverables.listClientCatalogComponents(req(a, "client_id"))
  ),
  ro(
    "scalepad_lm_deliverables_catalog_integrations_list",
    "List all available deliverable integrations (account-wide).",
    schema({}),
    (c) => c.lmDeliverables.listCatalogIntegrations()
  ),
  ro(
    "scalepad_lm_deliverables_integrated_integrations_list",
    "List the deliverable integrations that are integrated for a specific client.",
    schema({ client_id: str("Client id") }, ["client_id"]),
    (c, a) => c.lmDeliverables.listIntegratedIntegrations(req(a, "client_id"))
  ),
  ro(
    "scalepad_lm_deliverables_presentation_get",
    "Get a Lifecycle Manager deliverable in presentation form by id.",
    schema({ deliverable_id: str("Deliverable id") }, ["deliverable_id"]),
    (c, a) => c.lmDeliverables.getPresentation(req(a, "deliverable_id"))
  ),
  hi(
    "scalepad_lm_deliverables_sections_refresh",
    "Refresh Deliverable Section",
    true,
    "Refresh a deliverable section's data from its sources.",
    schema(
      {
        deliverable_id: str("Deliverable id"),
        section_id: str("Section id"),
      },
      ["deliverable_id", "section_id"]
    ),
    (a) =>
      `Refresh section ${String(a.section_id)} of deliverable ${String(a.deliverable_id)}.`,
    (c, a) =>
      c.lmDeliverables.refreshSection(req(a, "deliverable_id"), req(a, "section_id"))
  ),
  irrev(
    "scalepad_lm_deliverables_sections_delete",
    "Delete Deliverable Section",
    true,
    "Permanently delete a section from a deliverable.",
    schema(
      {
        deliverable_id: str("Deliverable id"),
        section_id: str("Section id"),
      },
      ["deliverable_id", "section_id"]
    ),
    (a) =>
      `Permanently delete section ${String(a.section_id)} of deliverable ${String(a.deliverable_id)}.`,
    (c, a) =>
      c.lmDeliverables.deleteSection(req(a, "deliverable_id"), req(a, "section_id"))
  ),
  hi(
    "scalepad_lm_deliverables_components_refresh",
    "Refresh Deliverable Section Component",
    true,
    "Refresh a single component within a deliverable section.",
    schema(
      {
        deliverable_id: str("Deliverable id"),
        section_id: str("Section id"),
        component_id: str("Component id"),
      },
      ["deliverable_id", "section_id", "component_id"]
    ),
    (a) =>
      `Refresh component ${String(a.component_id)} in section ${String(a.section_id)} of deliverable ${String(a.deliverable_id)}.`,
    (c, a) =>
      c.lmDeliverables.refreshSectionComponent(
        req(a, "deliverable_id"),
        req(a, "section_id"),
        req(a, "component_id")
      )
  ),
  irrev(
    "scalepad_lm_deliverables_components_delete",
    "Delete Deliverable Section Component",
    true,
    "Permanently delete a component from a deliverable section.",
    schema(
      {
        deliverable_id: str("Deliverable id"),
        section_id: str("Section id"),
        component_id: str("Component id"),
      },
      ["deliverable_id", "section_id", "component_id"]
    ),
    (a) =>
      `Permanently delete component ${String(a.component_id)} in section ${String(a.section_id)} of deliverable ${String(a.deliverable_id)}.`,
    (c, a) =>
      c.lmDeliverables.deleteSectionComponent(
        req(a, "deliverable_id"),
        req(a, "section_id"),
        req(a, "component_id")
      )
  ),
  ro(
    "scalepad_lm_deliverable_templates_get",
    "Get a Lifecycle Manager deliverable template by id.",
    schema({ template_id: str("Deliverable template id") }, ["template_id"]),
    (c, a) => c.lmDeliverables.getTemplate(req(a, "template_id"))
  ),
  hi(
    "scalepad_lm_deliverable_templates_update",
    "Update Deliverable Template",
    true,
    "Patch-update a Lifecycle Manager deliverable template (name, sections).",
    schema(
      {
        template_id: str("Deliverable template id"),
        name: str("Template name"),
        sections: arr("Template sections"),
      },
      ["template_id"]
    ),
    (a) => `Update deliverable template ${String(a.template_id)}.`,
    (c, a) =>
      c.lmDeliverables.updateTemplate(req(a, "template_id"), pick(a, ["name", "sections"]))
  ),
  irrev(
    "scalepad_lm_deliverable_templates_delete",
    "Delete Deliverable Template",
    true,
    "Permanently delete a Lifecycle Manager deliverable template.",
    schema({ template_id: str("Deliverable template id") }, ["template_id"]),
    (a) => `Permanently delete deliverable template ${String(a.template_id)}.`,
    (c, a) => c.lmDeliverables.deleteTemplate(req(a, "template_id"))
  ),
  hi(
    "scalepad_lm_deliverable_templates_duplicate",
    "Duplicate Deliverable Template",
    false,
    "Create a new deliverable template as a copy of an existing template.",
    schema({ template_id: str("Source deliverable template id") }, ["template_id"]),
    (a) => `Duplicate deliverable template ${String(a.template_id)}.`,
    (c, a) => c.lmDeliverables.createTemplateFromTemplate(req(a, "template_id"))
  ),
  hi(
    "scalepad_lm_deliverable_templates_create_from_deliverable",
    "Create Deliverable Template from Deliverable",
    false,
    "Create a new deliverable template from an existing deliverable.",
    schema({ deliverable_id: str("Source deliverable id") }, ["deliverable_id"]),
    (a) => `Create a deliverable template from deliverable ${String(a.deliverable_id)}.`,
    (c, a) => c.lmDeliverables.createTemplateFromDeliverable(req(a, "deliverable_id"))
  ),
  ro(
    "scalepad_lm_deliverable_templates_list",
    "List all Lifecycle Manager deliverable templates (no filters or pagination).",
    schema({}),
    (c) => c.lmDeliverables.listTemplates()
  ),
  hi(
    "scalepad_lm_deliverable_templates_create",
    "Create Deliverable Template",
    false,
    "Create a new Lifecycle Manager deliverable template.",
    schema(
      {
        name: str("Template name"),
        sections: arr("Template sections"),
      },
      ["name"]
    ),
    (a) => `Create deliverable template "${String(a.name)}".`,
    (c, a) => c.lmDeliverables.createTemplate(pick(a, ["name", "sections"]))
  ),
  ro(
    "scalepad_lm_deliverable_templates_catalog_components_list",
    "List the deliverable catalog components available for templates (account-wide).",
    schema({}),
    (c) => c.lmDeliverables.listTemplateCatalogComponents()
  ),
  irrev(
    "scalepad_lm_deliverable_templates_sections_delete",
    "Delete Deliverable Template Section",
    true,
    "Permanently delete a section from a deliverable template.",
    schema(
      {
        template_id: str("Deliverable template id"),
        section_id: str("Section id"),
      },
      ["template_id", "section_id"]
    ),
    (a) =>
      `Permanently delete section ${String(a.section_id)} of deliverable template ${String(a.template_id)}.`,
    (c, a) =>
      c.lmDeliverables.deleteTemplateSection(req(a, "template_id"), req(a, "section_id"))
  ),
  irrev(
    "scalepad_lm_deliverable_templates_components_delete",
    "Delete Deliverable Template Section Component",
    true,
    "Permanently delete a component from a deliverable template section.",
    schema(
      {
        template_id: str("Deliverable template id"),
        section_id: str("Section id"),
        component_id: str("Component id"),
      },
      ["template_id", "section_id", "component_id"]
    ),
    (a) =>
      `Permanently delete component ${String(a.component_id)} in section ${String(a.section_id)} of deliverable template ${String(a.template_id)}.`,
    (c, a) =>
      c.lmDeliverables.deleteTemplateSectionComponent(
        req(a, "template_id"),
        req(a, "section_id"),
        req(a, "component_id")
      )
  ),
  irrev(
    "scalepad_lm_deliverables_share_link_revoke",
    "Revoke Deliverable Share Link",
    true,
    "Revoke the general share link of a deliverable. Anyone holding the old link loses access; the link cannot be restored.",
    schema({ deliverable_id: str("Deliverable id") }, ["deliverable_id"]),
    (a) => `Revoke the share link of deliverable ${String(a.deliverable_id)}.`,
    (c, a) => c.lmDeliverables.revokeGeneralShareLink(req(a, "deliverable_id"))
  ),
  irrev(
    "scalepad_lm_deliverables_share_link_regenerate",
    "Regenerate Deliverable Share Link",
    false,
    "Regenerate the general share link of a deliverable. The previous link stops working immediately and cannot be restored.",
    schema({ deliverable_id: str("Deliverable id") }, ["deliverable_id"]),
    (a) => `Regenerate the share link of deliverable ${String(a.deliverable_id)}.`,
    (c, a) => c.lmDeliverables.regenerateGeneralShareLink(req(a, "deliverable_id"))
  ),
  ro(
    "scalepad_lm_deliverables_share_link_get",
    "Get the general share link of a deliverable.",
    schema({ deliverable_id: str("Deliverable id") }, ["deliverable_id"]),
    (c, a) => c.lmDeliverables.getGeneralShareLink(req(a, "deliverable_id"))
  ),
  hi(
    "scalepad_lm_deliverables_share_link_create",
    "Create Deliverable Share Link",
    false,
    "Create a general share link for a deliverable (grants link-holders access).",
    schema({ deliverable_id: str("Deliverable id") }, ["deliverable_id"]),
    (a) => `Create a share link for deliverable ${String(a.deliverable_id)}.`,
    (c, a) => c.lmDeliverables.createGeneralShareLink(req(a, "deliverable_id"))
  ),
  ro(
    "scalepad_lm_deliverables_list",
    "List Lifecycle Manager deliverables across the account (cursor-paginated; page_size 1-200, default 25). Filterable by client, status, creator, meeting linkage, and name.",
    schema({
      ...filters(["client.id", "status", "created_by", "has_meeting", "name"]),
      ...sortProp,
      ...paginationProps,
    }),
    (c, a) => c.lmDeliverables.list(listParams(a)),
    {
      message:
        "No filters provided — this lists deliverables across every client. Optionally enter a client id to narrow the results (leave empty to list all).",
      argName: "client.id",
      isFilterKey: true,
    }
  ),

  // ── lmBudget ───────────────────────────────────────────────────────────────
  ro(
    "scalepad_lm_budget_summary_get",
    "Get the budget summary for a client. Forecast window controls: frequency, period_count, starting_date, include_overdue, include_not_scheduled; filterable by type, status, asset type, third-party flag, and name; optional IT-debt grouping by asset type.",
    schema(
      {
        client_id: str("Client id"),
        frequency: str("Forecast bucket frequency (e.g. monthly, quarterly, yearly)"),
        period_count: num("Number of periods in the forecast window"),
        starting_date: str("Forecast window start date (ISO 8601)"),
        include_overdue: bool("Include overdue items"),
        include_not_scheduled: bool("Include items not yet scheduled"),
        it_debt_group_by_asset_type: bool("Group IT debt by asset type"),
        ...filters(["type", "status", "asset_type.id", "is_third_party", "name"]),
      },
      ["client_id"]
    ),
    (c, a) => c.lmBudget.getSummary(req(a, "client_id"), listParams(a, ["client_id"]))
  ),
  ro(
    "scalepad_lm_budget_it_debt_list",
    "List a client's IT-debt budget entries (cursor-paginated). Same forecast window controls as the budget summary; filterable by asset type and name.",
    schema(
      {
        client_id: str("Client id"),
        frequency: str("Forecast bucket frequency"),
        period_count: num("Number of periods in the forecast window"),
        starting_date: str("Forecast window start date (ISO 8601)"),
        include_overdue: bool("Include overdue items"),
        include_not_scheduled: bool("Include items not yet scheduled"),
        ...filters(["asset_type.id", "name"]),
        ...sortProp,
        ...paginationProps,
      },
      ["client_id"]
    ),
    (c, a) => c.lmBudget.listItDebt(req(a, "client_id"), listParams(a, ["client_id"]))
  ),
  ro(
    "scalepad_lm_budget_initiatives_list",
    "List a client's budgeted initiatives (cursor-paginated). Same forecast window controls as the budget summary; filterable by status and name.",
    schema(
      {
        client_id: str("Client id"),
        frequency: str("Forecast bucket frequency"),
        period_count: num("Number of periods in the forecast window"),
        starting_date: str("Forecast window start date (ISO 8601)"),
        include_overdue: bool("Include overdue items"),
        include_not_scheduled: bool("Include items not yet scheduled"),
        ...filters(["status", "name"]),
        ...sortProp,
        ...paginationProps,
      },
      ["client_id"]
    ),
    (c, a) =>
      c.lmBudget.listInitiatives(req(a, "client_id"), listParams(a, ["client_id"]))
  ),
  ro(
    "scalepad_lm_budget_forecast_pdf_get",
    "Download a client's budget forecast as a PDF (binary payload; read-only export). Same forecast window controls as the budget summary, plus include_chart.",
    schema(
      {
        client_id: str("Client id"),
        frequency: str("Forecast bucket frequency"),
        period_count: num("Number of periods in the forecast window"),
        starting_date: str("Forecast window start date (ISO 8601)"),
        include_overdue: bool("Include overdue items"),
        include_not_scheduled: bool("Include items not yet scheduled"),
        include_chart: bool("Include the forecast chart in the PDF"),
        ...filters(["type", "status", "asset_type.id", "is_third_party", "name"]),
      },
      ["client_id"]
    ),
    (c, a) =>
      c.lmBudget.downloadForecastPdf(req(a, "client_id"), listParams(a, ["client_id"]))
  ),
  ro(
    "scalepad_lm_budget_forecast_detail_pdf_get",
    "Download a client's detailed budget forecast as a PDF (binary payload; read-only export). Adds a `group` option on top of the standard forecast controls.",
    schema(
      {
        client_id: str("Client id"),
        frequency: str("Forecast bucket frequency"),
        period_count: num("Number of periods in the forecast window"),
        starting_date: str("Forecast window start date (ISO 8601)"),
        include_overdue: bool("Include overdue items"),
        include_not_scheduled: bool("Include items not yet scheduled"),
        include_chart: bool("Include the forecast chart in the PDF"),
        group: str("Grouping to apply to the detail rows"),
        ...filters(["type", "status", "asset_type.id", "is_third_party", "name"]),
      },
      ["client_id"]
    ),
    (c, a) =>
      c.lmBudget.downloadForecastDetailPdf(req(a, "client_id"), listParams(a, ["client_id"]))
  ),
  ro(
    "scalepad_lm_budget_forecast_csv_get",
    "Download a client's budget forecast as a CSV (binary payload; read-only export). Same forecast window controls as the budget summary.",
    schema(
      {
        client_id: str("Client id"),
        frequency: str("Forecast bucket frequency"),
        period_count: num("Number of periods in the forecast window"),
        starting_date: str("Forecast window start date (ISO 8601)"),
        include_overdue: bool("Include overdue items"),
        include_not_scheduled: bool("Include items not yet scheduled"),
        ...filters(["type", "status", "asset_type.id", "is_third_party", "name"]),
      },
      ["client_id"]
    ),
    (c, a) =>
      c.lmBudget.downloadForecastCsv(req(a, "client_id"), listParams(a, ["client_id"]))
  ),
  ro(
    "scalepad_lm_budget_contracts_list",
    "List a client's budgeted contracts (cursor-paginated). Same forecast window controls as the budget summary; filterable by third-party flag and name.",
    schema(
      {
        client_id: str("Client id"),
        frequency: str("Forecast bucket frequency"),
        period_count: num("Number of periods in the forecast window"),
        starting_date: str("Forecast window start date (ISO 8601)"),
        include_overdue: bool("Include overdue items"),
        include_not_scheduled: bool("Include items not yet scheduled"),
        ...filters(["is_third_party", "name"]),
        ...sortProp,
        ...paginationProps,
      },
      ["client_id"]
    ),
    (c, a) => c.lmBudget.listContracts(req(a, "client_id"), listParams(a, ["client_id"]))
  ),
  ro(
    "scalepad_lm_budget_availabilities_get",
    "Get the budget availabilities for a client.",
    schema({ client_id: str("Client id") }, ["client_id"]),
    (c, a) => c.lmBudget.getAvailabilities(req(a, "client_id"))
  ),

  // ── lmContracts ────────────────────────────────────────────────────────────
  ro(
    "scalepad_lm_contracts_get",
    "Get a Lifecycle Manager contract (agreement) by id.",
    idSchema("Contract id"),
    (c, a) => c.lmContracts.get(req(a, "id"))
  ),
  hi(
    "scalepad_lm_contracts_update",
    "Update Contract",
    true,
    "Update a Lifecycle Manager contract (agreement).",
    schema(
      {
        id: str("Contract id"),
        client_id: str("Client id the contract belongs to"),
        update_payload: obj("The contract update payload"),
      },
      ["id", "update_payload"]
    ),
    (a) => `Update contract ${String(a.id)}.`,
    (c, a) =>
      c.lmContracts.update(req(a, "id"), pick(a, ["client_id", "update_payload"]))
  ),
  irrev(
    "scalepad_lm_contracts_delete",
    "Delete Contract",
    true,
    "Permanently delete a Lifecycle Manager contract (agreement).",
    idSchema("Contract id"),
    (a) => `Permanently delete contract ${String(a.id)}.`,
    (c, a) => c.lmContracts.delete(req(a, "id"))
  ),
  ro(
    "scalepad_lm_contracts_list",
    "List Lifecycle Manager contracts (agreements; cursor-paginated; page_size 1-200, default 25). Filterable by client and expiry status.",
    schema({
      ...filters(["client.id", "expiry_status"]),
      ...paginationProps,
    }),
    (c, a) => c.lmContracts.list(listParams(a)),
    {
      message:
        "No filters provided — this lists contracts across every client. Optionally enter a client id to narrow the results (leave empty to list all).",
      argName: "client.id",
      isFilterKey: true,
    }
  ),
  hi(
    "scalepad_lm_contracts_create",
    "Create Contract",
    false,
    "Create a new Lifecycle Manager contract (agreement) for a client.",
    schema(
      {
        client_key: str("Client key (from clients lookup)"),
        create_payload: obj("The contract create payload"),
      },
      ["client_key", "create_payload"]
    ),
    (a) => `Create a contract for client ${String(a.client_key)}.`,
    (c, a) => c.lmContracts.create(pick(a, ["client_key", "create_payload"]))
  ),
  hi(
    "scalepad_lm_contracts_assets_detach",
    "Detach Hardware Assets from Contract",
    true,
    "Detach hardware assets from a Lifecycle Manager contract/agreement (the assets themselves are not deleted).",
    schema(
      {
        contract_id: str("Contract id"),
        hardware_keys: strArr("Hardware asset keys to detach"),
      },
      ["contract_id", "hardware_keys"]
    ),
    (a) => `Detach hardware assets from contract ${String(a.contract_id)}.`,
    (c, a) =>
      c.lmContracts.detachAssets(req(a, "contract_id"), {
        hardware_keys: a.hardware_keys as string[],
      })
  ),
  hi(
    "scalepad_lm_contracts_assets_attach",
    "Attach Hardware Assets to Contract",
    true,
    "Attach hardware assets to a Lifecycle Manager contract/agreement.",
    schema(
      {
        contract_id: str("Contract id"),
        hardware_keys: strArr("Hardware asset keys to attach"),
      },
      ["contract_id", "hardware_keys"]
    ),
    (a) => `Attach hardware assets to contract ${String(a.contract_id)}.`,
    (c, a) =>
      c.lmContracts.attachAssets(req(a, "contract_id"), {
        hardware_keys: a.hardware_keys as string[],
      })
  ),

  // ── lmWorkspace ────────────────────────────────────────────────────────────
  ro(
    "scalepad_lm_user_identity_get",
    "Get the identity of the Lifecycle Manager user behind the current API key.",
    schema({}),
    (c) => c.lmWorkspace.getUserIdentity()
  ),
  ro(
    "scalepad_lm_ticket_create_fields_get",
    "Get the PSA ticket create-field definitions (used with scalepad_lm_initiatives_ticket_create), optionally for a specific client.",
    schema({ client_id: str("Client id") }),
    (c, a) => c.lmWorkspace.getTicketCreateFields(listParams(a))
  ),
  ro(
    "scalepad_lm_opportunity_create_fields_get",
    "Get the PSA opportunity create-field definitions (used with scalepad_lm_initiatives_opportunity_create), optionally for a specific client.",
    schema({ client_id: str("Client id") }),
    (c, a) => c.lmWorkspace.getOpportunityCreateFields(listParams(a))
  ),
  ro(
    "scalepad_lm_opportunities_list",
    "List PSA opportunities visible to Lifecycle Manager, optionally scoped to a client and including inactive ones.",
    schema({
      client_id: str("Client id to scope opportunities to"),
      include_inactive: bool("Include inactive opportunities"),
    }),
    (c, a) => c.lmWorkspace.listOpportunities(listParams(a)),
    {
      message:
        "No filters provided — this lists opportunities across every client. Optionally enter a client_id to narrow the results (leave empty to list all).",
      argName: "client_id",
    }
  ),
  ro(
    "scalepad_lm_notes_get",
    "Get a Lifecycle Manager note by id.",
    idSchema("Note id"),
    (c, a) => c.lmWorkspace.getNote(req(a, "id"))
  ),
  hi(
    "scalepad_lm_notes_update",
    "Update Note",
    true,
    "Update a Lifecycle Manager note (title and rich-text body).",
    schema(
      {
        id: str("Note id"),
        title: str("Note title"),
        description_json: freeform("Note body (rich-text JSON)"),
      },
      ["id"]
    ),
    (a) => `Update note ${String(a.id)}.`,
    (c, a) =>
      c.lmWorkspace.updateNote(req(a, "id"), pick(a, ["title", "description_json"]))
  ),
  irrev(
    "scalepad_lm_notes_delete",
    "Delete Note",
    true,
    "Permanently delete a Lifecycle Manager note.",
    idSchema("Note id"),
    (a) => `Permanently delete note ${String(a.id)}.`,
    (c, a) => c.lmWorkspace.deleteNote(req(a, "id"))
  ),
  ro(
    "scalepad_lm_notes_list",
    "List Lifecycle Manager notes (cursor-paginated; page_size 1-200, default 25). Filterable by client and archived status.",
    schema({
      ...filters(["client.id", "is_archived"]),
      ...paginationProps,
    }),
    (c, a) => c.lmWorkspace.listNotes(listParams(a)),
    {
      message:
        "No filters provided — this lists notes across every client. Optionally enter a client id to narrow the results (leave empty to list all).",
      argName: "client.id",
      isFilterKey: true,
    }
  ),
  hi(
    "scalepad_lm_notes_create",
    "Create Note",
    false,
    "Create a new Lifecycle Manager note for a client.",
    schema(
      {
        client_key: str("Client key (from clients lookup)"),
        title: str("Note title"),
        description_json: freeform("Note body (rich-text JSON)"),
      },
      ["client_key", "title"]
    ),
    (a) => `Create note "${String(a.title)}" for client ${String(a.client_key)}.`,
    (c, a) => c.lmWorkspace.createNote(pick(a, ["client_key", "title", "description_json"]))
  ),
  hi(
    "scalepad_lm_notes_archive_status_update",
    "Update Note Archive Status",
    true,
    "Archive or unarchive a Lifecycle Manager note.",
    schema(
      {
        id: str("Note id"),
        is_archived: bool("true to archive, false to unarchive"),
      },
      ["id", "is_archived"]
    ),
    (a) => `Set is_archived=${String(a.is_archived)} on note ${String(a.id)}.`,
    (c, a) =>
      c.lmWorkspace.updateNoteArchiveStatus(req(a, "id"), {
        is_archived: a.is_archived as boolean,
      })
  ),
  ro(
    "scalepad_lm_user_ui_state_get",
    "Get a stored per-user UI state blob by state_key.",
    schema({ state_key: str("UI state key") }, ["state_key"]),
    (c, a) => c.lmWorkspace.getUserUiState(req(a, "state_key"))
  ),
  hi(
    "scalepad_lm_user_ui_state_put",
    "Put User UI State",
    true,
    "Store (replace) a per-user UI state blob under state_key.",
    schema(
      {
        state_key: str("UI state key"),
        payload: freeform("The UI state payload to store"),
      },
      ["state_key", "payload"]
    ),
    (a) => `Replace UI state "${String(a.state_key)}".`,
    (c, a) => c.lmWorkspace.putUserUiState(req(a, "state_key"), { payload: a.payload })
  ),
  ro(
    "scalepad_lm_insights_list",
    "List Lifecycle Manager insights (no filters or pagination).",
    schema({}),
    (c) => c.lmWorkspace.listInsights()
  ),
  hi(
    "scalepad_lm_enrollment_tokens_create",
    "Create SaaS Enrollment Token",
    false,
    "Create a SaaS-management enrollment token for a client (grants device enrollment until it expires).",
    schema(
      {
        client_id: str("Client id"),
        description: str("Token description"),
        site_id: str("Site id to scope the token to"),
        expires_at: str("Expiry time (ISO 8601)"),
      },
      ["client_id"]
    ),
    (a) => `Create a SaaS enrollment token for client ${String(a.client_id)}.`,
    (c, a) =>
      c.lmWorkspace.createEnrollmentToken(
        req(a, "client_id"),
        pick(a, ["description", "site_id", "expires_at"])
      )
  ),
  ro(
    "scalepad_lm_saas_utilization_summary_get",
    "Get the SaaS utilization summary for a client.",
    schema({ client_id: str("Client id") }, ["client_id"]),
    (c, a) => c.lmWorkspace.getSaasUtilizationSummary(req(a, "client_id"))
  ),
];

const specByName = new Map(specs.map((s) => [s.tool.name, s]));

function getTools(): Tool[] {
  return specs.map((s) => s.tool);
}

async function handleCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const spec = specByName.get(toolName);
  if (!spec) {
    return {
      content: [
        { type: "text", text: `Unknown lifecycle-manager tool: ${toolName}` },
      ],
      isError: true,
    };
  }

  const toolArgs: Record<string, unknown> = { ...args };

  // Elicitation default: a zero-filter list offers a narrowing filter.
  // null (declined / unsupported / failed) ⇒ proceed with the original call.
  if (
    spec.emptyFilterElicit &&
    Object.values(toolArgs).every((v) => v === undefined || v === null)
  ) {
    try {
      const { message, argName, isFilterKey } = spec.emptyFilterElicit;
      const value = await elicitText(message, argName);
      if (value) {
        if (isFilterKey) {
          toolArgs.filter = { [argName]: value };
        } else {
          toolArgs[argName] = value;
        }
      }
    } catch {
      // Proceed unfiltered.
    }
  }

  // Elicitation default: destructive calls ask for confirmation first.
  // null (unsupported / failed) ⇒ proceed; an explicit "no" cancels.
  if (spec.confirm) {
    try {
      const confirmed = await elicitConfirmation(
        `${spec.confirm(toolArgs)} Proceed?`
      );
      if (confirmed === false) {
        return {
          content: [
            {
              type: "text",
              text: "Cancelled: the user declined the confirmation prompt.",
            },
          ],
        };
      }
    } catch {
      // Proceed with the original behavior.
    }
  }

  try {
    const client = await getClient();
    logger.info(`API call: ${toolName}`, { args: Object.keys(toolArgs) });
    const result = await spec.call(client, toolArgs);
    logger.debug(`API response: ${toolName}`);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Tool call failed", { tool: toolName, error: message });
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}

export const handler: DomainHandler = {
  getTools,
  handleCall,
};
