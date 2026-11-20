/**
 * Tests for the Backup Radar domain handler.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handler } from "./backup-radar.js";
import { getClient, getCredentials } from "../utils/client.js";

vi.mock("../utils/client.js", () => ({
  getClient: vi.fn(),
  getCredentials: vi.fn(),
}));

const mockedGetClient = vi.mocked(getClient);
const mockedGetCredentials = vi.mocked(getCredentials);

function withRegion(region: "us" | "eu" | "ca" | "au" | null) {
  mockedGetCredentials.mockReturnValue(
    region ? ({ apiKey: "k", region, baseUrl: "" } as never) : null
  );
}

describe("backup-radar domain", () => {
  describe("getTools", () => {
    const tools = handler.getTools();

    it("covers every Backup Radar endpoint (3 tools)", () => {
      expect(tools).toHaveLength(3);
    });

    it("has unique names, all with the scalepad_br_ prefix", () => {
      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) {
        expect(name).toMatch(/^scalepad_br_/);
      }
    });

    it("declares a literal object inputSchema on every tool", () => {
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
      }
    });

    it("is entirely read-only: no destructive annotations, no warning prefixes", () => {
      for (const tool of tools) {
        expect(tool.annotations?.destructiveHint).toBeUndefined();
        expect((tool.description ?? "").startsWith("⚠")).toBe(false);
      }
    });
  });

  describe("handleCall", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      withRegion("us");
    });

    it("dispatches scalepad_br_backups_get_health through brBackups.getHealth", async () => {
      const getHealth = vi.fn().mockResolvedValue({ id: "c-1", healthy: 12 });
      mockedGetClient.mockResolvedValue({ brBackups: { getHealth } } as never);

      const result = await handler.handleCall("scalepad_br_backups_get_health", {
        id: "c-1",
        history_days: 30,
      });

      expect(getHealth).toHaveBeenCalledWith("c-1", { history_days: 30 });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({ id: "c-1", healthy: 12 });
    });

    it("maps filter args to bracketed query params for scalepad_br_backups_list_devices", async () => {
      const listDevices = vi.fn().mockResolvedValue({ data: [] });
      mockedGetClient.mockResolvedValue({ brBackups: { listDevices } } as never);

      const result = await handler.handleCall("scalepad_br_backups_list_devices", {
        filter_device_name: "NAS-01",
        page_size: 10,
      });

      expect(listDevices).toHaveBeenCalledWith({
        "filter[device_name]": "NAS-01",
        page_size: 10,
      });
      expect(result.isError).toBeUndefined();
    });

    it("lists health unfiltered when no filters are given and elicitation is unavailable", async () => {
      const listHealth = vi.fn().mockResolvedValue({ data: [] });
      mockedGetClient.mockResolvedValue({ brBackups: { listHealth } } as never);

      const result = await handler.handleCall("scalepad_br_backups_list_health", {});

      // No server ref in unit tests -> elicitation returns null -> original behavior.
      expect(listHealth).toHaveBeenCalledWith({});
      expect(result.isError).toBeUndefined();
    });

    it.each(["ca", "au"] as const)(
      "returns a clear 'not available' error in the %s region without calling the API",
      async (region) => {
        withRegion(region);
        const listDevices = vi.fn();
        mockedGetClient.mockResolvedValue({ brBackups: { listDevices } } as never);

        const result = await handler.handleCall("scalepad_br_backups_list_devices", {});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(`not available in the '${region}' region`);
        expect(result.content[0].text).toContain("us, eu");
        expect(mockedGetClient).not.toHaveBeenCalled();
        expect(listDevices).not.toHaveBeenCalled();
      }
    );

    it("serves the eu region", async () => {
      withRegion("eu");
      const listDevices = vi.fn().mockResolvedValue({ data: [] });
      mockedGetClient.mockResolvedValue({ brBackups: { listDevices } } as never);

      const result = await handler.handleCall("scalepad_br_backups_list_devices", {});

      expect(listDevices).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
    });

    it("defers to getClient (credential error) when no credentials are configured", async () => {
      withRegion(null);
      mockedGetClient.mockRejectedValue(new Error("No API credentials provided."));

      await expect(
        handler.handleCall("scalepad_br_backups_list_devices", {})
      ).rejects.toThrow("No API credentials provided.");
    });

    it("returns isError for unknown tools", async () => {
      const result = await handler.handleCall("scalepad_br_backups_nope", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown Backup Radar tool");
    });
  });
});
