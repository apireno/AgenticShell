import type { AXNode } from "../shared/types.ts";

/**
 * CDPClient wraps chrome.debugger into an async/await interface.
 * It manages attachment to browser tabs and sends CDP commands.
 */
export class CDPClient {
  private attachedTabId: number | null = null;

  async attach(tabId: number): Promise<void> {
    if (this.attachedTabId === tabId) return;

    // Detach from previous tab if needed
    if (this.attachedTabId !== null) {
      await this.detach();
    }

    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          this.attachedTabId = tabId;
          resolve();
        }
      });
    });

    // Enable required CDP domains
    await this.send("Accessibility.enable");
    await this.send("DOM.enable");
    await this.send("Runtime.enable");
  }

  async detach(): Promise<void> {
    if (this.attachedTabId === null) return;

    const tabId = this.attachedTabId;
    this.attachedTabId = null;

    await new Promise<void>((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        // Ignore errors on detach (tab may already be closed)
        resolve();
      });
    });
  }

  getAttachedTabId(): number | null {
    return this.attachedTabId;
  }

  async send<T = any>(method: string, params?: Record<string, any>): Promise<T> {
    if (this.attachedTabId === null) {
      throw new Error("Not attached to any tab. Run 'attach' first.");
    }

    return new Promise<T>((resolve, reject) => {
      chrome.debugger.sendCommand(
        { tabId: this.attachedTabId! },
        method,
        params ?? {},
        (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(result as T);
          }
        }
      );
    });
  }

  /**
   * Fetch the full Accessibility Tree for the attached tab.
   */
  async getFullAXTree(): Promise<AXNode[]> {
    const result = await this.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
    return result.nodes;
  }

  /**
   * Fetch a partial AX tree rooted at a specific node.
   */
  async getPartialAXTree(nodeId: string, depth: number = 2): Promise<AXNode[]> {
    try {
      const result = await this.send<{ nodes: AXNode[] }>("Accessibility.getPartialAXTree", {
        nodeId,
        fetchRelatives: false,
      });
      return result.nodes;
    } catch {
      // Fallback: get full tree and filter
      const fullTree = await this.getFullAXTree();
      return fullTree;
    }
  }

  /**
   * Click an element by resolving its backendDOMNodeId to coordinates.
   */
  async clickByBackendNodeId(backendDOMNodeId: number): Promise<void> {
    // Resolve the backend node to a RemoteObject
    const { object } = await this.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: backendDOMNodeId }
    );

    // Use Runtime.callFunctionOn to click it
    await this.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function() { this.click(); }`,
      arguments: [],
      returnByValue: true,
    });
  }

  /**
   * Click using mouse coordinates by getting the element's bounding box.
   */
  async clickByCoordinates(backendDOMNodeId: number): Promise<void> {
    const { object } = await this.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: backendDOMNodeId }
    );

    // Get bounding rect
    const { result } = await this.send<{ result: { value: any } }>(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration: `function() {
          const rect = this.getBoundingClientRect();
          return JSON.stringify({ x: rect.x + rect.width/2, y: rect.y + rect.height/2 });
        }`,
        returnByValue: true,
      }
    );

    const coords = JSON.parse(result.value);

    // Dispatch mouse events
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: coords.x,
      y: coords.y,
      button: "left",
      clickCount: 1,
    });

    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: coords.x,
      y: coords.y,
      button: "left",
      clickCount: 1,
    });
  }

  /**
   * Type text into a focused element.
   */
  async typeText(text: string): Promise<void> {
    for (const char of text) {
      await this.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: char,
      });
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        text: char,
      });
    }
  }

  /**
   * Focus an element by its backend node ID.
   */
  async focusByBackendNodeId(backendDOMNodeId: number): Promise<void> {
    const { object } = await this.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: backendDOMNodeId }
    );

    await this.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function() { this.focus(); }`,
      returnByValue: true,
    });
  }

  /**
   * Read the text content of an element.
   */
  async getTextContent(backendDOMNodeId: number): Promise<string> {
    const { object } = await this.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: backendDOMNodeId }
    );

    const { result } = await this.send<{ result: { value: string } }>(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration: `function() { return this.textContent || this.value || ''; }`,
        returnByValue: true,
      }
    );

    return result.value;
  }

  /**
   * Get the current page URL.
   */
  async getPageUrl(): Promise<string> {
    const { result } = await this.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      {
        expression: "window.location.href",
        returnByValue: true,
      }
    );
    return result.value;
  }

  /**
   * Get the page title.
   */
  async getPageTitle(): Promise<string> {
    const { result } = await this.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      {
        expression: "document.title",
        returnByValue: true,
      }
    );
    return result.value;
  }
}
