import { CONTAINER_ROLES, INTERACTIVE_ROLES } from "../shared/types.ts";
import type { AXNode, VFSNode } from "../shared/types.ts";

/**
 * Maps the raw Accessibility Tree from CDP into a clean virtual filesystem.
 * Container nodes become directories. Interactive/leaf nodes become files.
 */

// Cache for the node map (axNodeId -> AXNode) to avoid rebuilding it
let cachedNodeMap: Map<string, AXNode> | null = null;
let cachedTreeHash: string | null = null;

/**
 * Generates a human-readable filename from an AX node.
 * Uses the heuristic naming algorithm from the spec.
 */
export function generateNodeName(node: AXNode): string {
  const role = node.role?.value ?? "unknown";
  const name = node.name?.value ?? "";
  const description = node.description?.value ?? "";

  // Sanitize text for use as a filename
  const sanitize = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 40);

  // Role-specific suffixes
  const roleSuffix: Record<string, string> = {
    button: "_btn",
    link: "_link",
    textbox: "_input",
    checkbox: "_chk",
    radio: "_radio",
    combobox: "_select",
    menuitem: "_item",
    tab: "_tab",
    slider: "_slider",
    searchbox: "_search",
    switch: "_switch",
    img: "_img",
    image: "_img",
    heading: "_heading",
  };

  // If we have a human-readable name, use it
  if (name) {
    const sanitized = sanitize(name);
    if (sanitized) {
      const suffix = roleSuffix[role] ?? "";
      return sanitized + suffix;
    }
  }

  // Fall back to description
  if (description) {
    const sanitized = sanitize(description);
    if (sanitized) {
      const suffix = roleSuffix[role] ?? "";
      return sanitized + suffix;
    }
  }

  // Fall back to role + node ID
  const suffix = roleSuffix[role] ?? "";
  return `${role}${suffix || "_" + node.nodeId}`;
}

/**
 * Determine if a node should be treated as a directory (container).
 */
export function isContainerNode(node: AXNode): boolean {
  const role = node.role?.value ?? "";

  // Explicit container roles
  if (CONTAINER_ROLES.has(role)) return true;

  // If it has children and is not an interactive leaf, treat as container
  if (node.childIds && node.childIds.length > 0 && !INTERACTIVE_ROLES.has(role)) {
    return true;
  }

  return false;
}

/**
 * Build a map of nodeId -> AXNode for fast lookup.
 */
export function buildNodeMap(axNodes: AXNode[]): Map<string, AXNode> {
  const map = new Map<string, AXNode>();
  for (const node of axNodes) {
    if (!node.ignored) {
      map.set(node.nodeId, node);
    }
  }
  return map;
}

/**
 * Find the root node of the AX tree.
 */
export function findRootNode(nodeMap: Map<string, AXNode>): AXNode | null {
  // The root is typically the first node with role "RootWebArea" or "WebArea"
  for (const node of nodeMap.values()) {
    const role = node.role?.value ?? "";
    if (role === "RootWebArea" || role === "WebArea") {
      return node;
    }
  }
  // Fallback: first node
  const first = nodeMap.values().next();
  return first.done ? null : first.value;
}

/**
 * Get the children of a node as VFSNodes.
 * Skips ignored nodes and flattens "useless" wrappers (generic nodes with no name).
 */
export function getChildVFSNodes(
  parentId: string,
  nodeMap: Map<string, AXNode>
): VFSNode[] {
  const parent = nodeMap.get(parentId);
  if (!parent || !parent.childIds) return [];

  const results: VFSNode[] = [];
  const seenNames = new Map<string, number>();

  for (const childId of parent.childIds) {
    const child = nodeMap.get(childId);
    if (!child || child.ignored) continue;

    const role = child.role?.value ?? "";
    const name = child.name?.value ?? "";

    // Skip "none" role nodes or completely empty ignored nodes
    if (role === "none" || role === "Ignored") continue;

    // Flatten useless generic wrappers: if a generic node has no name
    // and only one child, skip it and show its child instead
    if (
      role === "generic" &&
      !name &&
      child.childIds &&
      child.childIds.length === 1
    ) {
      const grandchild = nodeMap.get(child.childIds[0]);
      if (grandchild && !grandchild.ignored) {
        const vfsNode = axNodeToVFSNode(grandchild);
        if (vfsNode) {
          deduplicateName(vfsNode, seenNames);
          results.push(vfsNode);
        }
        continue;
      }
    }

    const vfsNode = axNodeToVFSNode(child);
    if (vfsNode) {
      deduplicateName(vfsNode, seenNames);
      results.push(vfsNode);
    }
  }

  return results;
}

/**
 * Convert an AXNode to a VFSNode.
 */
function axNodeToVFSNode(node: AXNode): VFSNode | null {
  const role = node.role?.value ?? "";
  if (role === "none" || role === "Ignored") return null;

  return {
    axNodeId: node.nodeId,
    backendDOMNodeId: node.backendDOMNodeId,
    name: generateNodeName(node),
    role,
    value: node.value?.value,
    isDirectory: isContainerNode(node),
  };
}

/**
 * Ensure unique names by appending _2, _3, etc. for duplicates.
 */
function deduplicateName(
  node: VFSNode,
  seenNames: Map<string, number>
): void {
  const baseName = node.name;
  const count = seenNames.get(baseName) ?? 0;
  if (count > 0) {
    node.name = `${baseName}_${count + 1}`;
  }
  seenNames.set(baseName, count + 1);
}

/**
 * Resolve a path of CWD node IDs to the current node.
 */
export function resolveNodeFromCwd(
  cwd: string[],
  nodeMap: Map<string, AXNode>
): AXNode | null {
  if (cwd.length === 0) return null;
  const currentId = cwd[cwd.length - 1];
  return nodeMap.get(currentId) ?? null;
}

/**
 * Find a child VFS node by its generated name.
 */
export function findChildByName(
  parentId: string,
  name: string,
  nodeMap: Map<string, AXNode>
): VFSNode | null {
  const children = getChildVFSNodes(parentId, nodeMap);
  return children.find((c) => c.name === name) ?? null;
}

/**
 * Update the cached node map. Returns the new map.
 */
export function updateNodeMap(axNodes: AXNode[]): Map<string, AXNode> {
  cachedNodeMap = buildNodeMap(axNodes);
  return cachedNodeMap;
}

/**
 * Get the current cached node map.
 */
export function getCachedNodeMap(): Map<string, AXNode> | null {
  return cachedNodeMap;
}
