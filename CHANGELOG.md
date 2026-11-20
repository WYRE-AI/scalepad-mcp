# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are cut by semantic-release from conventional commits.

## [Unreleased]

### Fixed

- **The HTTP transport no longer exits on a malformed request (WYREAI-741).** The request
  target was parsed against the client-supplied `Host` header, and a value that does not parse
  (or a target such as `//`) threw inside the request listener before authentication. The
  target is now parsed against a fixed base, so `Host` is no longer consulted, and a target
  that still cannot be parsed gets a `400` JSON response while the server keeps running.

### Added

- Initial MCP server shell built natively on MCP SDK v2 (2026-07-28 spec) with dual-era serving: one shared server factory drives both `serveStdio` and `createMcpHandler({ legacy: 'stateless' })` via `toNodeHandler`.
- Decision-tree navigation (`scalepad_navigate`, `scalepad_back`, `scalepad_status`) with `sendToolListChanged()` on every state change; initial `tools/list` exposes only the navigation tools.
- Lazy domain registry for the five ScalePad products: `core`, `lifecycle-manager`, `controlmap`, `backup-radar`, `quoter`.
- Gateway credential binding (`X-ScalePad-Api-Key`, `X-ScalePad-Region`, `X-Quoter-Client-Id`, `X-Quoter-Client-Secret`) with a 401 JSON-RPC gate on `/mcp` before MCP delegation, plus env-var credentials for stdio/local use.
- Shared utilities: stderr-only structured logger, lazy SDK client with per-request overrides and cache invalidation, server-ref, and elicitation helpers.
- Dual-era smoke script (`scripts/smoke-dual-era.mjs`), SSE-aware test helper, and a vitest suite for the HTTP layer (health, 401 gate, dual-era `tools/list`).
- Fleet packaging: multi-stage `node:22-alpine` Dockerfile (non-root, `AUTH_MODE=gateway` default), thin-caller release workflow, mcp-assert workflow, semantic-release config (`npmPublish: false`).
