/**
 * Tests for the Quoter domain handler.
 */
import { describe, it, expect, vi } from "vitest";
import { handler } from "./quoter.js";
import { getClient } from "../utils/client.js";

vi.mock("../utils/client.js", () => ({
  getClient: vi.fn(),
}));

const mockedGetClient = vi.mocked(getClient);

describe("quoter domain", () => {
  describe("getTools", () => {
    const tools = handler.getTools();

    it("covers every Quoter endpoint (61 tools)", () => {
      expect(tools).toHaveLength(61);
    });

    it("has unique names, all with the scalepad_quoter_ prefix", () => {
      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) {
        expect(name).toMatch(/^scalepad_quoter_/);
      }
    });

    it("declares a literal object inputSchema on every tool", () => {
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
      }
    });

    it("annotates every destructive tool and leaves read-only tools unannotated", () => {
      for (const tool of tools) {
        const destructive = tool.annotations?.destructiveHint === true;
        const prefixed = (tool.description ?? "").startsWith("⚠");
        // The warning prefix and the destructive annotation must agree.
        expect(prefixed).toBe(destructive);
        if (destructive) {
          expect(tool.annotations?.readOnlyHint).toBe(false);
          expect(tool.annotations?.openWorldHint).toBe(true);
          expect(typeof tool.annotations?.title).toBe("string");
          expect(
            (tool.description ?? "").endsWith("Confirm with the user before invoking.")
          ).toBe(true);
        }
      }
    });

    it("marks irreversible deletes and publish as DESTRUCTIVE, other mutations as HIGH-IMPACT", () => {
      const byName = new Map(tools.map((t) => [t.name, t]));
      expect(byName.get("scalepad_quoter_quotes_publish")?.description).toMatch(
        /^⚠ DESTRUCTIVE — IRREVERSIBLE\./
      );
      expect(byName.get("scalepad_quoter_items_delete")?.description).toMatch(
        /^⚠ DESTRUCTIVE — IRREVERSIBLE\./
      );
      expect(byName.get("scalepad_quoter_quotes_create")?.description).toMatch(
        /^⚠ HIGH-IMPACT\./
      );
      expect(byName.get("scalepad_quoter_quotes_list")?.annotations).toBeUndefined();
    });
  });

  describe("handleCall", () => {
    it("dispatches scalepad_quoter_quotes_get through quoterQuotes.get", async () => {
      const get = vi.fn().mockResolvedValue({ id: "q-1", name: "Renewal" });
      mockedGetClient.mockResolvedValue({ quoterQuotes: { get } } as never);

      const result = await handler.handleCall("scalepad_quoter_quotes_get", {
        quote_id: "q-1",
      });

      expect(get).toHaveBeenCalledWith("q-1");
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({ id: "q-1", name: "Renewal" });
    });

    it("maps filter args to bracketed query params for scalepad_quoter_quotes_list", async () => {
      const list = vi.fn().mockResolvedValue({ data: [] });
      mockedGetClient.mockResolvedValue({ quoterQuotes: { list } } as never);

      const result = await handler.handleCall("scalepad_quoter_quotes_list", {
        filter_stage: "won",
        page_size: 5,
      });

      expect(list).toHaveBeenCalledWith({
        "filter[stage]": "won",
        page_size: 5,
      });
      expect(result.isError).toBeUndefined();
    });

    it("proceeds with the destructive scalepad_quoter_categories_delete when elicitation is unavailable", async () => {
      const deleteCategory = vi.fn().mockResolvedValue({});
      mockedGetClient.mockResolvedValue({
        quoterCatalog: { deleteCategory },
      } as never);

      const result = await handler.handleCall("scalepad_quoter_categories_delete", {
        id: "cat-1",
      });

      // No server ref in unit tests -> elicitConfirmation returns null -> proceed.
      expect(deleteCategory).toHaveBeenCalledWith("cat-1");
      expect(result.isError).toBeUndefined();
    });

    it("returns isError for unknown tools", async () => {
      const result = await handler.handleCall("scalepad_quoter_nope", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown Quoter tool");
    });
  });
});
