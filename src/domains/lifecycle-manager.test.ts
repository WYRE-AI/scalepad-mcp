/**
 * Tests for the Lifecycle Manager domain handler
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock functions via vi.hoisted so they exist when vi.mock is hoisted.
const {
  mockInitiativesList,
  mockInitiativesDelete,
  mockGoalsCreate,
  mockClient,
} = vi.hoisted(() => {
  const mockInitiativesList = vi.fn();
  const mockInitiativesDelete = vi.fn();
  const mockGoalsCreate = vi.fn();

  // Only the resources/methods exercised by these tests need to exist.
  const mockClient = {
    lmInitiatives: {
      list: mockInitiativesList,
      delete: mockInitiativesDelete,
    },
    lmGoals: {
      create: mockGoalsCreate,
    },
  };

  return { mockInitiativesList, mockInitiativesDelete, mockGoalsCreate, mockClient };
});

// Mock the client module before importing the handler.
vi.mock("../utils/client.js", () => ({
  getClient: () => Promise.resolve(mockClient),
}));

import { handler } from "./lifecycle-manager.js";

const CONFIRM_SUFFIX = "Confirm with the user before invoking.";

describe("Lifecycle Manager domain handler", () => {
  beforeEach(() => {
    mockInitiativesList.mockResolvedValue({
      data: [{ id: "init-1", name: "Server refresh" }],
      pagination: { cursor: null },
    });
    mockInitiativesDelete.mockResolvedValue({});
    mockGoalsCreate.mockResolvedValue({ id: "goal-1", title: "Reduce risk" });
  });

  describe("getTools", () => {
    it("returns all 193 Lifecycle Manager tools with unique, correctly prefixed names", () => {
      const tools = handler.getTools();
      expect(tools.length).toBe(193);

      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) {
        expect(name).toMatch(/^scalepad_lm_[a-z0-9_]+$/);
      }
    });

    it("uses literal object inputSchemas everywhere", () => {
      for (const tool of handler.getTools()) {
        expect(tool.inputSchema.type).toBe("object");
      }
    });

    it("annotates every warning-prefixed tool as destructive, and vice versa", () => {
      for (const tool of handler.getTools()) {
        const hasWarning = tool.description?.startsWith("⚠") ?? false;
        const isDestructive = tool.annotations?.destructiveHint === true;
        expect(hasWarning).toBe(isDestructive);

        if (isDestructive) {
          expect(tool.annotations?.title).toBeTruthy();
          expect(tool.annotations?.readOnlyHint).toBe(false);
          expect(tool.annotations?.openWorldHint).toBe(true);
          expect(typeof tool.annotations?.idempotentHint).toBe("boolean");
          expect(tool.description?.endsWith(CONFIRM_SUFFIX)).toBe(true);
        }
      }
    });

    it("marks irreversible deletes DESTRUCTIVE and reversible updates HIGH-IMPACT", () => {
      const tools = handler.getTools();
      const del = tools.find((t) => t.name === "scalepad_lm_initiatives_delete");
      const update = tools.find((t) => t.name === "scalepad_lm_initiatives_update");
      const list = tools.find((t) => t.name === "scalepad_lm_initiatives_list");

      expect(del?.description).toMatch(/^⚠ DESTRUCTIVE — IRREVERSIBLE\./);
      expect(update?.description).toMatch(/^⚠ HIGH-IMPACT\./);
      expect(list?.annotations?.destructiveHint).toBeFalsy();
      expect(list?.description?.startsWith("⚠")).toBe(false);
    });
  });

  describe("handleCall", () => {
    it("maps filter object entries onto filter[<key>] params for lists", async () => {
      const result = await handler.handleCall("scalepad_lm_initiatives_list", {
        filter: { "client.id": "cl-1", status: "scheduled" },
        page_size: 10,
      });

      expect(result.isError).toBeUndefined();
      expect(mockInitiativesList).toHaveBeenCalledWith({
        "filter[client.id]": "cl-1",
        "filter[status]": "scheduled",
        page_size: 10,
      });
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain("Server refresh");
    });

    it("dispatches destructive calls through the SDK when confirmation is unavailable", async () => {
      // No server ref is set in unit tests, so elicitConfirmation returns null
      // and the original behavior (proceed) applies.
      const result = await handler.handleCall("scalepad_lm_initiatives_delete", {
        id: "init-1",
      });

      expect(result.isError).toBeUndefined();
      expect(mockInitiativesDelete).toHaveBeenCalledWith("init-1");
    });

    it("passes only the documented body fields to create calls", async () => {
      const result = await handler.handleCall("scalepad_lm_goals_create", {
        client_key: "ck-1",
        title: "Reduce risk",
        unrelated: "ignored",
      });

      expect(result.isError).toBeUndefined();
      expect(mockGoalsCreate).toHaveBeenCalledWith({
        client_key: "ck-1",
        title: "Reduce risk",
      });
      expect(result.content[0]?.text).toContain("goal-1");
    });

    it("returns an in-band error when a required arg is missing", async () => {
      const result = await handler.handleCall("scalepad_lm_initiatives_delete", {});

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("id is required");
      expect(mockInitiativesDelete).not.toHaveBeenCalled();
    });

    it("returns isError for unknown tools", async () => {
      const result = await handler.handleCall("scalepad_lm_nope", {});

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Unknown lifecycle-manager tool");
    });
  });
});
