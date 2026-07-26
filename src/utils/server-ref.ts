/**
 * Shared MCP Server reference for elicitation and tool-list-changed
 * notifications. Avoids circular imports by decoupling the server instance
 * from domain handlers.
 */
import type { Server } from "@modelcontextprotocol/server";

let _server: Server | null = null;

export function setServerRef(server: Server): void {
  _server = server;
}

export function getServerRef(): Server | null {
  return _server;
}
