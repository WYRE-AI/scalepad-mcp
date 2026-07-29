/**
 * Regression test: cross-tenant client/credential-override misrouting.
 *
 * `mcp-server.ts`'s `tools/call` handler used to hold per-request gateway
 * credentials in module-level `let _clientOverride` / `let
 * _credentialOverrides` (`setClientOverride` / `setCredentialOverrides`),
 * set synchronously before an `await` (creating the direct client) and
 * cleared in a `finally` after the tool call resolved. In gateway
 * (multi-tenant HTTP) mode this raced: tenant A's request sets its
 * overrides and suspends on that await; before A resumes, tenant B's
 * request runs — overwriting the overrides with B's client/credentials —
 * and its own `finally` clears them back to null once B's call completes,
 * all while A's tool call is still in flight. A then reads back either B's
 * client/credentials or nothing at all instead of its own.
 *
 * This test forces the exact interleave deterministically via a
 * manually-resolved gate promise (not a timing stagger), and asserts BY
 * VALUE that `getClient()`/`getCredentials()` resolve to the correct
 * tenant's own client/credentials throughout — including after the await
 * gap and after a concurrent sibling request has already run to completion
 * and would, under the old module-level implementation, have cleared the
 * shared state out from under the still-in-flight tenant.
 *
 * (Verified by temporarily reinstating the old set-then-clear-in-finally
 * module-singleton implementation behind the same `runWithRequestClient`
 * name: this test fails with tenant A observing tenant B's client, or
 * `null`, after the interleave — and passes again once the ALS-based fix is
 * restored — see the PR description.)
 */
import { describe, it, expect } from "vitest";
import type { ScalePadClient } from "@wyre-technology/node-scalepad";
import { runWithRequestClient, getClient, getCredentials, type ScalePadCredentials } from "./client.js";

/** A deferred promise the test can resolve on demand, for a deterministic forced interleave. */
function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeClient(tenantId: string): ScalePadClient {
  return { tenantId } as unknown as ScalePadClient;
}

function fakeCredentials(tenantId: string): ScalePadCredentials {
  return {
    apiKey: `key-${tenantId}`,
    region: "us",
    baseUrl: "https://example.test",
  };
}

describe("client/credential request-context isolation", () => {
  it("getClient/getCredentials return null/env outside of any bound context", async () => {
    // Outside any runWithRequestClient scope, getClient() falls through to
    // env-based resolution, which throws when no env credentials are
    // configured — getCredentials() returns null in that case.
    expect(getCredentials()).toBeNull();
  });

  it("getClient/getCredentials resolve the values bound by runWithRequestClient within its scope", async () => {
    const client = fakeClient("tenant-X");
    const creds = fakeCredentials("tenant-X");
    await runWithRequestClient(client, creds, async () => {
      expect(await getClient()).toBe(client);
      expect(getCredentials()).toBe(creds);
    });
  });

  it(
    "routes each tenant's client/credentials through its OWN request context, even when a " +
      "second tenant's request runs to completion while the first is still " +
      "in flight (forced deterministic interleave, not a timing stagger)",
    async () => {
      const clientA = fakeClient("tenant-A");
      const credsA = fakeCredentials("tenant-A");
      const clientB = fakeClient("tenant-B");
      const credsB = fakeCredentials("tenant-B");
      const gate = createDeferred<void>();

      // Tenant A: binds its client/credentials, then suspends on an await
      // gap (simulating an in-flight ScalePad API call inside a tool
      // handler) BEFORE reading them back.
      const tenantA = runWithRequestClient(clientA, credsA, async () => {
        await gate.promise; // the exact await gap the original bug lost the context across
        return { client: await getClient(), creds: getCredentials() };
      });

      // Force the interleave: tenant B's ENTIRE request — bind, read,
      // (implicitly) clear on scope exit — runs to completion while tenant
      // A is still suspended above, exactly like a second concurrent HTTP
      // request racing in and clearing the old module-level overrides.
      const tenantB = runWithRequestClient(clientB, credsB, async () => {
        return { client: await getClient(), creds: getCredentials() };
      });
      const resultB = await tenantB;

      // Only now let tenant A resume.
      gate.resolve();
      const resultA = await tenantA;

      // --- Per-tenant VALUE assertions -----------------------------------
      expect(resultA.client).toBe(clientA);
      expect(resultA.creds).toBe(credsA);
      expect(resultB.client).toBe(clientB);
      expect(resultB.creds).toBe(credsB);

      // Explicit negative checks: neither tenant's client/credentials must
      // ever equal the other's.
      expect(resultA.client).not.toBe(clientB);
      expect(resultA.creds).not.toBe(credsB);
      expect(resultB.client).not.toBe(clientA);
      expect(resultB.creds).not.toBe(credsA);

      // And after both requests have fully completed, no context should
      // leak into unrelated, non-request-scoped code.
      expect(getCredentials()).toBeNull();
    }
  );
});
