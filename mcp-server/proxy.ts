/**
 * proxy.ts — Stdio↔HTTP bridge for MCP clients that require command/args (e.g. Claude Desktop).
 *
 * Usage:
 *   npx tsx proxy.ts --port 3001 --token <token>
 *
 * This tiny proxy reads JSON-RPC from stdin, forwards to the running DOMShell MCP server
 * over HTTP, and writes responses back to stdout. It does NOT run any MCP logic itself.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);

function flag(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const port = flag("--port", "3001");
const token = flag("--token", "");

const serverUrl = new URL(`http://127.0.0.1:${port}/mcp`);
if (token) serverUrl.searchParams.set("token", token);

const stdio = new StdioServerTransport();
const http = new StreamableHTTPClientTransport(serverUrl);

// Bridge: stdio → http, http → stdio
stdio.onmessage = (msg) => http.send(msg);
http.onmessage = (msg) => stdio.send(msg);
stdio.onclose = () => http.close();
http.onclose = () => stdio.close();

await stdio.start();
await http.start();
