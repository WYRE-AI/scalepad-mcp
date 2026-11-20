# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are cut by semantic-release from conventional commits.

## [Unreleased]

### Added

- Initial MCP server shell built natively on MCP SDK v2 (2026-07-28 spec) with dual-era serving: one shared server factory drives both `serveStdio` and `createMcpHandler({ legacy: 'stateless' })` via `toNodeHandler`.
- Decision-tree navigation (`scalepad_navigate`, `scalepad_back`, `scalepad_status`) with `sendToolListChanged()` on every state change; initial `tools/list` exposes only the navigation tools.
- Lazy domain registry for the five ScalePad products: `core`, `lifecycle-manager`, `controlmap`, `backup-radar`, `quoter`.
- Gateway credential binding (`X-ScalePad-Api-Key`, `X-ScalePad-Region`, `X-Quoter-Client-Id`, `X-Quoter-Client-Secret`) with a 401 JSON-RPC gate on `/mcp` before MCP delegation, plus env-var credentials for stdio/local use.
- Shared utilities: stderr-only structured logger, lazy SDK client with per-request overrides and cache invalidation, server-ref, and elicitation helpers.
- Dual-era smoke script (`scripts/smoke-dual-era.mjs`), SSE-aware test helper, and a vitest suite for the HTTP layer (health, 401 gate, dual-era `tools/list`).
- Fleet packaging: multi-stage `node:22-alpine` Dockerfile (non-root, `AUTH_MODE=gateway` default), thin-caller release workflow, mcp-assert workflow, semantic-release config (`npmPublish: false`).

### Changed

- Tool errors now report the HTTP status and a scrubbed copy of the vendor's error message (`Error (HTTP 422): ...`) instead of the SDK's generic `HTTP <status>` text (WYREAI-801). Credentials (API keys, access/refresh tokens, client secrets, passwords, `Authorization` values including Basic/Bearer schemes) are redacted, control characters are stripped, and messages are truncated to 300 characters. OAuth `error_description` and field-keyed validation maps are surfaced, and the real 5xx status is reported where the SDK hard-codes 500. A Lifecycle Manager 422 on `scalepad_lm_budget_*` tools is mapped to a plain "No budget is configured for this client" message only when the vendor message is missing, generic, or mentions budget; input-validation errors keep their own message.

### Fixed

- Backup Radar tools now return a clear "not available in the '<region>' region" error for the `ca` and `au` regions instead of an opaque "Resource not found" from the regional endpoint (WYREAI-806). Supported regions remain `us` and `eu`.
