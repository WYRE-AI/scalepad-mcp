/**
 * Quoter domain handler
 *
 * Quotes, catalog (items, item groups, options, tiers, categories,
 * manufacturers), contacts, suppliers, and OAuth helpers.
 *
 * Two access paths exist for the same product:
 * - PRIMARY (default): ScalePad-hosted at https://api.scalepad.com/quoter with
 *   the unified ScalePad API key. Endpoints 402 without a Quoter subscription.
 * - LEGACY STANDALONE: https://api.quoter.com with OAuth2 client-credentials —
 *   used automatically when quoterClientId/quoterClientSecret are configured.
 *   The scalepad_quoter_auth_* tools ONLY apply to the standalone path.
 *
 * Tool naming: scalepad_quoter_<entity>_<operation>.
 */
import type { Tool } from "@modelcontextprotocol/server";
import type { ScalePadClient } from "@wyre-technology/node-scalepad";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { getClient } from "../utils/client.js";
import { logger } from "../utils/logger.js";
import { elicitSelection, elicitConfirmation } from "../utils/elicitation.js";

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

const PAGINATION_NOTE =
  "Cursor-paginated: pass page_size (1-200, default 50) and the cursor returned by the previous page.";

/** Standard list-tool pagination properties. */
const pageProps = {
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

const fieldsProp = {
  type: "string",
  description: "Comma-separated list of fields to include in the response",
} as const;

const TOOLS: ToolDef[] = [
  // -------------------------------------------------------------------------
  // quoterQuotes
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_quoter_quotes_list",
      description:
        `List Quoter quotes. ${PAGINATION_NOTE} Filterable by draft status, stage, name, client, custom number, email status, recurring interval, LM initiative, UUID, and created/updated/won/expired timestamps.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_id: { type: "string", description: "Filter by quote ID (filter[id])" },
          filter_uuid: { type: "string", description: "Filter by quote UUID (filter[uuid])" },
          filter_name: { type: "string", description: "Filter by quote name (filter[name])" },
          filter_client_id: { type: "string", description: "Filter by client ID (filter[client.id])" },
          filter_custom_number: { type: "string", description: "Filter by custom quote number (filter[custom_number])" },
          filter_draft: { type: "boolean", description: "Filter by draft status (filter[draft])" },
          filter_stage: { type: "string", description: "Filter by quote stage (filter[stage])" },
          filter_email_status: { type: "string", description: "Filter by email status (filter[email_status])" },
          filter_primary: { type: "boolean", description: "Filter to primary quotes (filter[primary])" },
          filter_recurring_interval: { type: "string", description: "Filter by recurring interval (filter[recurring_interval])" },
          filter_lm_initiative_id: { type: "string", description: "Filter by linked Lifecycle Manager initiative ID (filter[lm_initiative_id])" },
          filter_expired_at: { type: "string", description: "Filter by expiry timestamp, ISO 8601 (filter[expired_at])" },
          filter_won_at: { type: "string", description: "Filter by won timestamp, ISO 8601 (filter[won_at])" },
          filter_record_created_at: { type: "string", description: "Filter by record creation timestamp, ISO 8601 (filter[record_created_at])" },
          filter_record_updated_at: { type: "string", description: "Filter by record update timestamp, ISO 8601 (filter[record_updated_at])" },
          ...pageProps,
        },
      },
    },
    invoke: async (client, args) => {
      const p = params(args, {
        filter_id: "filter[id]",
        filter_uuid: "filter[uuid]",
        filter_name: "filter[name]",
        filter_client_id: "filter[client.id]",
        filter_custom_number: "filter[custom_number]",
        filter_draft: "filter[draft]",
        filter_stage: "filter[stage]",
        filter_email_status: "filter[email_status]",
        filter_primary: "filter[primary]",
        filter_recurring_interval: "filter[recurring_interval]",
        filter_lm_initiative_id: "filter[lm_initiative_id]",
        filter_expired_at: "filter[expired_at]",
        filter_won_at: "filter[won_at]",
        filter_record_created_at: "filter[record_created_at]",
        filter_record_updated_at: "filter[record_updated_at]",
        sort: "sort",
        page_size: "page_size",
        cursor: "cursor",
      });
      // Zero-filter default: offer a draft-status scope before listing everything.
      const hasFilter = Object.keys(p).some((k) => k.startsWith("filter["));
      if (!hasFilter) {
        try {
          const selection = await elicitSelection(
            "No filters provided. Which quotes would you like to list?",
            "scope",
            [
              { value: "draft", label: "Draft quotes only" },
              { value: "published", label: "Published (non-draft) quotes only" },
              { value: "all", label: "All quotes (no filter)" },
            ]
          );
          if (selection === "draft") p["filter[draft]"] = true;
          if (selection === "published") p["filter[draft]"] = false;
        } catch {
          // Elicitation unsupported — proceed with the unfiltered list.
        }
      }
      return client.quoterQuotes.list(p as never);
    },
  },
  {
    tool: {
      name: "scalepad_quoter_quotes_get",
      description:
        "Fetch a single Quoter quote by ID, including its sections and line items. (ScalePad-hosted path only — the standalone api.quoter.com docs do not expose Fetch Quote.)",
      inputSchema: {
        type: "object" as const,
        properties: {
          quote_id: { type: "string", description: "Quote ID" },
        },
        required: ["quote_id"],
      },
    },
    invoke: (client, args) => client.quoterQuotes.get(args.quote_id as string),
  },
  {
    tool: {
      name: "scalepad_quoter_quotes_create",
      description:
        "⚠ HIGH-IMPACT. Create a new Quoter quote (draft) for a contact from a quote template. Optional cover page, comments, currency, custom number, expiry, and internal notes. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Quote", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          contact: {
            type: "object",
            description: "Contact for the quote (e.g. { id } of an existing Quoter contact)",
          },
          template_id: { type: "string", description: "Quote template ID (see scalepad_quoter_quote_templates_list)" },
          comments: { type: "string", description: "Comments shown on the quote" },
          cover_page_title: { type: "string", description: "Cover page title" },
          cover_page_subtitle: { type: "string", description: "Cover page subtitle" },
          cover_page_content: { type: "string", description: "Cover page content" },
          currency_iso: { type: "string", description: "ISO 4217 currency code (e.g. USD)" },
          custom_number: { type: "string", description: "Custom quote number" },
          expired_at: { type: "string", description: "Expiry timestamp, ISO 8601" },
          internal_notes: { type: "string", description: "Internal notes (not shown to the customer)" },
        },
        required: ["contact", "template_id"],
      },
    },
    invoke: (client, args) => client.quoterQuotes.create(bodyExcept(args, []) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_quotes_publish",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Publish a Quoter quote, making it visible/deliverable to the customer. A published quote cannot be reverted to draft. Confirm with the user before invoking.",
      annotations: {
        title: "Publish Quote",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          quote_id: { type: "string", description: "Quote ID to publish" },
        },
        required: ["quote_id"],
      },
    },
    invoke: (client, args) => client.quoterQuotes.publish(args.quote_id as string),
  },
  {
    tool: {
      name: "scalepad_quoter_quotes_create_section",
      description:
        "⚠ HIGH-IMPACT. Create a named section on a Quoter quote (sections group line items). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Quote Section", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          quote_id: { type: "string", description: "Quote ID" },
          name: { type: "string", description: "Section name" },
        },
        required: ["quote_id", "name"],
      },
    },
    invoke: (client, args) =>
      client.quoterQuotes.createSection(
        args.quote_id as string,
        bodyExcept(args, ["quote_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_quotes_create_section_line_item",
      description:
        "⚠ HIGH-IMPACT. Create a line item inside a specific section of a Quoter quote (name, quantity, pricing, discount, recurring interval, SKU/code, manufacturer, supplier). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Quote Section Line Item", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          quote_id: { type: "string", description: "Quote ID" },
          section_id: { type: "string", description: "Quote section ID" },
          name: { type: "string", description: "Line item name" },
          description: { type: "string", description: "Line item description" },
          category: { type: "string", description: "Item category" },
          code: { type: "string", description: "Item code" },
          sku: { type: "string", description: "SKU" },
          manufacturer: { type: "string", description: "Manufacturer name" },
          supplier: { type: "string", description: "Supplier name" },
          quantity_decimal: { type: "string", description: "Quantity (decimal, as a string)" },
          discount: { type: "string", description: "Discount amount or percentage" },
          recurring_interval: { type: "string", description: "Recurring interval (e.g. monthly, yearly); omit for one-time" },
        },
        required: ["quote_id", "section_id", "name"],
      },
    },
    invoke: (client, args) =>
      client.quoterQuotes.createSectionLineItem(
        args.quote_id as string,
        args.section_id as string,
        bodyExcept(args, ["quote_id", "section_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_quotes_update_line_item",
      description:
        "⚠ HIGH-IMPACT. Partially update a line item within a section of a Quoter quote. Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Patch Quote Line Item", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          quote_id: { type: "string", description: "Quote ID" },
          section_id: { type: "string", description: "Quote section ID" },
          line_item_id: { type: "string", description: "Line item ID" },
          name: { type: "string", description: "Line item name" },
          description: { type: "string", description: "Line item description" },
          category: { type: "string", description: "Item category" },
          code: { type: "string", description: "Item code" },
          sku: { type: "string", description: "SKU" },
          manufacturer: { type: "string", description: "Manufacturer name" },
          supplier: { type: "string", description: "Supplier name" },
          quantity_decimal: { type: "string", description: "Quantity (decimal, as a string)" },
          discount: { type: "string", description: "Discount amount or percentage" },
          recurring_interval: { type: "string", description: "Recurring interval (e.g. monthly, yearly); omit for one-time" },
        },
        required: ["quote_id", "section_id", "line_item_id"],
      },
    },
    invoke: (client, args) =>
      client.quoterQuotes.updateSectionLineItem(
        args.quote_id as string,
        args.section_id as string,
        args.line_item_id as string,
        bodyExcept(args, ["quote_id", "section_id", "line_item_id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_line_items_create",
      description:
        "⚠ HIGH-IMPACT. Create a line item on a Quoter quote (top-level /v1/line-items endpoint; the quote is addressed by quote_id in the body). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Line Item", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          quote_id: { type: "string", description: "Quote ID the line item belongs to" },
          name: { type: "string", description: "Line item name" },
          quantity: { type: "number", description: "Quantity" },
          category: { type: "string", description: "Item category" },
          description: { type: "string", description: "Line item description" },
          manufacturer: { type: "string", description: "Manufacturer name" },
          part_number: { type: "string", description: "Manufacturer part number" },
          recurring: { type: "boolean", description: "Whether the line item is recurring" },
          supplier: { type: "string", description: "Supplier name" },
          supplier_sku: { type: "string", description: "Supplier SKU" },
        },
        required: ["quote_id", "name"],
      },
    },
    invoke: (client, args) => client.quoterQuotes.createLineItem(bodyExcept(args, []) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_quote_templates_list",
      description: `List Quoter quote templates (used as the template_id when creating quotes). ${PAGINATION_NOTE} Filterable by title.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_title: { type: "string", description: "Filter by template title (filter[title])" },
          ...pageProps,
        },
      },
    },
    invoke: (client, args) =>
      client.quoterQuotes.listTemplates(
        params(args, {
          filter_title: "filter[title]",
          sort: "sort",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },

  // -------------------------------------------------------------------------
  // quoterCatalog — categories
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_quoter_categories_list",
      description: `List Quoter catalog categories. ${PAGINATION_NOTE} Filterable by name, parent category, and created/updated timestamps.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_name: { type: "string", description: "Filter by category name (filter[name])" },
          filter_parent_category_id: { type: "string", description: "Filter by parent category ID (filter[parent_category_id])" },
          filter_record_created_at: { type: "string", description: "Filter by creation timestamp, ISO 8601 (filter[record_created_at])" },
          filter_record_updated_at: { type: "string", description: "Filter by update timestamp, ISO 8601 (filter[record_updated_at])" },
          fields: fieldsProp,
          ...pageProps,
        },
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.listCategories(
        params(args, {
          filter_name: "filter[name]",
          filter_parent_category_id: "filter[parent_category_id]",
          filter_record_created_at: "filter[record_created_at]",
          filter_record_updated_at: "filter[record_updated_at]",
          fields: "fields",
          sort: "sort",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_categories_create",
      description:
        "⚠ HIGH-IMPACT. Create a Quoter catalog category (optionally nested under a parent category). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Category", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Category name" },
          parent_category: { type: "string", description: "Parent category name" },
          parent_category_id: { type: "string", description: "Parent category ID" },
        },
        required: ["name"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.createCategory(bodyExcept(args, []) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_categories_get",
      description: "Fetch a single Quoter catalog category by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Category ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.getCategory(args.id as string),
  },
  {
    tool: {
      name: "scalepad_quoter_categories_update",
      description:
        "⚠ HIGH-IMPACT. Update a Quoter catalog category (name and/or parent). Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Category", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Category ID" },
          name: { type: "string", description: "Category name" },
          parent_category: { type: "string", description: "Parent category name" },
          parent_category_id: { type: "string", description: "Parent category ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.updateCategory(args.id as string, bodyExcept(args, ["id"]) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_categories_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a Quoter catalog category. Confirm with the user before invoking.",
      annotations: {
        title: "Delete Category",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Category ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.deleteCategory(args.id as string),
  },

  // -------------------------------------------------------------------------
  // quoterCatalog — item group assignments
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_quoter_item_group_assignments_list",
      description: `List Quoter item-group assignments (which items belong to which item groups). ${PAGINATION_NOTE} Filterable by item group, item, and created/updated timestamps.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_item_group_id: { type: "string", description: "Filter by item group ID (filter[item_group_id])" },
          filter_item_id: { type: "string", description: "Filter by item ID (filter[item_id])" },
          filter_record_created_at: { type: "string", description: "Filter by creation timestamp, ISO 8601 (filter[record_created_at])" },
          filter_record_updated_at: { type: "string", description: "Filter by update timestamp, ISO 8601 (filter[record_updated_at])" },
          fields: fieldsProp,
          ...pageProps,
        },
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.listItemGroupAssignments(
        params(args, {
          filter_item_group_id: "filter[item_group_id]",
          filter_item_id: "filter[item_id]",
          filter_record_created_at: "filter[record_created_at]",
          filter_record_updated_at: "filter[record_updated_at]",
          fields: "fields",
          sort: "sort",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_item_group_assignments_create",
      description:
        "⚠ HIGH-IMPACT. Assign a Quoter catalog item to an item group. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Item Group Assignment", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          item_group_id: { type: "string", description: "Item group ID" },
          item_id: { type: "string", description: "Item ID" },
        },
        required: ["item_group_id", "item_id"],
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.createItemGroupAssignment(bodyExcept(args, []) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_item_group_assignments_get",
      description: "Fetch a single Quoter item-group assignment by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item group assignment ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.getItemGroupAssignment(args.id as string),
  },
  {
    tool: {
      name: "scalepad_quoter_item_group_assignments_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a Quoter item-group assignment (removes the item from the group). Confirm with the user before invoking.",
      annotations: {
        title: "Delete Item Group Assignment",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item group assignment ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.deleteItemGroupAssignment(args.id as string),
  },

  // -------------------------------------------------------------------------
  // quoterCatalog — item groups
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_quoter_item_groups_list",
      description: `List Quoter item groups (bundles of catalog items). ${PAGINATION_NOTE} Filterable by name and created/updated timestamps.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_name: { type: "string", description: "Filter by item group name (filter[name])" },
          filter_record_created_at: { type: "string", description: "Filter by creation timestamp, ISO 8601 (filter[record_created_at])" },
          filter_record_updated_at: { type: "string", description: "Filter by update timestamp, ISO 8601 (filter[record_updated_at])" },
          fields: fieldsProp,
          ...pageProps,
        },
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.listItemGroups(
        params(args, {
          filter_name: "filter[name]",
          filter_record_created_at: "filter[record_created_at]",
          filter_record_updated_at: "filter[record_updated_at]",
          fields: "fields",
          sort: "sort",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_item_groups_create",
      description:
        "⚠ HIGH-IMPACT. Create a Quoter item group. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Item Group", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Item group name" },
        },
        required: ["name"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.createItemGroup(bodyExcept(args, []) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_item_groups_get",
      description: "Fetch a single Quoter item group by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item group ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.getItemGroup(args.id as string),
  },
  {
    tool: {
      name: "scalepad_quoter_item_groups_update",
      description:
        "⚠ HIGH-IMPACT. Update a Quoter item group's name. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Item Group", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item group ID" },
          name: { type: "string", description: "Item group name" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.updateItemGroup(args.id as string, bodyExcept(args, ["id"]) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_item_groups_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a Quoter item group. Confirm with the user before invoking.",
      annotations: {
        title: "Delete Item Group",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item group ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.deleteItemGroup(args.id as string),
  },

  // -------------------------------------------------------------------------
  // quoterCatalog — item option values
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_quoter_item_option_values_list",
      description: `List Quoter item option values (the selectable values of an item option, with cost/price). ${PAGINATION_NOTE} Filterable by item, option, name, code, and created/updated timestamps.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_item_id: { type: "string", description: "Filter by item ID (filter[item_id])" },
          filter_item_option_id: { type: "string", description: "Filter by item option ID (filter[item_option_id])" },
          filter_name: { type: "string", description: "Filter by value name (filter[name])" },
          filter_code: { type: "string", description: "Filter by value code (filter[code])" },
          filter_record_created_at: { type: "string", description: "Filter by creation timestamp, ISO 8601 (filter[record_created_at])" },
          filter_record_updated_at: { type: "string", description: "Filter by update timestamp, ISO 8601 (filter[record_updated_at])" },
          fields: fieldsProp,
          ...pageProps,
        },
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.listItemOptionValues(
        params(args, {
          filter_item_id: "filter[item_id]",
          filter_item_option_id: "filter[item_option_id]",
          filter_name: "filter[name]",
          filter_code: "filter[code]",
          filter_record_created_at: "filter[record_created_at]",
          filter_record_updated_at: "filter[record_updated_at]",
          fields: "fields",
          sort: "sort",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_item_option_values_create",
      description:
        "⚠ HIGH-IMPACT. Create a value for a Quoter item option (name, code, cost/price, pricing scheme, sort order). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Item Option Value", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          item_option_id: { type: "string", description: "Item option ID this value belongs to" },
          name: { type: "string", description: "Value name" },
          code: { type: "string", description: "Value code" },
          cost_decimal: { type: "string", description: "Cost (decimal, as a string)" },
          cost_type: { type: "string", description: "Cost type" },
          price_decimal: { type: "string", description: "Price (decimal, as a string)" },
          pricing_scheme: { type: "string", description: "Pricing scheme" },
          sort_order: { type: "number", description: "Sort order among the option's values" },
        },
        required: ["item_option_id", "name"],
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.createItemOptionValue(bodyExcept(args, []) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_item_option_values_get",
      description: "Fetch a single Quoter item option value by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item option value ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.getItemOptionValue(args.id as string),
  },
  {
    tool: {
      name: "scalepad_quoter_item_option_values_update",
      description:
        "⚠ HIGH-IMPACT. Update a Quoter item option value (name, code, cost/price, pricing scheme, sort order). Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Item Option Value", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item option value ID" },
          name: { type: "string", description: "Value name" },
          code: { type: "string", description: "Value code" },
          cost_decimal: { type: "string", description: "Cost (decimal, as a string)" },
          cost_type: { type: "string", description: "Cost type" },
          price_decimal: { type: "string", description: "Price (decimal, as a string)" },
          pricing_scheme: { type: "string", description: "Pricing scheme" },
          sort_order: { type: "number", description: "Sort order among the option's values" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.updateItemOptionValue(
        args.id as string,
        bodyExcept(args, ["id"]) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_item_option_values_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a Quoter item option value. Confirm with the user before invoking.",
      annotations: {
        title: "Delete Item Option Value",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item option value ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.deleteItemOptionValue(args.id as string),
  },

  // -------------------------------------------------------------------------
  // quoterCatalog — item options
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_quoter_item_options_list",
      description: `List Quoter item options (configurable choices on a catalog item). ${PAGINATION_NOTE} Filterable by item, name, and created/updated timestamps.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_item_id: { type: "string", description: "Filter by item ID (filter[item_id])" },
          filter_name: { type: "string", description: "Filter by option name (filter[name])" },
          filter_record_created_at: { type: "string", description: "Filter by creation timestamp, ISO 8601 (filter[record_created_at])" },
          filter_record_updated_at: { type: "string", description: "Filter by update timestamp, ISO 8601 (filter[record_updated_at])" },
          fields: fieldsProp,
          ...pageProps,
        },
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.listItemOptions(
        params(args, {
          filter_item_id: "filter[item_id]",
          filter_name: "filter[name]",
          filter_record_created_at: "filter[record_created_at]",
          filter_record_updated_at: "filter[record_updated_at]",
          fields: "fields",
          sort: "sort",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_item_options_create",
      description:
        "⚠ HIGH-IMPACT. Create an option on a Quoter catalog item (e.g. size or term choices; can be required and/or allow multiple values). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Item Option", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          item_id: { type: "string", description: "Item ID the option belongs to" },
          name: { type: "string", description: "Option name" },
          description: { type: "string", description: "Option description" },
          extended_description: { type: "string", description: "Extended description" },
          required: { type: "boolean", description: "Whether a value must be chosen" },
          allow_multiple_values: { type: "boolean", description: "Whether multiple values may be selected" },
          sort_order: { type: "number", description: "Sort order among the item's options" },
        },
        required: ["item_id", "name"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.createItemOption(bodyExcept(args, []) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_item_options_get",
      description: "Fetch a single Quoter item option by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item option ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.getItemOption(args.id as string),
  },
  {
    tool: {
      name: "scalepad_quoter_item_options_update",
      description:
        "⚠ HIGH-IMPACT. Update a Quoter item option (name, descriptions, required flag, multiple-values flag, sort order). Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Item Option", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item option ID" },
          name: { type: "string", description: "Option name" },
          description: { type: "string", description: "Option description" },
          extended_description: { type: "string", description: "Extended description" },
          required: { type: "boolean", description: "Whether a value must be chosen" },
          allow_multiple_values: { type: "boolean", description: "Whether multiple values may be selected" },
          sort_order: { type: "number", description: "Sort order among the item's options" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.updateItemOption(args.id as string, bodyExcept(args, ["id"]) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_item_options_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a Quoter item option (and its values). Confirm with the user before invoking.",
      annotations: {
        title: "Delete Item Option",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item option ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.deleteItemOption(args.id as string),
  },

  // -------------------------------------------------------------------------
  // quoterCatalog — item tiers
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_quoter_item_tiers_list",
      description: `List Quoter item pricing tiers (quantity-break pricing on a catalog item). ${PAGINATION_NOTE} Filterable by item and created/updated timestamps.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_item_id: { type: "string", description: "Filter by item ID (filter[item_id])" },
          filter_record_created_at: { type: "string", description: "Filter by creation timestamp, ISO 8601 (filter[record_created_at])" },
          filter_record_updated_at: { type: "string", description: "Filter by update timestamp, ISO 8601 (filter[record_updated_at])" },
          fields: fieldsProp,
          ...pageProps,
        },
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.listItemTiers(
        params(args, {
          filter_item_id: "filter[item_id]",
          filter_record_created_at: "filter[record_created_at]",
          filter_record_updated_at: "filter[record_updated_at]",
          fields: "fields",
          sort: "sort",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_item_tiers_create",
      description:
        "⚠ HIGH-IMPACT. Create a pricing tier on a Quoter catalog item (lower quantity boundary with tier cost/price). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Item Tier", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          item_id: { type: "string", description: "Item ID the tier belongs to" },
          lower_boundary: { type: "number", description: "Quantity at which this tier starts" },
          cost_decimal: { type: "string", description: "Tier cost (decimal, as a string)" },
          cost_type: { type: "string", description: "Cost type" },
          price_decimal: { type: "string", description: "Tier price (decimal, as a string)" },
        },
        required: ["item_id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.createItemTier(bodyExcept(args, []) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_item_tiers_get",
      description: "Fetch a single Quoter item pricing tier by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item tier ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.getItemTier(args.id as string),
  },
  {
    tool: {
      name: "scalepad_quoter_item_tiers_update",
      description:
        "⚠ HIGH-IMPACT. Update a Quoter item pricing tier (boundary, cost, price). Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Item Tier", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item tier ID" },
          lower_boundary: { type: "number", description: "Quantity at which this tier starts" },
          cost_decimal: { type: "string", description: "Tier cost (decimal, as a string)" },
          cost_type: { type: "string", description: "Cost type" },
          price_decimal: { type: "string", description: "Tier price (decimal, as a string)" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.updateItemTier(args.id as string, bodyExcept(args, ["id"]) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_item_tiers_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a Quoter item pricing tier. Confirm with the user before invoking.",
      annotations: {
        title: "Delete Item Tier",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item tier ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.deleteItemTier(args.id as string),
  },

  // -------------------------------------------------------------------------
  // quoterCatalog — items
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_quoter_items_list",
      description: `List Quoter catalog items. ${PAGINATION_NOTE} Filterable by name, code, SKU, category, manufacturer, supplier, and created/updated timestamps.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_name: { type: "string", description: "Filter by item name (filter[name])" },
          filter_code: { type: "string", description: "Filter by item code (filter[code])" },
          filter_sku: { type: "string", description: "Filter by SKU (filter[sku])" },
          filter_category_id: { type: "string", description: "Filter by category ID (filter[category_id])" },
          filter_manufacturer_id: { type: "string", description: "Filter by manufacturer ID (filter[manufacturer_id])" },
          filter_supplier_id: { type: "string", description: "Filter by supplier ID (filter[supplier_id])" },
          filter_record_created_at: { type: "string", description: "Filter by creation timestamp, ISO 8601 (filter[record_created_at])" },
          filter_record_updated_at: { type: "string", description: "Filter by update timestamp, ISO 8601 (filter[record_updated_at])" },
          fields: fieldsProp,
          ...pageProps,
        },
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.listItems(
        params(args, {
          filter_name: "filter[name]",
          filter_code: "filter[code]",
          filter_sku: "filter[sku]",
          filter_category_id: "filter[category_id]",
          filter_manufacturer_id: "filter[manufacturer_id]",
          filter_supplier_id: "filter[supplier_id]",
          filter_record_created_at: "filter[record_created_at]",
          filter_record_updated_at: "filter[record_updated_at]",
          fields: "fields",
          sort: "sort",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_items_create",
      description:
        "⚠ HIGH-IMPACT. Create a Quoter catalog item (name, category, code, cost, description, manufacturer, internal note; decimal quantities optional). Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Item", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Item name" },
          category_id: { type: "string", description: "Category ID" },
          category: { type: "string", description: "Category name (alternative to category_id)" },
          code: { type: "string", description: "Item code" },
          cost_decimal: { type: "string", description: "Cost (decimal, as a string)" },
          cost_type: { type: "string", description: "Cost type" },
          description: { type: "string", description: "Item description" },
          internal_note: { type: "string", description: "Internal note (not shown to customers)" },
          manufacturer: { type: "string", description: "Manufacturer name" },
          allow_decimal_quantities: { type: "boolean", description: "Allow decimal quantities on quotes" },
        },
        required: ["name", "category_id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.createItem(bodyExcept(args, []) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_items_get",
      description: "Fetch a single Quoter catalog item by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.getItem(args.id as string),
  },
  {
    tool: {
      name: "scalepad_quoter_items_update",
      description:
        "⚠ HIGH-IMPACT. Update a Quoter catalog item (category, code, cost, description, manufacturer, internal note, decimal-quantity flag). Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Item", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item ID" },
          category_id: { type: "string", description: "Category ID" },
          category: { type: "string", description: "Category name (alternative to category_id)" },
          code: { type: "string", description: "Item code" },
          cost_decimal: { type: "string", description: "Cost (decimal, as a string)" },
          cost_type: { type: "string", description: "Cost type" },
          description: { type: "string", description: "Item description" },
          internal_note: { type: "string", description: "Internal note (not shown to customers)" },
          manufacturer: { type: "string", description: "Manufacturer name" },
          manufacturer_id: { type: "string", description: "Manufacturer ID" },
          allow_decimal_quantities: { type: "boolean", description: "Allow decimal quantities on quotes" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.updateItem(args.id as string, bodyExcept(args, ["id"]) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_items_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a Quoter catalog item. Confirm with the user before invoking.",
      annotations: {
        title: "Delete Item",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Item ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.deleteItem(args.id as string),
  },

  // -------------------------------------------------------------------------
  // quoterCatalog — manufacturers
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_quoter_manufacturers_list",
      description: `List Quoter manufacturers. ${PAGINATION_NOTE} Filterable by name and created/updated timestamps.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_name: { type: "string", description: "Filter by manufacturer name (filter[name])" },
          filter_record_created_at: { type: "string", description: "Filter by creation timestamp, ISO 8601 (filter[record_created_at])" },
          filter_record_updated_at: { type: "string", description: "Filter by update timestamp, ISO 8601 (filter[record_updated_at])" },
          fields: fieldsProp,
          ...pageProps,
        },
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.listManufacturers(
        params(args, {
          filter_name: "filter[name]",
          filter_record_created_at: "filter[record_created_at]",
          filter_record_updated_at: "filter[record_updated_at]",
          fields: "fields",
          sort: "sort",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_manufacturers_create",
      description:
        "⚠ HIGH-IMPACT. Create a Quoter manufacturer. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Manufacturer", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Manufacturer name" },
        },
        required: ["name"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.createManufacturer(bodyExcept(args, []) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_manufacturers_get",
      description: "Fetch a single Quoter manufacturer by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Manufacturer ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.getManufacturer(args.id as string),
  },
  {
    tool: {
      name: "scalepad_quoter_manufacturers_update",
      description:
        "⚠ HIGH-IMPACT. Update a Quoter manufacturer's name. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Manufacturer", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Manufacturer ID" },
          name: { type: "string", description: "Manufacturer name" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) =>
      client.quoterCatalog.updateManufacturer(args.id as string, bodyExcept(args, ["id"]) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_manufacturers_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a Quoter manufacturer. Confirm with the user before invoking.",
      annotations: {
        title: "Delete Manufacturer",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Manufacturer ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterCatalog.deleteManufacturer(args.id as string),
  },

  // -------------------------------------------------------------------------
  // quoterContacts
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_quoter_contacts_list",
      description: `List Quoter contacts. ${PAGINATION_NOTE} Filterable by name, email, billing email, phone, organization, address fields, client, and creation timestamp.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_id: { type: "string", description: "Filter by contact ID (filter[id])" },
          filter_client_id: { type: "string", description: "Filter by client ID (filter[client.id])" },
          filter_first_name: { type: "string", description: "Filter by first name (filter[first_name])" },
          filter_last_name: { type: "string", description: "Filter by last name (filter[last_name])" },
          filter_email: { type: "string", description: "Filter by email (filter[email])" },
          filter_billing_email: { type: "string", description: "Filter by billing email (filter[billing_email])" },
          filter_phone: { type: "string", description: "Filter by phone (filter[phone])" },
          filter_organization: { type: "string", description: "Filter by organization (filter[organization])" },
          filter_address: { type: "string", description: "Filter by address (filter[address])" },
          filter_city: { type: "string", description: "Filter by city (filter[city])" },
          filter_region: { type: "string", description: "Filter by region/state (filter[region])" },
          filter_country: { type: "string", description: "Filter by country (filter[country])" },
          filter_postal_code: { type: "string", description: "Filter by postal code (filter[postal_code])" },
          filter_record_created_at: { type: "string", description: "Filter by creation timestamp, ISO 8601 (filter[record_created_at])" },
          fields: fieldsProp,
          ...pageProps,
        },
      },
    },
    invoke: (client, args) =>
      client.quoterContacts.list(
        params(args, {
          filter_id: "filter[id]",
          filter_client_id: "filter[client.id]",
          filter_first_name: "filter[first_name]",
          filter_last_name: "filter[last_name]",
          filter_email: "filter[email]",
          filter_billing_email: "filter[billing_email]",
          filter_phone: "filter[phone]",
          filter_organization: "filter[organization]",
          filter_address: "filter[address]",
          filter_city: "filter[city]",
          filter_region: "filter[region]",
          filter_country: "filter[country]",
          filter_postal_code: "filter[postal_code]",
          filter_record_created_at: "filter[record_created_at]",
          fields: "fields",
          sort: "sort",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_contacts_create",
      description:
        "⚠ HIGH-IMPACT. Create a Quoter contact with billing and/or shipping details; optionally linked to a client. At minimum provide billing name/email details. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Contact", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          billing_first_name: { type: "string", description: "Billing first name" },
          billing_last_name: { type: "string", description: "Billing last name" },
          billing_email: { type: "string", description: "Billing email" },
          billing_organization: { type: "string", description: "Billing organization" },
          billing_address: { type: "string", description: "Billing address" },
          billing_work_phone: { type: "string", description: "Billing work phone" },
          billing_mobile_phone: { type: "string", description: "Billing mobile phone" },
          client: {
            type: "object",
            description: "Client to link the contact to (e.g. { id })",
          },
          shipping_email: { type: "string", description: "Shipping email" },
          shipping_address: { type: "string", description: "Shipping address" },
        },
      },
    },
    invoke: (client, args) => client.quoterContacts.create(bodyExcept(args, []) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_contacts_get",
      description: "Fetch a single Quoter contact by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Contact ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterContacts.get(args.id as string),
  },
  {
    tool: {
      name: "scalepad_quoter_contacts_update",
      description:
        "⚠ HIGH-IMPACT. Update a Quoter contact's billing and/or shipping details. Only the provided fields change. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Contact", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Contact ID" },
          billing_first_name: { type: "string", description: "Billing first name" },
          billing_last_name: { type: "string", description: "Billing last name" },
          billing_email: { type: "string", description: "Billing email" },
          billing_organization: { type: "string", description: "Billing organization" },
          billing_address: { type: "string", description: "Billing address" },
          billing_work_phone: { type: "string", description: "Billing work phone" },
          billing_mobile_phone: { type: "string", description: "Billing mobile phone" },
          shipping_first_name: { type: "string", description: "Shipping first name" },
          shipping_email: { type: "string", description: "Shipping email" },
          shipping_address: { type: "string", description: "Shipping address" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) =>
      client.quoterContacts.update(args.id as string, bodyExcept(args, ["id"]) as never),
  },

  // -------------------------------------------------------------------------
  // quoterSuppliers
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_quoter_suppliers_list",
      description: `List Quoter suppliers. ${PAGINATION_NOTE} Filterable by name and created/updated timestamps.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_name: { type: "string", description: "Filter by supplier name (filter[name])" },
          filter_record_created_at: { type: "string", description: "Filter by creation timestamp, ISO 8601 (filter[record_created_at])" },
          filter_record_updated_at: { type: "string", description: "Filter by update timestamp, ISO 8601 (filter[record_updated_at])" },
          fields: fieldsProp,
          ...pageProps,
        },
      },
    },
    invoke: (client, args) =>
      client.quoterSuppliers.list(
        params(args, {
          filter_name: "filter[name]",
          filter_record_created_at: "filter[record_created_at]",
          filter_record_updated_at: "filter[record_updated_at]",
          fields: "fields",
          sort: "sort",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_suppliers_create",
      description:
        "⚠ HIGH-IMPACT. Create a Quoter supplier. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Create Supplier", false),
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Supplier name" },
        },
        required: ["name"],
      },
    },
    invoke: (client, args) => client.quoterSuppliers.create(bodyExcept(args, []) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_suppliers_get",
      description: "Fetch a single Quoter supplier by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Supplier ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterSuppliers.get(args.id as string),
  },
  {
    tool: {
      name: "scalepad_quoter_suppliers_update",
      description:
        "⚠ HIGH-IMPACT. Update a Quoter supplier's name. Confirm with the user before invoking.",
      annotations: mutatingAnnotations("Update Supplier", true),
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Supplier ID" },
          name: { type: "string", description: "Supplier name" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) =>
      client.quoterSuppliers.update(args.id as string, bodyExcept(args, ["id"]) as never),
  },
  {
    tool: {
      name: "scalepad_quoter_suppliers_delete",
      description:
        "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently delete a Quoter supplier. Confirm with the user before invoking.",
      annotations: {
        title: "Delete Supplier",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Supplier ID" },
        },
        required: ["id"],
      },
    },
    invoke: (client, args) => client.quoterSuppliers.delete(args.id as string),
  },
  {
    tool: {
      name: "scalepad_quoter_datafeeds_list_supplier_items",
      description: `List supplier items from Quoter's datafeeds (distributor price/availability feeds). ${PAGINATION_NOTE} Filterable by manufacturer part number (MPN).`,
      inputSchema: {
        type: "object" as const,
        properties: {
          filter_mpn: { type: "string", description: "Filter by manufacturer part number (filter[mpn])" },
          page_size: { type: "number", description: "Results per page, 1-200 (default 50)" },
          cursor: { type: "string", description: "Opaque pagination cursor from the previous page" },
        },
      },
    },
    invoke: (client, args) =>
      client.quoterSuppliers.listSupplierItems(
        params(args, {
          filter_mpn: "filter[mpn]",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },
  {
    tool: {
      name: "scalepad_quoter_datafeeds_list_suppliers",
      description: `List suppliers available through Quoter's datafeeds. ${PAGINATION_NOTE}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          sort: { type: "string", description: "Sort expression (field name, prefix with '-' for descending)" },
          page_size: { type: "number", description: "Results per page, 1-200 (default 50)" },
          cursor: { type: "string", description: "Opaque pagination cursor from the previous page" },
        },
      },
    },
    invoke: (client, args) =>
      client.quoterSuppliers.listDatafeedSuppliers(
        params(args, {
          sort: "sort",
          page_size: "page_size",
          cursor: "cursor",
        }) as never
      ),
  },

  // -------------------------------------------------------------------------
  // quoterAuth (standalone api.quoter.com only)
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "scalepad_quoter_auth_authorize",
      description:
        "Exchange Quoter OAuth client credentials (grant_type=client_credentials) for an access_token (1 hour TTL) and refresh_token. STANDALONE api.quoter.com ONLY — not needed for the default ScalePad-hosted path, and requires the X-Quoter-Client-Id / X-Quoter-Client-Secret credentials. Omit client_id/secret to use the configured credentials.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: { type: "string", description: "Quoter OAuth client ID (defaults to the configured quoterClientId)" },
          secret: { type: "string", description: "Quoter OAuth client secret (defaults to the configured quoterClientSecret)" },
          grant_type: { type: "string", description: "OAuth grant type (default: client_credentials)" },
        },
      },
    },
    invoke: (client, args) =>
      client.quoterAuth.authorize({
        ...bodyExcept(args, []),
        grant_type: (args.grant_type as string | undefined) ?? "client_credentials",
      } as never),
  },
  {
    tool: {
      name: "scalepad_quoter_auth_refresh",
      description:
        "Exchange a Quoter refresh_token for a new access/refresh token pair. STANDALONE api.quoter.com ONLY — not needed for the default ScalePad-hosted path.",
      inputSchema: {
        type: "object" as const,
        properties: {
          refresh_token: { type: "string", description: "Refresh token from a previous authorize/refresh call" },
        },
        required: ["refresh_token"],
      },
    },
    invoke: (client, args) =>
      client.quoterAuth.refresh(bodyExcept(args, []) as never),
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
      content: [{ type: "text", text: `Unknown Quoter tool: ${toolName}` }],
      isError: true,
    };
  }

  // Destructive default: ask for confirmation; a null answer (client without
  // elicitation support) proceeds with the original behavior.
  if (def.tool.annotations?.destructiveHint) {
    let confirmed: boolean | null = null;
    try {
      confirmed = await elicitConfirmation(
        `${String(def.tool.annotations.title ?? toolName)} modifies Quoter data. Proceed?`
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
