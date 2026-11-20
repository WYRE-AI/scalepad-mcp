/**
 * Tests for tool-error formatting (HTTP status + scrubbed vendor message).
 */
import { describe, it, expect } from "vitest";
import { ScalePadError } from "@wyre-technology/node-scalepad";
import { formatToolError, scrubVendorMessage } from "./errors.js";

describe("formatToolError", () => {
  it("keeps the plain form for errors without an HTTP status", () => {
    expect(formatToolError(new Error("boom"))).toBe("Error: boom");
    expect(formatToolError("oops")).toBe("Error: oops");
  });

  it("includes the status and the vendor's message from a JSON body", () => {
    const err = new ScalePadError("HTTP 409", 409, { message: "Client already exists" });
    expect(formatToolError(err, "scalepad_core_clients_list")).toBe(
      "Error (HTTP 409): Client already exists"
    );
  });

  it("combines the SDK message with the vendor message", () => {
    const err = new ScalePadError("Forbidden", 403, { error: { message: "Key lacks scope" } });
    expect(formatToolError(err)).toBe("Error (HTTP 403): Forbidden: Key lacks scope");
  });

  it("reads messages from errors[] arrays and plain-text bodies", () => {
    const arr = new ScalePadError("HTTP 422", 422, {
      errors: [{ detail: "page_size must be <= 200" }, { detail: "cursor is invalid" }],
    });
    expect(formatToolError(arr, "scalepad_core_clients_list")).toBe(
      "Error (HTTP 422): page_size must be <= 200; cursor is invalid"
    );

    const text = new ScalePadError("HTTP 418", 418, "short and stout");
    expect(formatToolError(text)).toBe("Error (HTTP 418): short and stout");
  });

  it("falls back to the bare status when the body has nothing usable", () => {
    expect(formatToolError(new ScalePadError("HTTP 400", 400, undefined))).toBe(
      "Error: HTTP 400"
    );
    expect(formatToolError(new ScalePadError("HTTP 502", 502, "<html>Bad gateway</html>"))).toBe(
      "Error: HTTP 502"
    );
  });

  it("maps the Lifecycle Manager no-budget 422 to a plain message", () => {
    const err = new ScalePadError("HTTP 422", 422, { message: "Unprocessable Entity" });
    const text = formatToolError(err, "scalepad_lm_budget_summary_get");
    expect(text).toBe(
      "Error (HTTP 422): No budget is configured for this client in Lifecycle Manager. Vendor message: Unprocessable Entity"
    );
  });

  it("maps a budget-tool 422 with no vendor message to the no-budget text", () => {
    const err = new ScalePadError("HTTP 422", 422, undefined);
    expect(formatToolError(err, "scalepad_lm_budget_summary_get")).toBe(
      "Error (HTTP 422): No budget is configured for this client in Lifecycle Manager."
    );
  });

  it("does not remap a budget-tool 422 that is a field-validation error", () => {
    const err = new ScalePadError("HTTP 422", 422, { message: "starting_date must be a date" });
    expect(formatToolError(err, "scalepad_lm_budget_summary_get")).toBe(
      "Error (HTTP 422): starting_date must be a date"
    );
  });

  it("reads OAuth-style error_description in preference to error", () => {
    const err = new ScalePadError("Bad request", 400, {
      error: "invalid_request",
      error_description: "client_id is missing",
    });
    expect(formatToolError(err)).toBe("Error (HTTP 400): Bad request: client_id is missing");
  });

  it("joins field-keyed validation maps as key: message", () => {
    const err = new ScalePadError("Bad request", 400, {
      errors: { page_size: ["too big"], cursor: "is invalid" },
    });
    expect(formatToolError(err)).toBe(
      "Error (HTTP 400): Bad request: page_size: too big; cursor: is invalid"
    );
  });

  it("reports the real 5xx status the SDK's ServerError hard-codes as 500", () => {
    const err = new ScalePadError("Server error: 503", 500, "Service Unavailable");
    expect(formatToolError(err)).toBe(
      "Error (HTTP 503): Server error: 503: Service Unavailable"
    );
  });

  it("does not apply the no-budget mapping to other tools or statuses", () => {
    const err = new ScalePadError("HTTP 422", 422, { message: "Title is required" });
    expect(formatToolError(err, "scalepad_lm_goals_create")).toBe(
      "Error (HTTP 422): Title is required"
    );
    const notFound = new ScalePadError("Resource not found", 404, {});
    expect(formatToolError(notFound, "scalepad_lm_budget_summary_get")).toBe(
      "Error (HTTP 404): Resource not found"
    );
  });

  it("scrubs credentials from the vendor message", () => {
    const err = new ScalePadError("HTTP 400", 400, {
      message: "Bad header x-api-key: abc123SECRET and Authorization=Bearer eyJhbGci.payload.sig",
    });
    const text = formatToolError(err);
    expect(text).not.toContain("abc123SECRET");
    expect(text).not.toContain("eyJhbGci");
  });
});

describe("scrubVendorMessage", () => {
  it.each([
    ["access_token=abc123SECRET", "abc123SECRET"],
    ["refresh_token: abc123SECRET", "abc123SECRET"],
    ["client_secret=abc123SECRET", "abc123SECRET"],
    ["clientSecret: abc123SECRET", "abc123SECRET"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
  ])("redacts %s", (input, secret) => {
    const out = scrubVendorMessage(input);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("collapses control characters and whitespace", () => {
    expect(scrubVendorMessage("line1\n\tline2\u0000  line3")).toBe("line1 line2 line3");
  });

  it("truncates long messages", () => {
    const out = scrubVendorMessage("x".repeat(1000));
    expect(out.length).toBeLessThan(310);
    expect(out.endsWith("...")).toBe(true);
  });
});
