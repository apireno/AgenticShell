import { CDPClient } from "./cdp_client.ts";
import {
  buildNodeMap,
  findChildByName,
  findRootNode,
  generateNodeName,
  getChildVFSNodes,
} from "./vfs_mapper.ts";
import type { AXNode, ShellState, VFSNode } from "../shared/types.ts";

// ---- State ----

const cdp = new CDPClient();

const state: ShellState = {
  cwd: [],
  cwdNames: ["/"],
  attachedTabId: null,
  env: {
    SHELL: "/bin/agentshell",
    TERM: "xterm-256color",
    PS1: "agent@shell:$PWD$ ",
  },
};

let nodeMap: Map<string, AXNode> = new Map();

// ---- Open Side Panel on Action Click ----

chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: true })
  ?.catch(() => {});

// ---- Message Router ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "agentshell") return;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "STDIN") {
      const output = await executeCommand(msg.input);
      port.postMessage({ type: "STDOUT", output });
    } else if (msg.type === "READY") {
      port.postMessage({
        type: "STDOUT",
        output: formatWelcome(),
      });
    }
  });
});

// ---- Welcome Banner ----

function formatWelcome(): string {
  return [
    "\x1b[36m╔══════════════════════════════════════╗\x1b[0m",
    "\x1b[36m║\x1b[0m   \x1b[1;33mAgentShell v1.0.0\x1b[0m               \x1b[36m║\x1b[0m",
    "\x1b[36m║\x1b[0m   \x1b[37mThe DOM is your filesystem.\x1b[0m      \x1b[36m║\x1b[0m",
    "\x1b[36m╚══════════════════════════════════════╝\x1b[0m",
    "",
    "\x1b[90mType 'help' to see available commands.\x1b[0m",
    "\x1b[90mType 'attach' to connect to the active tab.\x1b[0m",
    "",
  ].join("\r\n");
}

// ---- Command Parser ----

async function executeCommand(raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // Parse command and arguments (respect quoted strings)
  const parts = parseCommandLine(trimmed);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  try {
    switch (cmd) {
      case "help":
        return handleHelp();
      case "attach":
        return await handleAttach();
      case "detach":
        return await handleDetach();
      case "ls":
        return await handleLs(args);
      case "cd":
        return await handleCd(args);
      case "pwd":
        return handlePwd();
      case "cat":
        return await handleCat(args);
      case "click":
        return await handleClick(args);
      case "type":
        return await handleType(args);
      case "focus":
        return await handleFocus(args);
      case "grep":
        return await handleGrep(args);
      case "whoami":
        return await handleWhoami();
      case "env":
        return handleEnv();
      case "export":
        return handleExport(args);
      case "tree":
        return await handleTree(args);
      case "refresh":
        return await handleRefresh();
      case "clear":
        return "\x1b[2J\x1b[H";
      default:
        return `\x1b[31magentshell: ${cmd}: command not found\x1b[0m\r\nType 'help' for available commands.`;
    }
  } catch (err: any) {
    return `\x1b[31mError: ${err.message}\x1b[0m`;
  }
}

function parseCommandLine(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (const char of input) {
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// ---- Command Implementations ----

function handleHelp(): string {
  return [
    "\x1b[1;36mAgentShell — DOM as a Filesystem\x1b[0m",
    "",
    "\x1b[1;33mNavigation:\x1b[0m",
    "  \x1b[32mattach\x1b[0m          Connect to the active browser tab",
    "  \x1b[32mdetach\x1b[0m          Disconnect from the current tab",
    "  \x1b[32mrefresh\x1b[0m         Re-fetch the Accessibility Tree",
    "  \x1b[32mls\x1b[0m              List children of the current node",
    "  \x1b[32mcd <name>\x1b[0m       Enter a child node (directory)",
    "  \x1b[32mcd ..\x1b[0m           Go up one level",
    "  \x1b[32mcd /\x1b[0m            Go to the root",
    "  \x1b[32mpwd\x1b[0m             Show current path",
    "  \x1b[32mtree\x1b[0m            Show tree view of current node",
    "",
    "\x1b[1;33mInspection:\x1b[0m",
    "  \x1b[32mcat <name>\x1b[0m      Read text content of a node",
    "  \x1b[32mgrep <pattern>\x1b[0m  Search children for matching names",
    "",
    "\x1b[1;33mInteraction:\x1b[0m",
    "  \x1b[32mclick <name>\x1b[0m    Click an element",
    "  \x1b[32mfocus <name>\x1b[0m    Focus an input element",
    "  \x1b[32mtype <text>\x1b[0m     Type text into the focused element",
    "",
    "\x1b[1;33mSystem:\x1b[0m",
    "  \x1b[32mwhoami\x1b[0m          Check authentication cookies",
    "  \x1b[32menv\x1b[0m             Show environment variables",
    "  \x1b[32mexport K=V\x1b[0m      Set an environment variable",
    "  \x1b[32mclear\x1b[0m           Clear the terminal",
    "  \x1b[32mhelp\x1b[0m            Show this help message",
    "",
  ].join("\r\n");
}

async function handleAttach(): Promise<string> {
  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return "\x1b[31mError: No active tab found.\x1b[0m";

  try {
    await cdp.attach(tab.id);
    state.attachedTabId = tab.id;

    // Fetch the initial AX tree
    const axNodes = await cdp.getFullAXTree();
    nodeMap = buildNodeMap(axNodes);

    const root = findRootNode(nodeMap);
    if (root) {
      state.cwd = [root.nodeId];
      state.cwdNames = ["/"];
    }

    const title = tab.title ?? "unknown";
    const url = tab.url ?? "unknown";

    return [
      `\x1b[32m✓ Attached to tab ${tab.id}\x1b[0m`,
      `  \x1b[37mTitle: ${title}\x1b[0m`,
      `  \x1b[37mURL:   ${url}\x1b[0m`,
      `  \x1b[90mAX Nodes: ${nodeMap.size}\x1b[0m`,
      "",
    ].join("\r\n");
  } catch (err: any) {
    return `\x1b[31mError attaching: ${err.message}\x1b[0m`;
  }
}

async function handleDetach(): Promise<string> {
  if (!state.attachedTabId) {
    return "\x1b[33mNot attached to any tab.\x1b[0m";
  }
  await cdp.detach();
  state.attachedTabId = null;
  state.cwd = [];
  state.cwdNames = ["/"];
  nodeMap.clear();
  return "\x1b[32m✓ Detached.\x1b[0m";
}

async function handleRefresh(): Promise<string> {
  if (!state.attachedTabId) {
    return "\x1b[31mNot attached. Run 'attach' first.\x1b[0m";
  }

  const axNodes = await cdp.getFullAXTree();
  nodeMap = buildNodeMap(axNodes);

  // Reset to root
  const root = findRootNode(nodeMap);
  if (root) {
    state.cwd = [root.nodeId];
    state.cwdNames = ["/"];
  }

  return `\x1b[32m✓ Refreshed. ${nodeMap.size} AX nodes loaded.\x1b[0m`;
}

function ensureAttached(): void {
  if (!state.attachedTabId || nodeMap.size === 0) {
    throw new Error("Not attached to a tab. Run 'attach' first.");
  }
}

function getCurrentNodeId(): string {
  if (state.cwd.length === 0) throw new Error("No CWD set. Run 'attach' first.");
  return state.cwd[state.cwd.length - 1];
}

async function handleLs(args: string[]): Promise<string> {
  ensureAttached();

  const showAll = args.includes("-a") || args.includes("--all");
  const longFormat = args.includes("-l") || args.includes("--long");

  const currentId = getCurrentNodeId();
  const children = getChildVFSNodes(currentId, nodeMap);

  if (children.length === 0) {
    return "\x1b[90m(empty directory)\x1b[0m";
  }

  const lines: string[] = [];

  for (const child of children) {
    if (longFormat) {
      const type = child.isDirectory ? "d" : "-";
      const role = child.role.padEnd(14);
      const name = child.isDirectory
        ? `\x1b[1;34m${child.name}/\x1b[0m`
        : INTERACTIVE_COLOR(child);
      lines.push(`${type} ${role} ${name}`);
    } else {
      if (child.isDirectory) {
        lines.push(`\x1b[1;34m${child.name}/\x1b[0m`);
      } else {
        lines.push(INTERACTIVE_COLOR(child));
      }
    }
  }

  return lines.join("\r\n");
}

function INTERACTIVE_COLOR(node: VFSNode): string {
  switch (node.role) {
    case "button":
      return `\x1b[1;32m${node.name}\x1b[0m`;
    case "link":
      return `\x1b[1;35m${node.name}\x1b[0m`;
    case "textbox":
    case "searchbox":
    case "combobox":
      return `\x1b[1;33m${node.name}\x1b[0m`;
    case "checkbox":
    case "radio":
    case "switch":
      return `\x1b[1;36m${node.name}\x1b[0m`;
    default:
      return `\x1b[37m${node.name}\x1b[0m`;
  }
}

async function handleCd(args: string[]): Promise<string> {
  ensureAttached();

  if (args.length === 0 || args[0] === "/") {
    // Go to root
    const root = findRootNode(nodeMap);
    if (root) {
      state.cwd = [root.nodeId];
      state.cwdNames = ["/"];
    }
    return "";
  }

  const target = args[0];

  if (target === "..") {
    if (state.cwd.length > 1) {
      state.cwd.pop();
      state.cwdNames.pop();
    }
    return "";
  }

  // Handle multi-level paths like "nav/links"
  const pathParts = target.split("/").filter(Boolean);

  for (const part of pathParts) {
    if (part === "..") {
      if (state.cwd.length > 1) {
        state.cwd.pop();
        state.cwdNames.pop();
      }
      continue;
    }

    const currentId = getCurrentNodeId();
    const match = findChildByName(currentId, part, nodeMap);

    if (!match) {
      return `\x1b[31mcd: ${part}: No such directory\x1b[0m`;
    }
    if (!match.isDirectory) {
      return `\x1b[31mcd: ${part}: Not a directory\x1b[0m`;
    }

    state.cwd.push(match.axNodeId);
    state.cwdNames.push(match.name);
  }

  return "";
}

function handlePwd(): string {
  if (state.cwdNames.length <= 1) return "/";
  return "/" + state.cwdNames.slice(1).join("/");
}

async function handleCat(args: string[]): Promise<string> {
  ensureAttached();

  if (args.length === 0) {
    return "\x1b[31mUsage: cat <name>\x1b[0m";
  }

  const targetName = args[0];
  const currentId = getCurrentNodeId();
  const match = findChildByName(currentId, targetName, nodeMap);

  if (!match) {
    return `\x1b[31mcat: ${targetName}: No such file\x1b[0m`;
  }

  const lines: string[] = [];
  lines.push(`\x1b[1;36m--- ${match.name} ---\x1b[0m`);
  lines.push(`  \x1b[33mRole:\x1b[0m  ${match.role}`);
  lines.push(`  \x1b[33mAXID:\x1b[0m  ${match.axNodeId}`);

  if (match.value) {
    lines.push(`  \x1b[33mValue:\x1b[0m ${match.value}`);
  }

  // Try to read DOM text content
  if (match.backendDOMNodeId) {
    try {
      const text = await cdp.getTextContent(match.backendDOMNodeId);
      if (text.trim()) {
        lines.push(`  \x1b[33mText:\x1b[0m`);
        // Wrap long text
        const wrapped = text.trim().slice(0, 500);
        lines.push(`  ${wrapped}`);
        if (text.length > 500) {
          lines.push(`  \x1b[90m... (${text.length} chars total)\x1b[0m`);
        }
      }
    } catch {
      // Ignore errors reading text content
    }
  }

  return lines.join("\r\n");
}

async function handleClick(args: string[]): Promise<string> {
  ensureAttached();

  if (args.length === 0) {
    return "\x1b[31mUsage: click <name>\x1b[0m";
  }

  const targetName = args[0];
  const currentId = getCurrentNodeId();
  const match = findChildByName(currentId, targetName, nodeMap);

  if (!match) {
    return `\x1b[31mclick: ${targetName}: No such element\x1b[0m`;
  }

  if (!match.backendDOMNodeId) {
    return `\x1b[31mclick: ${targetName}: No DOM node backing (AX-only node)\x1b[0m`;
  }

  try {
    await cdp.clickByBackendNodeId(match.backendDOMNodeId);
    return `\x1b[32m✓ Clicked: ${match.name} (${match.role})\x1b[0m`;
  } catch {
    // Fall back to coordinate-based click
    try {
      await cdp.clickByCoordinates(match.backendDOMNodeId);
      return `\x1b[32m✓ Clicked (coords): ${match.name} (${match.role})\x1b[0m`;
    } catch (err: any) {
      return `\x1b[31mclick failed: ${err.message}\x1b[0m`;
    }
  }
}

async function handleFocus(args: string[]): Promise<string> {
  ensureAttached();

  if (args.length === 0) {
    return "\x1b[31mUsage: focus <name>\x1b[0m";
  }

  const targetName = args[0];
  const currentId = getCurrentNodeId();
  const match = findChildByName(currentId, targetName, nodeMap);

  if (!match) {
    return `\x1b[31mfocus: ${targetName}: No such element\x1b[0m`;
  }

  if (!match.backendDOMNodeId) {
    return `\x1b[31mfocus: ${targetName}: No DOM node backing\x1b[0m`;
  }

  await cdp.focusByBackendNodeId(match.backendDOMNodeId);
  return `\x1b[32m✓ Focused: ${match.name}\x1b[0m`;
}

async function handleType(args: string[]): Promise<string> {
  ensureAttached();

  if (args.length === 0) {
    return "\x1b[31mUsage: type <text>\x1b[0m";
  }

  const text = args.join(" ");
  await cdp.typeText(text);
  return `\x1b[32m✓ Typed ${text.length} characters\x1b[0m`;
}

async function handleGrep(args: string[]): Promise<string> {
  ensureAttached();

  if (args.length === 0) {
    return "\x1b[31mUsage: grep <pattern>\x1b[0m";
  }

  const pattern = args[0].toLowerCase();
  const currentId = getCurrentNodeId();
  const children = getChildVFSNodes(currentId, nodeMap);

  const matches = children.filter(
    (c) =>
      c.name.toLowerCase().includes(pattern) ||
      c.role.toLowerCase().includes(pattern) ||
      (c.value && c.value.toLowerCase().includes(pattern))
  );

  if (matches.length === 0) {
    return `\x1b[33mNo matches for '${pattern}'\x1b[0m`;
  }

  return matches
    .map((m) => {
      const icon = m.isDirectory ? "\x1b[1;34m📁\x1b[0m" : "\x1b[37m📄\x1b[0m";
      return `${icon} ${m.name} \x1b[90m(${m.role})\x1b[0m`;
    })
    .join("\r\n");
}

async function handleTree(args: string[]): Promise<string> {
  ensureAttached();

  const maxDepth = args[0] ? parseInt(args[0], 10) : 2;
  const currentId = getCurrentNodeId();

  const lines: string[] = [];
  const currentNode = nodeMap.get(currentId);
  const rootName = currentNode ? generateNodeName(currentNode) : "/";
  lines.push(`\x1b[1;34m${rootName}/\x1b[0m`);

  buildTreeLines(currentId, "", maxDepth, 0, lines);

  return lines.join("\r\n");
}

function buildTreeLines(
  parentId: string,
  prefix: string,
  maxDepth: number,
  depth: number,
  lines: string[]
): void {
  if (depth >= maxDepth) return;

  const children = getChildVFSNodes(parentId, nodeMap);

  children.forEach((child, i) => {
    const isLast = i === children.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";

    const display = child.isDirectory
      ? `\x1b[1;34m${child.name}/\x1b[0m`
      : INTERACTIVE_COLOR(child);

    lines.push(`${prefix}${connector}${display}`);

    if (child.isDirectory) {
      buildTreeLines(child.axNodeId, prefix + childPrefix, maxDepth, depth + 1, lines);
    }
  });
}

async function handleWhoami(): Promise<string> {
  if (!state.attachedTabId) {
    return "\x1b[31mNot attached. Run 'attach' first.\x1b[0m";
  }

  try {
    const url = await cdp.getPageUrl();
    const cookies = await chrome.cookies.getAll({ url });

    const sessionCookie = cookies.find((c) =>
      c.name.match(/session|sid|auth|token|jwt|user/i)
    );

    const lines: string[] = [];
    lines.push(`\x1b[1;36mURL:\x1b[0m ${url}`);

    if (sessionCookie) {
      lines.push(`\x1b[1;32mStatus:\x1b[0m Authenticated`);
      lines.push(`\x1b[1;33mVia:\x1b[0m ${sessionCookie.name}`);
      if (sessionCookie.expirationDate) {
        const expires = new Date(sessionCookie.expirationDate * 1000).toISOString();
        lines.push(`\x1b[1;33mExpires:\x1b[0m ${expires}`);
      }
    } else {
      lines.push(`\x1b[1;33mStatus:\x1b[0m Guest (no session cookie detected)`);
    }

    lines.push(`\x1b[90mTotal cookies: ${cookies.length}\x1b[0m`);
    return lines.join("\r\n");
  } catch (err: any) {
    return `\x1b[31mError: ${err.message}\x1b[0m`;
  }
}

function handleEnv(): string {
  return Object.entries(state.env)
    .map(([k, v]) => `\x1b[33m${k}\x1b[0m=${v}`)
    .join("\r\n");
}

function handleExport(args: string[]): string {
  if (args.length === 0) {
    return "\x1b[31mUsage: export KEY=VALUE\x1b[0m";
  }

  const joined = args.join(" ");
  const eqIndex = joined.indexOf("=");
  if (eqIndex === -1) {
    return "\x1b[31mUsage: export KEY=VALUE\x1b[0m";
  }

  const key = joined.slice(0, eqIndex).trim();
  const value = joined.slice(eqIndex + 1).trim();
  state.env[key] = value;

  return `\x1b[32m✓ ${key}=${value}\x1b[0m`;
}
