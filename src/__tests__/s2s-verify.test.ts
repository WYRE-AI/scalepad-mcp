import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyS2sHeader } from "../s2s-verify.js";

function deriveRecipientSubkey(masterSecret: string, slug: string): string {
  return createHmac("sha256", masterSecret).update(`s2s-recipient:${slug}`).digest("hex");
}

function mintHeader(secret: string, unixSeconds: number): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

describe("verifyS2sHeader", () => {
  const MASTER = "test-master-secret-do-not-use-in-prod";
  const scalepadSubkey = deriveRecipientSubkey(MASTER, "scalepad");
  const siblingSubkey = deriveRecipientSubkey(MASTER, "ninjaone");
  const now = Math.floor(Date.now() / 1000);

  it("accepts a header minted with this vendor's own derived subkey", () => {
    expect(verifyS2sHeader(mintHeader(scalepadSubkey, now), scalepadSubkey)).toBe(true);
  });

  it("REJECTS a header minted for a different vendor's derived subkey (recipient-binding proof)", () => {
    expect(verifyS2sHeader(mintHeader(siblingSubkey, now), scalepadSubkey)).toBe(false);
  });

  it("rejects a stale timestamp outside the skew window", () => {
    expect(verifyS2sHeader(mintHeader(scalepadSubkey, now - 301), scalepadSubkey)).toBe(false);
  });

  it("rejects a future timestamp outside the skew window", () => {
    expect(verifyS2sHeader(mintHeader(scalepadSubkey, now + 301), scalepadSubkey)).toBe(false);
  });

  it("accepts a timestamp at the edge of the skew window", () => {
    expect(verifyS2sHeader(mintHeader(scalepadSubkey, now - 300), scalepadSubkey)).toBe(true);
  });

  it("rejects a malformed header value", () => {
    expect(verifyS2sHeader("not-a-valid-header", scalepadSubkey)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyS2sHeader(undefined, scalepadSubkey)).toBe(false);
  });

  it("rejects when the secret is empty (dark-by-default guarantee)", () => {
    expect(verifyS2sHeader(mintHeader(scalepadSubkey, now), "")).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const header = mintHeader(scalepadSubkey, now);
    const tampered = header.slice(0, -1) + (header.endsWith("0") ? "1" : "0");
    expect(verifyS2sHeader(tampered, scalepadSubkey)).toBe(false);
  });
});
