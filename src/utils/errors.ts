/**
 * Tool-error formatting.
 *
 * The SDK (@wyre-technology/node-scalepad) throws `ScalePadError`s that carry
 * the HTTP `statusCode` and the parsed response body (`response`) but whose
 * `message` is a generic string ("HTTP 422", "Bad request", ...). Surface the
 * status and a scrubbed copy of the vendor's own message so callers can tell
 * what actually went wrong.
 */

const MAX_VENDOR_MESSAGE_LENGTH = 300;

/** Lifecycle Manager budget endpoints answer 422 for clients with no budget set up. */
const LM_BUDGET_TOOL_PREFIX = "scalepad_lm_budget_";
const LM_NO_BUDGET_MESSAGE =
  "No budget is configured for this client in Lifecycle Manager.";

interface ApiErrorLike {
  message: string;
  statusCode: number;
  response?: unknown;
}

function isApiError(error: unknown): error is ApiErrorLike {
  return (
    error instanceof Error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

/** Pull a human-readable message out of a vendor error body, if there is one. */
function extractVendorMessage(body: unknown): string | undefined {
  if (typeof body === "string") {
    const text = body.trim();
    // Skip HTML error pages from proxies/WAFs.
    return text && !text.startsWith("<") ? text : undefined;
  }
  if (Array.isArray(body)) {
    const parts = body.map(extractVendorMessage).filter(Boolean);
    return parts.length ? parts.join("; ") : undefined;
  }
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    for (const key of ["message", "detail", "error", "title", "errors"]) {
      const found = extractVendorMessage(obj[key]);
      if (found) return found;
    }
  }
  return undefined;
}

/** Strip control characters and anything that looks like a credential, then truncate. */
export function scrubVendorMessage(text: string): string {
  const scrubbed = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[-_ ]?key|x-api-key|token|secret|password|authorization)(["']?\s*[:=]\s*)["']?[^\s"',;]+/gi,
      "$1$2[redacted]"
    )
    .replace(/\s+/g, " ")
    .trim();
  return scrubbed.length > MAX_VENDOR_MESSAGE_LENGTH
    ? `${scrubbed.slice(0, MAX_VENDOR_MESSAGE_LENGTH)}...`
    : scrubbed;
}

/**
 * Build the text for an `isError` tool result. Errors that carry an HTTP
 * status are reported as `Error (HTTP <status>): <message>`; anything else
 * keeps the plain `Error: <message>` form.
 */
export function formatToolError(error: unknown, toolName?: string): string {
  if (!isApiError(error)) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }

  const { statusCode } = error;
  const vendorRaw = extractVendorMessage(error.response);
  const vendor = vendorRaw ? scrubVendorMessage(vendorRaw) : undefined;

  if (statusCode === 422 && toolName?.startsWith(LM_BUDGET_TOOL_PREFIX)) {
    return `Error (HTTP 422): ${LM_NO_BUDGET_MESSAGE}${vendor ? ` Vendor message: ${vendor}` : ""}`;
  }

  const sdkMessage = error.message === `HTTP ${statusCode}` ? undefined : error.message;
  const detail = [sdkMessage, vendor]
    .filter((part, i, all) => part && all.indexOf(part) === i)
    .join(": ");
  return detail ? `Error (HTTP ${statusCode}): ${detail}` : `Error: HTTP ${statusCode}`;
}
