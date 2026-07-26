/**
 * Tests for the ControlMap domain handler.
 */
import { describe, it, expect, vi } from "vitest";
import { handler } from "./controlmap.js";
import { getClient } from "../utils/client.js";

vi.mock("../utils/client.js", () => ({
  getClient: vi.fn(),
}));

const mockedGetClient = vi.mocked(getClient);

describe("controlmap domain", () => {
  describe("getTools", () => {
    const tools = handler.getTools();

    it("covers every ControlMap endpoint (98 tools)", () => {
      expect(tools).toHaveLength(98);
    });

    it("has unique names, all with the scalepad_cm_ prefix", () => {
      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) {
        expect(name).toMatch(/^scalepad_cm_/);
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

    it("classifies deletes as DESTRUCTIVE — IRREVERSIBLE and other mutations as HIGH-IMPACT", () => {
      const byName = new Map(tools.map((t) => [t.name, t]));
      expect(byName.get("scalepad_cm_risks_delete")?.description).toMatch(
        /^⚠ DESTRUCTIVE — IRREVERSIBLE\./
      );
      expect(byName.get("scalepad_cm_policies_delete_section")?.description).toMatch(
        /^⚠ DESTRUCTIVE — IRREVERSIBLE\./
      );
      expect(byName.get("scalepad_cm_risks_update")?.description).toMatch(
        /^⚠ HIGH-IMPACT\./
      );
      expect(byName.get("scalepad_cm_risks_search")?.annotations).toBeUndefined();
    });
  });

  describe("handleCall", () => {
    it("dispatches scalepad_cm_risks_search through cmRisks.search", async () => {
      const search = vi.fn().mockResolvedValue({ data: [{ id: "r-1" }] });
      mockedGetClient.mockResolvedValue({ cmRisks: { search } } as never);

      const result = await handler.handleCall("scalepad_cm_risks_search", {
        client_id: "c-1",
        page_size: 10,
      });

      expect(search).toHaveBeenCalledWith("c-1", { page_size: 10 });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({ data: [{ id: "r-1" }] });
    });

    it("separates path params from the body for scalepad_cm_risks_update", async () => {
      const update = vi.fn().mockResolvedValue({ id: "r-1", status: "mitigated" });
      mockedGetClient.mockResolvedValue({ cmRisks: { update } } as never);

      const result = await handler.handleCall("scalepad_cm_risks_update", {
        client_id: "c-1",
        risk_id: "r-1",
        status: "mitigated",
      });

      expect(update).toHaveBeenCalledWith("c-1", "r-1", { status: "mitigated" });
      expect(result.isError).toBeUndefined();
    });

    it("proceeds with the destructive scalepad_cm_risks_delete when elicitation is unavailable", async () => {
      const del = vi.fn().mockResolvedValue({});
      mockedGetClient.mockResolvedValue({ cmRisks: { delete: del } } as never);

      const result = await handler.handleCall("scalepad_cm_risks_delete", {
        client_id: "c-1",
        risk_id: "r-1",
      });

      // No server ref in unit tests -> elicitConfirmation returns null -> proceed.
      expect(del).toHaveBeenCalledWith("c-1", "r-1");
      expect(result.isError).toBeUndefined();
    });

    it("returns isError for unknown tools", async () => {
      const result = await handler.handleCall("scalepad_cm_nope", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown ControlMap tool");
    });
  });
});
