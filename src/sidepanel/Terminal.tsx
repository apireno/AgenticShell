import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const PROMPT = "\x1b[1;32magent\x1b[0m@\x1b[1;34mshell\x1b[0m:\x1b[1;33m$\x1b[0m ";

export default function Terminal() {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerminal | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const lineBuffer = useRef("");
  const historyRef = useRef<string[]>([]);
  const historyIndex = useRef(-1);

  const writePrompt = useCallback(() => {
    xtermRef.current?.write(PROMPT);
  }, []);

  useEffect(() => {
    if (!termRef.current) return;

    // Initialize xterm
    const term = new XTerminal({
      cursorBlink: true,
      fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        selectionBackground: "#33467c",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();

    xtermRef.current = term;

    // Connect to background service worker
    const port = chrome.runtime.connect({ name: "agentshell" });
    portRef.current = port;

    // Handle messages from the background
    port.onMessage.addListener((msg) => {
      if (msg.type === "STDOUT" || msg.type === "STDERR") {
        if (msg.output || msg.error) {
          term.write((msg.output ?? msg.error) + "\r\n");
        }
        writePrompt();
      }
    });

    // Tell the background we're ready
    port.postMessage({ type: "READY" });

    // Handle user input
    term.onKey(({ key, domEvent }) => {
      const code = domEvent.keyCode;

      if (code === 13) {
        // Enter
        term.write("\r\n");
        const command = lineBuffer.current.trim();
        if (command) {
          historyRef.current.push(command);
          historyIndex.current = historyRef.current.length;
          port.postMessage({ type: "STDIN", input: command });
        } else {
          writePrompt();
        }
        lineBuffer.current = "";
      } else if (code === 8) {
        // Backspace
        if (lineBuffer.current.length > 0) {
          lineBuffer.current = lineBuffer.current.slice(0, -1);
          term.write("\b \b");
        }
      } else if (code === 38) {
        // Arrow Up - history
        if (historyIndex.current > 0) {
          historyIndex.current--;
          replaceLineWith(term, historyRef.current[historyIndex.current]);
        }
      } else if (code === 40) {
        // Arrow Down - history
        if (historyIndex.current < historyRef.current.length - 1) {
          historyIndex.current++;
          replaceLineWith(term, historyRef.current[historyIndex.current]);
        } else {
          historyIndex.current = historyRef.current.length;
          replaceLineWith(term, "");
        }
      } else if (code === 9) {
        // Tab - basic autocomplete hint
        // Could be extended with actual autocomplete
      } else if (domEvent.ctrlKey && code === 67) {
        // Ctrl+C
        lineBuffer.current = "";
        term.write("^C\r\n");
        writePrompt();
      } else if (domEvent.ctrlKey && code === 76) {
        // Ctrl+L — clear
        term.clear();
        writePrompt();
      } else if (key.length === 1 && !domEvent.ctrlKey && !domEvent.altKey && !domEvent.metaKey) {
        // Regular printable character
        lineBuffer.current += key;
        term.write(key);
      }
    });

    // Resize handler
    const handleResize = () => fitAddon.fit();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      port.disconnect();
      term.dispose();
    };
  }, [writePrompt]);

  function replaceLineWith(term: XTerminal, newLine: string) {
    // Clear current line buffer from display
    const clearLen = lineBuffer.current.length;
    term.write("\b".repeat(clearLen) + " ".repeat(clearLen) + "\b".repeat(clearLen));
    lineBuffer.current = newLine;
    term.write(newLine);
  }

  return (
    <div
      ref={termRef}
      style={{
        width: "100%",
        height: "100vh",
        backgroundColor: "#1a1b26",
        padding: 0,
        margin: 0,
      }}
    />
  );
}
