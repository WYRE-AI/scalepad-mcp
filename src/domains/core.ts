/**
 * ScalePad Core domain handler
 *
 * Tools for the ScalePad Core API (US-only): unified platform data covering
 * clients, contacts, members, sites, opportunities, hardware/SaaS assets,
 * the product catalog, service contracts, tickets, and integrations.
 *
 * The entire Core surface is read-only. List endpoints use cursor pagination
 * (page_size 1-200, default 25; pass the cursor from the previous response).
 * Contacts and Members are POST-based searches upstream — the SDK hides that;
 * the tools behave like every other list. Endpoints return 402 when the
 * account has no active Core subscription.
 */
import type { Tool } from "@modelcontextprotocol/server";
import type { ScalePadClient } from "@wyre-technology/node-scalepad";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { getClient } from "../utils/client.js";
import { logger } from "../utils/logger.js";
import { elicitText } from "../utils/elicitation.js";

type JsonSchema = NonNullable<Tool["inputSchema"]["properties"]>[string];

/** JSON Schema property shorthands (all hand-written literals underneath). */
const str = (description: string): JsonSchema => ({ type: "string", description });

/** The shared cursor-pagination properties for Core list tools. */
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
    description:
      'Sort field; prefix with "-" for descending (e.g. "-record_updated_at").',
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
 * Map tool args onto SDK query params. Entries of the `filter` object become
 * filter[<key>] params; everything else (page_size, cursor, sort, …) passes
 * through as-is. `exclude` drops args already consumed as path params.
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
  call: (client: ScalePadClient, args: Record<string, unknown>) => Promise<unknown>;
}

/** Build a read-only tool spec (every Core endpoint is read-only). */
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

const specs: ToolSpec[] = [
  // ── coreClients ────────────────────────────────────────────────────────────
  ro(
    "scalepad_core_clients_list",
    "List ScalePad Core clients (read-only, cursor-paginated; page_size 1-200, default 25). Filterable by name, lifecycle, contact/asset counts, record lineage, and created/updated timestamps.",
    schema({
      ...filters([
        "id",
        "name",
        "lifecycle",
        "num_contacts",
        "num_hardware_assets",
        "record_lineage.source_record_id",
        "record_lineage.integration_configuration.id",
        "record_lineage.integration_configuration.vendor.id",
        "record_lineage.integration_configuration.vendor.brand_name",
        "record_created_at",
        "record_updated_at",
      ]),
      ...sortProp,
      ...paginationProps,
    }),
    (c, a) => c.coreClients.listClients(listParams(a)),
    {
      message:
        "No filters provided — this lists every Core client. Optionally enter a client name to narrow the results (leave empty to list all).",
      argName: "name",
      isFilterKey: true,
    }
  ),
  ro(
    "scalepad_core_clients_get",
    "Get a single ScalePad Core client by id (read-only).",
    idSchema("Core client id"),
    (c, a) => c.coreClients.getClient(req(a, "id"))
  ),
  ro(
    "scalepad_core_contacts_list",
    "List ScalePad Core contacts (read-only, cursor-paginated; page_size 1-200, default 25). A POST-based search upstream — filter by client, title, record lineage, or created/updated timestamps.",
    schema({
      ...filters([
        "id",
        "client.id",
        "client.name",
        "title",
        "record_lineage.source_record_id",
        "record_lineage.integration_configuration.id",
        "record_lineage.integration_configuration.vendor.id",
        "record_lineage.integration_configuration.vendor.brand_name",
        "record_created_at",
        "record_updated_at",
      ]),
      ...sortProp,
      ...paginationProps,
    }),
    (c, a) => c.coreClients.listContacts(listParams(a)),
    {
      message:
        "No filters provided — this lists contacts across every client. Optionally enter a client name to narrow the results (leave empty to list all).",
      argName: "client.name",
      isFilterKey: true,
    }
  ),
  ro(
    "scalepad_core_contacts_get",
    "Get a single ScalePad Core contact by id (read-only).",
    idSchema("Core contact id"),
    (c, a) => c.coreClients.getContact(req(a, "id"))
  ),
  ro(
    "scalepad_core_members_list",
    "List ScalePad Core members (your team; read-only, cursor-paginated; page_size 1-200, default 25). A POST-based search upstream — filter by title, hire date, reporting line, cost, capacity, or lineage.",
    schema({
      ...filters([
        "id",
        "hired_at",
        "title",
        "is_scalepad_user",
        "reports_to_member.id",
        "hourly_cost.amount",
        "daily_capacity",
        "record_lineage.source_record_id",
        "record_lineage.integration_configuration.id",
        "record_lineage.integration_configuration.vendor.id",
        "record_lineage.integration_configuration.vendor.brand_name",
        "record_created_at",
        "record_updated_at",
      ]),
      ...sortProp,
      ...paginationProps,
    }),
    (c, a) => c.coreClients.listMembers(listParams(a)),
    {
      message:
        "No filters provided — this lists every member. Optionally enter a member title to narrow the results (leave empty to list all).",
      argName: "title",
      isFilterKey: true,
    }
  ),
  ro(
    "scalepad_core_members_get",
    "Get a single ScalePad Core member by id (read-only).",
    idSchema("Core member id"),
    (c, a) => c.coreClients.getMember(req(a, "id"))
  ),
  ro(
    "scalepad_core_opportunities_list",
    "List ScalePad Core opportunities (read-only, cursor-paginated). Filterable by title, source status/stage, active flag, probability, client, contact, responsible member, lineage, and created/updated timestamps.",
    schema({
      ...filters([
        "id",
        "title",
        "source_status",
        "source_stage",
        "is_active",
        "probability",
        "client.id",
        "client.name",
        "contact.id",
        "responsible_member.id",
        "record_lineage.source_record_id",
        "record_lineage.integration_configuration.id",
        "record_lineage.integration_configuration.vendor.id",
        "record_lineage.integration_configuration.vendor.brand_name",
        "record_created_at",
        "record_updated_at",
      ]),
      ...paginationProps,
    }),
    (c, a) => c.coreClients.listOpportunities(listParams(a)),
    {
      message:
        "No filters provided — this lists opportunities across every client. Optionally enter a client name to narrow the results (leave empty to list all).",
      argName: "client.name",
      isFilterKey: true,
    }
  ),
  ro(
    "scalepad_core_opportunities_get",
    "Get a single ScalePad Core opportunity by id (read-only).",
    idSchema("Core opportunity id"),
    (c, a) => c.coreClients.getOpportunity(req(a, "id"))
  ),
  ro(
    "scalepad_core_sites_list",
    "List ScalePad Core sites (read-only, cursor-paginated; page_size 1-200, default 25). Filterable by client and record lineage.",
    schema({
      ...filters([
        "id",
        "client.id",
        "record_lineage.source_record_id",
        "record_lineage.integration_configuration.id",
        "record_lineage.integration_configuration.vendor.id",
        "record_lineage.integration_configuration.vendor.brand_name",
      ]),
      ...paginationProps,
    }),
    (c, a) => c.coreClients.listSites(listParams(a)),
    {
      message:
        "No filters provided — this lists sites across every client. Optionally enter a client id to narrow the results (leave empty to list all).",
      argName: "client.id",
      isFilterKey: true,
    }
  ),
  ro(
    "scalepad_core_sites_get",
    "Get a single ScalePad Core site by id (read-only).",
    idSchema("Core site id"),
    (c, a) => c.coreClients.getSite(req(a, "id"))
  ),

  // ── coreAssets ─────────────────────────────────────────────────────────────
  ro(
    "scalepad_core_hardware_assets_list",
    "List ScalePad Core hardware assets (read-only, cursor-paginated). Filterable by name, client, contact, manufacturer, model, serial number, type, location, and CPU/RAM/disk configuration.",
    schema({
      ...filters([
        "id",
        "name",
        "client.id",
        "client.name",
        "contact.id",
        "manufacturer.id",
        "manufacturer.name",
        "model.number",
        "serial_number",
        "type",
        "location_name",
        "configuration.cpu.name",
        "configuration.cpu.manufacturer_name",
        "configuration.cpu.manufacturer_id",
        "configuration.ram_bytes",
        "configuration.disks.total_bytes",
      ]),
      ...paginationProps,
    }),
    (c, a) => c.coreAssets.listHardwareAssets(listParams(a)),
    {
      message:
        "No filters provided — this lists hardware assets across every client. Optionally enter a client name to narrow the results (leave empty to list all).",
      argName: "client.name",
      isFilterKey: true,
    }
  ),
  ro(
    "scalepad_core_hardware_assets_get",
    "Get a single ScalePad Core hardware asset by id (read-only).",
    idSchema("Core hardware asset id"),
    (c, a) => c.coreAssets.getHardwareAsset(req(a, "id"))
  ),
  ro(
    "scalepad_core_saas_assets_list",
    "List ScalePad Core SaaS assets (read-only, cursor-paginated). Filterable by client, product/manufacturer/SKU, status, tenant domain, term dates, auto-renewal, and subscription id.",
    schema({
      ...filters([
        "id",
        "client.id",
        "client.name",
        "product.manufacturer.id",
        "product.manufacturer.name",
        "product.id",
        "product.name",
        "product.category",
        "product.manufacturer_sku.id",
        "product.manufacturer_sku.name",
        "status",
        "tenant_domain",
        "term.starts_at",
        "term.ends_at",
        "term.is_auto_renewed",
        "subscriptions.id",
      ]),
      ...paginationProps,
    }),
    (c, a) => c.coreAssets.listSaasAssets(listParams(a)),
    {
      message:
        "No filters provided — this lists SaaS assets across every client. Optionally enter a client name to narrow the results (leave empty to list all).",
      argName: "client.name",
      isFilterKey: true,
    }
  ),
  ro(
    "scalepad_core_saas_assets_get",
    "Get a single ScalePad Core SaaS asset by id (read-only).",
    idSchema("Core SaaS asset id"),
    (c, a) => c.coreAssets.getSaasAsset(req(a, "id"))
  ),
  ro(
    "scalepad_core_saas_users_list",
    "List ScalePad Core SaaS users (read-only, cursor-paginated). Filterable by client, contact, parent asset and its status, product/manufacturer/SKU, term dates, and subscription id.",
    schema({
      ...filters([
        "id",
        "client.id",
        "client.name",
        "contact.id",
        "asset.id",
        "asset.status",
        "product.manufacturer.id",
        "product.manufacturer.name",
        "product.id",
        "product.name",
        "product.category",
        "product.manufacturer_sku.id",
        "product.manufacturer_sku.name",
        "term.starts_at",
        "term.ends_at",
        "subscription.id",
      ]),
      ...paginationProps,
    }),
    (c, a) => c.coreAssets.listSaasUsers(listParams(a)),
    {
      message:
        "No filters provided — this lists SaaS users across every client. Optionally enter a client name to narrow the results (leave empty to list all).",
      argName: "client.name",
      isFilterKey: true,
    }
  ),
  ro(
    "scalepad_core_saas_users_get",
    "Get a single ScalePad Core SaaS user by id (read-only).",
    idSchema("Core SaaS user id"),
    (c, a) => c.coreAssets.getSaasUser(req(a, "id"))
  ),
  ro(
    "scalepad_core_product_catalog_list",
    "List ScalePad Core product catalog records (read-only, cursor-paginated). Filterable by source system/product, name, category/subcategory, product type/class, manufacturer, active flag, updated timestamp, and lineage.",
    schema({
      ...filters([
        "id",
        "source_system",
        "source_product_id",
        "source_product_identifier",
        "name",
        "category",
        "subcategory",
        "product_type",
        "product_class",
        "manufacturer_name",
        "is_active",
        "updated_at",
        "record_lineage.source_record_id",
        "record_lineage.integration_configuration.id",
        "record_lineage.integration_configuration.vendor.id",
        "record_lineage.integration_configuration.vendor.brand_name",
      ]),
      ...paginationProps,
    }),
    (c, a) => c.coreAssets.listProductCatalog(listParams(a)),
    {
      message:
        "No filters provided — this lists the whole product catalog. Optionally enter a product name to narrow the results (leave empty to list all).",
      argName: "name",
      isFilterKey: true,
    }
  ),
  ro(
    "scalepad_core_product_catalog_get",
    "Get a single ScalePad Core product catalog record by id (read-only).",
    idSchema("Core product catalog record id"),
    (c, a) => c.coreAssets.getProductCatalogRecord(req(a, "id"))
  ),

  // ── coreService ────────────────────────────────────────────────────────────
  ro(
    "scalepad_core_integration_configurations_list",
    "List ScalePad Core integration configurations (read-only; no filters or pagination).",
    schema({}),
    (c) => c.coreService.listIntegrationConfigurations()
  ),
  ro(
    "scalepad_core_integration_vendors_list",
    "List ScalePad Core integration vendors (read-only, cursor-paginated; page_size 1-200, default 25). Filterable by name, vendor id, and category.",
    schema({
      ...filters(["name", "vendor_id", "category"]),
      ...paginationProps,
    }),
    (c, a) => c.coreService.listIntegrationVendors(listParams(a))
  ),
  ro(
    "scalepad_core_contracts_list",
    "List ScalePad Core service contracts (read-only, cursor-paginated). Filterable by name, client, contact, recurrence, type, term dates/billing period, source type, addendum flag, parent contract, and status.",
    schema({
      ...filters([
        "id",
        "name",
        "client.id",
        "client.name",
        "contact.id",
        "is_recurring",
        "type",
        "term.starts_at",
        "term.ends_at",
        "term.is_auto_renew",
        "term.billing_period",
        "source_type",
        "is_addendum",
        "parent_contract.id",
        "parent_contract.name",
        "status",
      ]),
      ...paginationProps,
    }),
    (c, a) => c.coreService.listContracts(listParams(a)),
    {
      message:
        "No filters provided — this lists contracts across every client. Optionally enter a client name to narrow the results (leave empty to list all).",
      argName: "client.name",
      isFilterKey: true,
    }
  ),
  ro(
    "scalepad_core_contracts_get",
    "Get a single ScalePad Core service contract by id (read-only).",
    idSchema("Core service contract id"),
    (c, a) => c.coreService.getContract(req(a, "id"))
  ),
  ro(
    "scalepad_core_tickets_list",
    "List ScalePad Core service tickets (read-only, cursor-paginated). Filterable by owner/responsible member, client, contact, contract, board, category, child/long flags, and timeline created/updated/responded timestamps.",
    schema({
      ...filters([
        "id",
        "owner_member.id",
        "responsible_member.id",
        "client.id",
        "client.name",
        "contact.id",
        "contract.id",
        "contract.name",
        "board.id",
        "board.name",
        "category",
        "is_child_ticket",
        "is_long_ticket",
        "timeline.created_at",
        "timeline.updated_at",
        "timeline.responded_at",
      ]),
      ...paginationProps,
    }),
    (c, a) => c.coreService.listTickets(listParams(a)),
    {
      message:
        "No filters provided — this lists tickets across every client. Optionally enter a client name to narrow the results (leave empty to list all).",
      argName: "client.name",
      isFilterKey: true,
    }
  ),
  ro(
    "scalepad_core_tickets_get",
    "Get a single ScalePad Core service ticket by id (read-only).",
    idSchema("Core service ticket id"),
    (c, a) => c.coreService.getTicket(req(a, "id"))
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
      content: [{ type: "text", text: `Unknown core tool: ${toolName}` }],
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
