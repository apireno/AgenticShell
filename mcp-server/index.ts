import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { appendFileSync, openSync, readSync, writeSync } from "node:fs";

// ---- CLI Flags ----

const args = process.argv.slice(2);

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function getFlagValue(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const ALLOW_WRITE = hasFlag("--allow-write") || hasFlag("--allow-all");
const ALLOW_SENSITIVE = hasFlag("--allow-sensitive") || hasFlag("--allow-all");
const NO_CONFIRM = hasFlag("--no-confirm");
const EXPOSE_COOKIES = hasFlag("--expose-cookies");
const PORT = parseInt(getFlagValue("--port", "9876"), 10);
const LOG_FILE = getFlagValue("--log-file", "audit.log");
const ALLOWED_DOMAINS = getFlagValue("--domains", "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// ---- Auth Token ----

const AUTH_TOKEN = randomBytes(24).toString("hex");

// ---- Logging ----

function log(msg: string): void {
  process.stderr.write(`[AgentShell MCP] ${msg}\n`);
}

function audit(entry: string): void {
  const line = `[${new Date().toISOString()}] ${entry}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // Ignore log write failures
  }
}

// ---- Command Tiers ----

const WRITE_COMMANDS = new Set(["click", "focus", "type"]);
const SENSITIVE_COMMANDS = new Set(["whoami"]);

function getCommandTier(command: string): "read" | "write" | "sensitive" {
  const cmd = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (WRITE_COMMANDS.has(cmd)) return "write";
  if (SENSITIVE_COMMANDS.has(cmd)) return "sensitive";
  return "read";
}

function isCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  const tier = getCommandTier(command);
  if (tier === "write" && !ALLOW_WRITE) {
    return { allowed: false, reason: "Write commands (click/focus/type) are disabled. Start the MCP server with --allow-write or --allow-all." };
  }
  if (tier === "sensitive" && !ALLOW_SENSITIVE) {
    return { allowed: false, reason: "Sensitive commands (whoami) are disabled. Start the MCP server with --allow-sensitive or --allow-all." };
  }
  return { allowed: true };
}

// ---- User Confirmation via /dev/tty ----

function confirmAction(description: string): Promise<boolean> {
  if (NO_CONFIRM) return Promise.resolve(true);

  return new Promise((resolve) => {
    try {
      const fd = openSync("/dev/tty", "r+");
      const prompt = `\n[AgentShell] Claude wants to: ${description}\nAllow? (y/n): `;
      writeSync(fd, prompt);

      const buf = Buffer.alloc(10);
      const bytesRead = readSync(fd, buf, 0, 10, null);
      const answer = buf.slice(0, bytesRead).toString().trim().toLowerCase();

      resolve(answer === "y" || answer === "yes");
    } catch {
      // /dev/tty not available (e.g., Windows, or running without a terminal)
      log("WARNING: Cannot open /dev/tty for confirmation. Denying write action.");
      log("Use --no-confirm to skip confirmation prompts.");
      resolve(false);
    }

    // Timeout after 60 seconds
    setTimeout(() => resolve(false), 60000);
  });
}

// ---- Sensitive Data Redaction ----

function redactSensitiveOutput(command: string, output: string): string {
  if (!SENSITIVE_COMMANDS.has(command.trim().split(/\s+/)[0]?.toLowerCase() ?? "")) {
    return output;
  }

  if (!EXPOSE_COOKIES) {
    // Redact cookie values — pattern: "Via: cookie_name" lines are OK, but
    // any line that looks like a cookie value assignment gets masked
    return output.replace(
      /^(.*?(?:cookie|session|token|jwt|auth|sid).*?=\s*)(.{4})(.+?)(.{4})$/gim,
      (_, prefix, start, _middle, end) => `${prefix}${start}***${end}`
    );
  }

  return output;
}

// ---- WebSocket Server ----

let extensionClient: WebSocket | null = null;
const pendingRequests = new Map<
  string,
  { resolve: (result: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });

wss.on("listening", () => {
  log(`WebSocket server listening on ws://127.0.0.1:${PORT}`);
  log(`Auth token: ${AUTH_TOKEN}`);
  log("");
  log("In the AgentShell terminal, run:");
  log(`  connect ${AUTH_TOKEN}`);
  log("");
  log(`Security: write=${ALLOW_WRITE ? "ON" : "OFF"}, sensitive=${ALLOW_SENSITIVE ? "ON" : "OFF"}, confirm=${!NO_CONFIRM ? "ON" : "OFF"}`);
  if (ALLOWED_DOMAINS.length > 0) {
    log(`Domains: ${ALLOWED_DOMAINS.join(", ")}`);
  } else {
    log("Domains: all (no restriction)");
  }
  log(`Audit log: ${LOG_FILE}`);
});

wss.on("connection", (ws, req) => {
  // Validate auth token from URL query
  const url = new URL(req.url ?? "", `http://127.0.0.1:${PORT}`);
  const token = url.searchParams.get("token");

  if (token !== AUTH_TOKEN) {
    log("Connection rejected: invalid auth token");
    audit("REJECTED: invalid auth token");
    ws.close(4001, "Invalid auth token");
    return;
  }

  // Only allow one extension client
  if (extensionClient) {
    log("Replacing existing extension connection");
    extensionClient.close();
  }

  extensionClient = ws;
  log("Extension connected (authenticated)");
  audit("CONNECTED: extension authenticated");

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "RESULT" && msg.id) {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.id);
          pending.resolve(msg.result ?? "");
        }
      } else if (msg.type === "pong") {
        // Heartbeat response — ignore
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", () => {
    if (extensionClient === ws) {
      extensionClient = null;
      log("Extension disconnected");
      audit("DISCONNECTED: extension");
    }
  });

  ws.on("error", () => {
    if (extensionClient === ws) {
      extensionClient = null;
    }
  });
});

// ---- Send Command to Extension ----

function sendCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!extensionClient || extensionClient.readyState !== 1) {
      reject(new Error("Extension not connected. Open the AgentShell side panel and run: connect <token>"));
      return;
    }

    const id = randomBytes(8).toString("hex");
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Command timed out after 30 seconds"));
    }, 30000);

    pendingRequests.set(id, { resolve, reject, timer });

    extensionClient.send(
      JSON.stringify({
        type: "EXECUTE",
        id,
        command,
        allowedDomains: ALLOWED_DOMAINS.length > 0 ? ALLOWED_DOMAINS : undefined,
      })
    );
  });
}

async function executeWithSecurity(command: string): Promise<string> {
  // Check tier
  const check = isCommandAllowed(command);
  if (!check.allowed) {
    audit(`DENIED: ${command} — ${check.reason}`);
    return `Error: ${check.reason}`;
  }

  const tier = getCommandTier(command);

  // Confirm write actions
  if (tier === "write") {
    const approved = await confirmAction(command);
    if (!approved) {
      audit(`[WRITE] DENIED by user: ${command}`);
      return "Action denied by user.";
    }
  }

  // Execute
  const tag = tier === "write" ? "[WRITE] " : tier === "sensitive" ? "[SENSITIVE] " : "";
  audit(`${tag}EXECUTE: ${command}`);

  try {
    let result = await sendCommand(command);
    result = redactSensitiveOutput(command, result);
    const summary = result.length > 80 ? result.slice(0, 80) + "..." : result;
    audit(`${tag}RESULT: ${summary}`);
    return result;
  } catch (err: any) {
    audit(`${tag}ERROR: ${err.message}`);
    return `Error: ${err.message}`;
  }
}

// ---- MCP Server ----

const server = new McpServer({
  name: "agentshell",
  version: "1.0.0",
});

// -- Read tier tools (always available) --

server.tool(
  "agentshell_attach",
  "Connect to the active browser tab via Chrome DevTools Protocol. Must be called before any other commands.",
  {},
  async () => ({
    content: [{ type: "text", text: await executeWithSecurity("attach") }],
  })
);

server.tool(
  "agentshell_ls",
  "List children of the current directory in the DOM tree. Shows elements as files (interactive) and directories (containers). Supports flags: -l (long format with roles), -r (recursive), -n N (limit), --offset N (pagination), --type ROLE (filter by role like 'button' or 'link'), --count (count only).",
  { options: z.string().optional().describe("Flags and options, e.g. '-l', '-n 10', '--type button'") },
  async ({ options }) => ({
    content: [{ type: "text", text: await executeWithSecurity(`ls ${options ?? ""}`.trim()) }],
  })
);

server.tool(
  "agentshell_cd",
  "Navigate into a directory (container element) in the DOM tree. Use '..' to go up, '/' to go to root, or 'main/form' for multi-level paths.",
  { path: z.string().describe("Directory path to navigate to") },
  async ({ path }) => ({
    content: [{ type: "text", text: await executeWithSecurity(`cd ${path}`) }],
  })
);

server.tool(
  "agentshell_pwd",
  "Print the current working directory path in the DOM tree.",
  {},
  async () => ({
    content: [{ type: "text", text: await executeWithSecurity("pwd") }],
  })
);

server.tool(
  "agentshell_cat",
  "Read detailed metadata about a DOM element: role, type, AX ID, DOM backend ID, value, child count, and text content.",
  { name: z.string().describe("Name of the element to inspect") },
  async ({ name }) => ({
    content: [{ type: "text", text: await executeWithSecurity(`cat ${name}`) }],
  })
);

server.tool(
  "agentshell_find",
  "Deep recursive search across the entire DOM tree from the current directory. Returns full paths to matching elements. Use --type to filter by role.",
  {
    pattern: z.string().optional().describe("Search pattern (matches name, role, value)"),
    type: z.string().optional().describe("Filter by AX role (e.g. 'button', 'link', 'textbox', 'combobox')"),
    limit: z.number().optional().describe("Maximum number of results"),
  },
  async ({ pattern, type, limit }) => {
    let cmd = "find";
    if (pattern) cmd += ` ${pattern}`;
    if (type) cmd += ` --type ${type}`;
    if (limit) cmd += ` -n ${limit}`;
    return { content: [{ type: "text", text: await executeWithSecurity(cmd) }] };
  }
);

server.tool(
  "agentshell_grep",
  "Search children of the current directory for elements matching a pattern. Matches against name, role, and value. Case-insensitive.",
  {
    pattern: z.string().describe("Search pattern"),
    recursive: z.boolean().optional().describe("Search all descendants recursively"),
    limit: z.number().optional().describe("Maximum number of results"),
  },
  async ({ pattern, recursive, limit }) => {
    let cmd = "grep";
    if (recursive) cmd += " -r";
    if (limit) cmd += ` -n ${limit}`;
    cmd += ` ${pattern}`;
    return { content: [{ type: "text", text: await executeWithSecurity(cmd) }] };
  }
);

server.tool(
  "agentshell_tree",
  "Show a tree view of the current directory in the DOM, displaying the hierarchy of elements with type prefixes [d]=directory, [x]=interactive, [-]=static.",
  { depth: z.number().optional().describe("Maximum depth to display (default: 2)") },
  async ({ depth }) => ({
    content: [{ type: "text", text: await executeWithSecurity(`tree ${depth ?? 2}`) }],
  })
);

server.tool(
  "agentshell_refresh",
  "Force re-fetch the Accessibility Tree. Use after page navigation or significant DOM changes. Note: the tree also auto-refreshes when changes are detected.",
  {},
  async () => ({
    content: [{ type: "text", text: await executeWithSecurity("refresh") }],
  })
);

// -- Write tier tools (require --allow-write) --

if (ALLOW_WRITE) {
  server.tool(
    "agentshell_click",
    "Click a DOM element. This may trigger navigation, form submission, or other page changes. The DOM tree will auto-refresh on the next command.",
    { name: z.string().describe("Name of the element to click") },
    async ({ name }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`click ${name}`) }],
    })
  );

  server.tool(
    "agentshell_focus",
    "Focus an input element. Use before 'agentshell_type' to direct keyboard input to the right field.",
    { name: z.string().describe("Name of the input element to focus") },
    async ({ name }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`focus ${name}`) }],
    })
  );

  server.tool(
    "agentshell_type",
    "Type text into the currently focused element. Use agentshell_focus first to target an input field.",
    { text: z.string().describe("Text to type into the focused element") },
    async ({ text }) => ({
      content: [{ type: "text", text: await executeWithSecurity(`type ${text}`) }],
    })
  );
}

// -- Sensitive tier tools (require --allow-sensitive) --

if (ALLOW_SENSITIVE) {
  server.tool(
    "agentshell_whoami",
    "Check authentication status by examining cookies for the current page. Shows session cookies and expiry.",
    {},
    async () => ({
      content: [{ type: "text", text: await executeWithSecurity("whoami") }],
    })
  );
}

// -- Fallback execute tool --

server.tool(
  "agentshell_execute",
  "Execute any AgentShell command. Use this for commands not covered by specific tools (e.g. 'env', 'export', 'debug stats'). Write and sensitive commands are subject to the same security restrictions.",
  { command: z.string().describe("The full command to execute (e.g. 'ls -l', 'debug stats')") },
  async ({ command }) => ({
    content: [{ type: "text", text: await executeWithSecurity(command) }],
  })
);

// ---- Start ----

async function main() {
  log("Starting AgentShell MCP server...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
