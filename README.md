# scalepad-mcp

MCP server for the [ScalePad](https://developer.scalepad.com) platform — Core, Lifecycle Manager, ControlMap, Backup Radar, and Quoter — built natively on the MCP SDK v2 (2026-07-28 spec) with dual-era serving: the same endpoint answers both legacy 2025-era `initialize`-handshake clients and modern envelope clients.

## Architecture

Flat tool surface: every tool is exposed upfront in `tools/list` for universal client compatibility. Navigation tools are discovery aids, not gates.

| Tool | Purpose |
| --- | --- |
| `scalepad_navigate` | Describe a product domain's tools (`core`, `lifecycle-manager`, `controlmap`, `backup-radar`, `quoter`) — a help/discovery aid, not a prerequisite |
| `scalepad_status` | Show credential status and available domains |

### Product domains

| Domain | Tool prefix | Coverage |
| --- | --- | --- |
| `core` | `scalepad_core_` | Unified platform data (read-only, US-only): clients, contacts, members, sites, opportunities, hardware/SaaS assets, product catalog, service contracts, tickets, integrations |
| `lifecycle-manager` | `scalepad_lm_` | Engagement/roadmap workflows: initiatives, goals, meetings, action items, assessments, deliverables, budgets, contracts, workspace |
| `controlmap` | `scalepad_cm_` | Compliance per client: risks, controls, evidence, policies, frameworks, assessments, action items (regions: us, eu, ca, au) |
| `backup-radar` | `scalepad_br_` | Read-only backup health and backup device inventory (regions: us, eu) |
| `quoter` | `scalepad_quoter_` | Quotes, catalog, contacts, suppliers, and standalone-OAuth helpers (defaults to the ScalePad-hosted Quoter API) |

All tools are callable at any time; `scalepad_navigate` simply summarizes a domain's tools.

## Credentials

One ScalePad API key (generated in the ScalePad app by an Administrator) covers every product; endpoints for products without an active subscription return `402`.

Copy [`.env.example`](.env.example) and set the variables below. Leave `CONDUIT_S2S_SECRET` empty in that file.

### Environment variables (`AUTH_MODE=env`, default for stdio/local)

| Variable | Required | Notes |
| --- | --- | --- |
| `SCALEPAD_API_KEY` | For stdio and `AUTH_MODE=env` | Forwarded to `api.scalepad.com` as `x-api-key` |
| `SCALEPAD_REGION` | no | `us` (default), `eu`, `ca`, or `au` — selects the regional base URL for ControlMap (us/eu/ca/au) and Backup Radar (us/eu); Core and Lifecycle Manager are US-only |
| `QUOTER_CLIENT_ID` | no | Only for the standalone `api.quoter.com` OAuth path (Quoter Account > API Keys, Account Owner only) |
| `QUOTER_CLIENT_SECRET` | no | Paired with `QUOTER_CLIENT_ID` |
| `MCP_TRANSPORT` | no | `stdio` (default) or `http` |
| `AUTH_MODE` | no | `gateway` (Docker image and Compose default) or `env`. Gateway mode requires `X-ScalePad-Api-Key` on each `/mcp` request and never falls back to `SCALEPAD_*`. `env` uses those variables only after S2S auth succeeds. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder (`changeme`, `your-s2s-secret`, and similar copied example values). Compose will not start without it. Never commit a real value. The value is never logged. |
| `MCP_ALLOW_INSECURE_DEV` | no | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning and does not enforce `X-Gateway-S2S`. The listener is forced to `127.0.0.1` even if `MCP_HTTP_HOST` is a wider address such as `0.0.0.0`. A known placeholder secret is still refused. |
| `MCP_HTTP_HOST` | no | Bind address when `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` is set. When unset, the server binds `127.0.0.1`. The container image sets `0.0.0.0`. |
| `MCP_HTTP_PORT` | no | HTTP port. Defaults to `8080`. |

`/health` and `/healthz` stay unauthenticated and do not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### Gateway headers (`AUTH_MODE=gateway`, hosted deployment)

| Header | Required |
| --- | --- |
| `X-Gateway-S2S` | yes, when `CONDUIT_S2S_SECRET` is set |
| `X-ScalePad-Api-Key` | yes |
| `X-ScalePad-Region` | no |
| `X-Quoter-Client-Id` | no |
| `X-Quoter-Client-Secret` | no |

In gateway mode credentials are bound per request from these headers. A `/mcp` request without `X-ScalePad-Api-Key` is rejected with a `401` JSON-RPC error before any MCP handling and never falls through to env credentials. `/health` stays unauthenticated.

### X-Gateway-S2S signing

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`. A missing or invalid header returns `401` before vendor credentials are read.

The header value is `t=<unix seconds>,v1=<hex>`. `v1` is HMAC-SHA256 (64 lowercase hex characters) of the ASCII string `t=<unix seconds>`, keyed with `CONDUIT_S2S_SECRET`. Timestamps more than 300 seconds from the server clock are rejected.

```js
import { createHmac } from "node:crypto";

const t = Math.floor(Date.now() / 1000);
const v1 = createHmac("sha256", process.env.CONDUIT_S2S_SECRET).update(`t=${t}`).digest("hex");
const xGatewayS2s = `t=${t},v1=${v1}`;
```

## Transports

- **stdio** (default): `node dist/index.js` — for Claude Desktop / CLI. Does not use `CONDUIT_S2S_SECRET`.
- **HTTP**: `MCP_TRANSPORT=http node dist/index.js` — serves `/mcp` (dual-era, `legacy: 'stateless'`) plus `/health` and `/healthz`. Refuses to start until `CONDUIT_S2S_SECRET` is a real secret. `MCP_HTTP_PORT` defaults to `8080`. With a secret set, `MCP_HTTP_HOST` is honored and defaults to `127.0.0.1` when unset. Without a secret, `MCP_ALLOW_INSECURE_DEV=1` is the only way to start, and the listener is `127.0.0.1` only.

## Development

```bash
export NODE_AUTH_TOKEN=$(gh auth token)   # GitHub Packages read access
npm ci
npm run build       # tsup (transpile-only; domains stay lazily importable)
npm test            # vitest (HTTP layer: health, 401 gate, dual-era tools/list, fail-closed S2S)
npm run smoke       # dual-era smoke against dist/index.js (loopback, insecure-dev bypass)
npm run typecheck
```

Domain handlers live in `src/domains/<slug>.ts`, each exporting `export const handler: DomainHandler` (see `src/utils/types.ts`), and are lazily loaded via `src/domains/index.ts`.

Local HTTP without a secret:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

## Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. That bind is safe only because startup refuses to run without a real `CONDUIT_S2S_SECRET`. Publish the port on loopback and pass the S2S secret. In gateway mode, ScalePad credentials arrive on each request as headers; they are not read from the environment.

```bash
docker build --build-arg NODE_AUTH_TOKEN=$(gh auth token) -t scalepad-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  scalepad-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset. The gateway service does not set `SCALEPAD_API_KEY`, `QUOTER_CLIENT_ID`, or `QUOTER_CLIENT_SECRET`, and it does not use `env_file`, so a project `.env` cannot inject static vendor credentials into the container. Compose still interpolates `CONDUIT_S2S_SECRET` from that file. It publishes `127.0.0.1:8080:8080`:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `SCALEPAD_API_KEY`:

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e SCALEPAD_API_KEY=your-value \
  -e SCALEPAD_REGION=us \
  -p 127.0.0.1:8080:8080 \
  scalepad-mcp
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` only (a non-loopback `MCP_HTTP_HOST`, including `0.0.0.0`, is overridden) and logs a warning:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

The image defaults to `AUTH_MODE=gateway` for hosted deployment behind the WYRE MCP gateway.

## License

Apache-2.0 — see [LICENSE](LICENSE).
