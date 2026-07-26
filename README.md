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

### Environment variables (`AUTH_MODE=env`, default for stdio/local)

| Variable | Required | Notes |
| --- | --- | --- |
| `SCALEPAD_API_KEY` | yes | Forwarded to `api.scalepad.com` as `x-api-key` |
| `SCALEPAD_REGION` | no | `us` (default), `eu`, `ca`, or `au` — selects the regional base URL for ControlMap (us/eu/ca/au) and Backup Radar (us/eu); Core and Lifecycle Manager are US-only |
| `QUOTER_CLIENT_ID` | no | Only for the standalone `api.quoter.com` OAuth path (Quoter Account > API Keys, Account Owner only) |
| `QUOTER_CLIENT_SECRET` | no | Paired with `QUOTER_CLIENT_ID` |

### Gateway headers (`AUTH_MODE=gateway`, hosted deployment)

| Header | Required |
| --- | --- |
| `X-ScalePad-Api-Key` | yes |
| `X-ScalePad-Region` | no |
| `X-Quoter-Client-Id` | no |
| `X-Quoter-Client-Secret` | no |

In gateway mode credentials are bound per request from these headers; requests to `/mcp` without `X-ScalePad-Api-Key` are rejected with a `401` JSON-RPC error before any MCP handling (they never fall through to env credentials). `/health` stays unauthenticated.

## Transports

- **stdio** (default): `node dist/index.js` — for Claude Desktop / CLI.
- **HTTP**: `MCP_TRANSPORT=http node dist/index.js` — serves `/mcp` (dual-era, `legacy: 'stateless'`) plus `/health`. Configure with `MCP_HTTP_PORT` (default `8080`) and `MCP_HTTP_HOST` (default `0.0.0.0`).

## Development

```bash
export NODE_AUTH_TOKEN=$(gh auth token)   # GitHub Packages read access
npm ci
npm run build       # tsup (transpile-only; domains stay lazily importable)
npm test            # vitest (HTTP layer: health, 401 gate, dual-era tools/list)
npm run smoke       # dual-era smoke against dist/index.js
npm run typecheck
```

Domain handlers live in `src/domains/<slug>.ts`, each exporting `export const handler: DomainHandler` (see `src/utils/types.ts`), and are lazily loaded via `src/domains/index.ts`.

## Docker

```bash
docker build --build-arg NODE_AUTH_TOKEN=$(gh auth token) -t scalepad-mcp .
docker run -p 8080:8080 -e AUTH_MODE=env -e SCALEPAD_API_KEY=... scalepad-mcp
```

The image defaults to `AUTH_MODE=gateway` for hosted deployment behind the WYRE MCP gateway.

## License

Apache-2.0 — see [LICENSE](LICENSE).
