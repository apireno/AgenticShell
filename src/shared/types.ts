// ---- Message passing between Side Panel <-> Background ----

export interface StdinMessage {
  type: "STDIN";
  input: string;
}

export interface StdoutMessage {
  type: "STDOUT";
  output: string;
}

export interface StderrMessage {
  type: "STDERR";
  error: string;
}

export interface ReadyMessage {
  type: "READY";
}

export interface CompleteMessage {
  type: "COMPLETE";
  partial: string;   // The partial name to complete
  command: string;   // The command context (e.g. "cd", "cat")
}

export interface CompleteResponseMessage {
  type: "COMPLETE_RESPONSE";
  matches: string[];
  partial: string;
}

export type ShellMessage = StdinMessage | StdoutMessage | StderrMessage | ReadyMessage | CompleteMessage | CompleteResponseMessage;

// ---- Shell State ----

export interface ShellState {
  cwd: string[];          // Path of AXNode IDs, e.g. ["root", "nav", "profile"]
  cwdNames: string[];     // Human-readable path, e.g. ["/", "navigation", "profile_link"]
  attachedTabId: number | null;
  env: Record<string, string>;
}

// ---- Virtual Filesystem Nodes ----

export interface VFSNode {
  axNodeId: string;
  backendDOMNodeId?: number;
  name: string;             // Generated human-readable filename
  role: string;             // Original AX role
  value?: string;           // Text content / value
  isDirectory: boolean;     // Container vs leaf
  children?: VFSNode[];
}

// ---- AX Tree types from CDP ----

export interface AXNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  description?: { type: string; value: string };
  value?: { type: string; value: string };
  childIds?: string[];
  properties?: AXProperty[];
  ignored?: boolean;
}

export interface AXProperty {
  name: string;
  value: { type: string; value: any };
}

// Container roles — these become "directories"
export const CONTAINER_ROLES = new Set([
  "group",
  "navigation",
  "form",
  "search",
  "section",
  "main",
  "complementary",
  "banner",
  "contentinfo",
  "region",
  "article",
  "list",
  "listitem",
  "tree",
  "treeitem",
  "tablist",
  "tabpanel",
  "dialog",
  "menu",
  "menubar",
  "toolbar",
  "table",
  "row",
  "rowgroup",
  "grid",
  "document",
  "application",
  "figure",
  "feed",
  "log",
  "status",
  "timer",
  "alertdialog",
  "generic",
  "WebArea",
  "RootWebArea",
  "Iframe",
  "IframePresentational",
]);

// Interactive roles — these become "files" you can click/interact with
export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "switch",
  "tab",
  "slider",
  "spinbutton",
  "searchbox",
]);
