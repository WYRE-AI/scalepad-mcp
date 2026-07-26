/**
 * Tests for the ScalePad Core domain handler
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock functions via vi.hoisted so they exist when vi.mock is hoisted.
const { mockClientsList, mockClientsGet, mockTicketsList, mockClient } = vi.hoisted(
  () => {
    const mockClientsList = vi.fn();
    const mockClientsGet = vi.fn();
    const mockTicketsList = vi.fn();

    const mockClient = {
      coreClients: {
        listClients: mockClientsList,
        getClient: mockClientsGet,
        listContacts: vi.fn(),
        getContact: vi.fn(),
        listMembers: vi.fn(),
        getMember: vi.fn(),
        listOpportunities: vi.fn(),
        getOpportunity: vi.fn(),
        listSites: vi.fn(),
        getSite: vi.fn(),
      },
      coreAssets: {
        listHardwareAssets: vi.fn(),
        getHardwareAsset: vi.fn(),
        listSaasAssets: vi.fn(),
        getSaasAsset: vi.fn(),
        listSaasUsers: vi.fn(),
        getSaasUser: vi.fn(),
        listProductCatalog: vi.fn(),
        getProductCatalogRecord: vi.fn(),
      },
      coreService: {
        listIntegrationConfigurations: vi.fn(),
        listIntegrationVendors: vi.fn(),
        listContracts: vi.fn(),
        getContract: vi.fn(),
        listTickets: mockTicketsList,
        getTicket: vi.fn(),
      },
    };

    return { mockClientsList, mockClientsGet, mockTicketsList, mockClient };
  }
);

// Mock the client module before importing the handler.
vi.mock("../utils/client.js", () => ({
  getClient: () => Promise.resolve(mockClient),
}));

import { handler } from "./core.js";

describe("Core domain handler", () => {
  beforeEach(() => {
    mockClientsList.mockResolvedValue({
      data: [{ id: "cl-1", name: "Acme Corp" }],
      pagination: { cursor: null },
    });
    mockClientsGet.mockResolvedValue({ id: "cl-1", name: "Acme Corp" });
    mockTicketsList.mockResolvedValue({ data: [], pagination: { cursor: null } });
  });

  describe("getTools", () => {
    it("returns all 24 Core tools with unique, correctly prefixed names", () => {
      const tools = handler.getTools();
      expect(tools.length).toBe(24);

      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) {
        expect(name).toMatch(/^scalepad_core_[a-z0-9_]+$/);
      }
    });

    it("uses literal object inputSchemas everywhere", () => {
      for (const tool of handler.getTools()) {
        expect(tool.inputSchema.type).toBe("object");
      }
    });

    it("has no destructive annotations or warning prefixes (Core is read-only)", () => {
      for (const tool of handler.getTools()) {
        expect(tool.annotations?.destructiveHint).toBeFalsy();
        expect(tool.description?.startsWith("⚠")).toBe(false);
      }
    });

    it("requires id on the get-by-id tools", () => {
      const tools = handler.getTools();
      const getTool = tools.find((t) => t.name === "scalepad_core_clients_get");
      expect(getTool).toBeDefined();
      expect(getTool?.inputSchema.required).toContain("id");
    });
  });

  describe("handleCall", () => {
    it("maps filter object entries onto filter[<key>] params for lists", async () => {
      const result = await handler.handleCall("scalepad_core_clients_list", {
        filter: { name: "Acme" },
        page_size: 5,
      });

      expect(result.isError).toBeUndefined();
      expect(mockClientsList).toHaveBeenCalledWith({
        "filter[name]": "Acme",
        page_size: 5,
      });
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain("Acme Corp");
    });

    it("proceeds unfiltered when a zero-filter list gets no elicitation answer", async () => {
      // No server ref is set in unit tests, so elicitation returns null and the
      // original (unfiltered) call proceeds.
      const result = await handler.handleCall("scalepad_core_clients_list", {});

      expect(result.isError).toBeUndefined();
      expect(mockClientsList).toHaveBeenCalledWith({});
    });

    it("dispatches get-by-id through the SDK client", async () => {
      const result = await handler.handleCall("scalepad_core_clients_get", {
        id: "cl-1",
      });

      expect(result.isError).toBeUndefined();
      expect(mockClientsGet).toHaveBeenCalledWith("cl-1");
      expect(result.content[0]?.text).toContain("cl-1");
    });

    it("returns an in-band error when a required arg is missing", async () => {
      const result = await handler.handleCall("scalepad_core_clients_get", {});

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("id is required");
      expect(mockClientsGet).not.toHaveBeenCalled();
    });

    it("returns isError for unknown tools", async () => {
      const result = await handler.handleCall("scalepad_core_nope", {});

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Unknown core tool");
    });
  });
});
