# AgentShell

**The DOM is your filesystem.** A Chrome Extension that lets AI agents (and humans) browse the web using standard Linux commands — `ls`, `cd`, `cat`, `grep`, `click` — via a terminal in the Chrome Side Panel.

AgentShell maps a webpage's Accessibility Tree into a virtual filesystem. Container elements become directories. Buttons, links, and inputs become files. Navigate a website the same way you'd navigate `/usr/local/bin`.

## Why

AI agents that interact with websites typically rely on screenshots, pixel coordinates, or brittle CSS selectors. AgentShell takes a different approach: it exposes the browser's own Accessibility Tree as a familiar filesystem metaphor.

This means an agent can:
- **Explore** a page with `ls` and `tree` instead of parsing screenshots
- **Navigate** into sections with `cd navigation/` instead of guessing coordinates
- **Act** on elements with `click submit_btn` instead of fragile DOM queries
- **Read** content with `cat` instead of scraping innerHTML
- **Search** for elements with `grep` instead of writing selectors

The filesystem abstraction is deterministic, semantic, and works on any website — no site-specific adapters needed.

## Installation

### From Source

```bash
git clone https://github.com/apireno/AgenticShell.git
cd AgenticShell
npm install
npm run build
```

### Load into Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `dist/` folder
5. Click the AgentShell icon in your toolbar — the side panel opens

## Usage

### Getting Started

Open any webpage, then open the AgentShell side panel. You'll see a terminal:

```
╔══════════════════════════════════════╗
║   AgentShell v1.0.0                  ║
║   The DOM is your filesystem.        ║
╚══════════════════════════════════════╝

Type 'help' to see available commands.
Type 'attach' to connect to the active tab.

agent@shell:$
```

First, attach to the current tab:

```
agent@shell:$ attach
✓ Attached to tab 123
  Title: Example Website
  URL:   https://example.com
  AX Nodes: 247
```

### Navigating the DOM

```bash
# List children of the current node
agent@shell:$ ls
navigation/
main/
complementary/
contentinfo/
skip_to_content_link
logo_link

# Long format shows roles
agent@shell:$ ls -l
d navigation     navigation/
d main           main/
- link           skip_to_content_link
- link           logo_link

# Enter a directory (container element)
agent@shell:$ cd navigation

# See where you are
agent@shell:$ pwd
/navigation

# Go back up
agent@shell:$ cd ..

# Jump to root
agent@shell:$ cd /

# Multi-level paths work too
agent@shell:$ cd main/article/form
```

### Reading Content

```bash
# Inspect an element's metadata and text
agent@shell:$ cat submit_btn
--- submit_btn ---
  Role:  button
  AXID:  42
  Text:  Submit Form

# Get a tree view (default depth: 2)
agent@shell:$ tree
navigation/
├── home_link
├── about_link
├── products_link
└── contact_link

# Deeper tree
agent@shell:$ tree 4
```

### Interacting with Elements

```bash
# Click a button or link
agent@shell:$ click submit_btn
✓ Clicked: submit_btn (button)

# Focus an input field
agent@shell:$ focus email_input
✓ Focused: email_input

# Type into the focused field
agent@shell:$ type hello@example.com
✓ Typed 17 characters
```

### Searching

```bash
# Search current directory for matching elements
agent@shell:$ grep login
📄 login_btn (button)
📁 login_form (form)
📄 login_link (link)
```

### System Commands

```bash
# Check if you're authenticated (reads cookies)
agent@shell:$ whoami
URL: https://example.com
Status: Authenticated
Via: session_id
Expires: 2025-12-31T00:00:00.000Z
Total cookies: 12

# Environment variables
agent@shell:$ env
SHELL=/bin/agentshell
TERM=xterm-256color

# Set a variable
agent@shell:$ export API_KEY=sk-abc123

# Re-fetch the AX tree after page navigation or DOM changes
agent@shell:$ refresh
✓ Refreshed. 312 AX nodes loaded.
```

## Command Reference

| Command | Description |
|---|---|
| `help` | Show all available commands |
| `attach` | Connect to the active browser tab via CDP |
| `detach` | Disconnect from the current tab |
| `refresh` | Re-fetch the Accessibility Tree |
| `ls [-l]` | List children of the current node |
| `cd <name>` | Enter a child container (`..` for parent, `/` for root) |
| `pwd` | Print current path in the AX tree |
| `tree [depth]` | Tree view of current node (default depth: 2) |
| `cat <name>` | Read an element's role, value, and text content |
| `grep <pattern>` | Search children by name, role, or value |
| `click <name>` | Click an element |
| `focus <name>` | Focus an input element |
| `type <text>` | Type text into the focused element |
| `whoami` | Check session/auth cookies for the current page |
| `env` | Show environment variables |
| `export K=V` | Set an environment variable |
| `clear` | Clear the terminal |

## How the Filesystem Mapping Works

AgentShell reads the browser's **Accessibility Tree** (AXTree) via the Chrome DevTools Protocol. Each AX node gets mapped to a virtual file or directory:

**Directories** (container roles): `navigation/`, `main/`, `form/`, `list/`, `region/`, `dialog/`, `menu/`, `table/`, etc.

**Files** (interactive/leaf roles): `submit_btn`, `home_link`, `email_input`, `agree_chk`, `theme_switch`, etc.

### Naming Heuristic

Names are generated from the node's accessible name and role:

| AX Node | Generated Name |
|---|---|
| `role=button, name="Submit"` | `submit_btn` |
| `role=link, name="Contact Us"` | `contact_us_link` |
| `role=textbox, name="Email"` | `email_input` |
| `role=checkbox, name="I agree"` | `i_agree_chk` |
| `role=navigation` | `navigation/` |
| `role=generic, no name, 1 child` | *(flattened — child promoted up)* |

Duplicate names are automatically disambiguated with `_2`, `_3`, etc.

### Color Coding in `ls`

- **Blue (bold)** — Directories (containers)
- **Green (bold)** — Buttons
- **Magenta (bold)** — Links
- **Yellow (bold)** — Text inputs / search boxes
- **Cyan (bold)** — Checkboxes / radio buttons / switches
- **White** — Other elements

## Architecture

```
┌─────────────────────┐     chrome.runtime.connect()     ┌─────────────────────┐
│   Side Panel (UI)   │ ◄──────────────────────────────► │  Background Worker  │
│                     │    STDIN/STDOUT messages          │   (Shell Kernel)    │
│  React + Xterm.js   │                                   │                     │
│  Dumb terminal —    │                                   │  Command parser     │
│  captures keys,     │                                   │  Shell state (CWD)  │
│  renders text       │                                   │  VFS mapper         │
│                     │                                   │  CDP client         │
└─────────────────────┘                                   └────────┬────────────┘
                                                                   │
                                                          chrome.debugger
                                                                   │
                                                          ┌────────▼────────────┐
                                                          │   Active Tab        │
                                                          │   Accessibility     │
                                                          │   Tree (AXTree)     │
                                                          └─────────────────────┘
```

The extension follows a **Thin Client / Fat Host** model. The side panel is a dumb terminal — it captures keystrokes and renders ANSI-colored text. All logic lives in the background service worker: command parsing, AX tree traversal, filesystem mapping, and CDP interaction.

### Source Layout

```
src/
  background/
    index.ts        # Shell Kernel — command parser, state manager, message router
    cdp_client.ts   # Promise-wrapped chrome.debugger API
    vfs_mapper.ts   # Accessibility Tree → virtual filesystem mapping
  sidepanel/
    index.html      # Side panel entry HTML
    index.tsx       # React entry point
    Terminal.tsx    # Xterm.js terminal component (Tokyo Night theme)
  shared/
    types.ts        # Message types, AXNode interfaces, role constants
public/
  manifest.json     # Chrome Manifest V3
```

## Tech Stack

- **React** + **TypeScript** — Side panel UI
- **Xterm.js** (`@xterm/xterm`) — Terminal emulator with Tokyo Night color scheme
- **Vite** — Build tooling with multi-entry Chrome Extension support
- **Chrome DevTools Protocol** (CDP) via `chrome.debugger` — AX tree access and element interaction
- **Chrome Manifest V3** — `sidePanel`, `debugger`, `activeTab`, `cookies` permissions

## Development

```bash
# Watch mode (rebuilds on file changes)
npm run dev

# One-time production build
npm run build

# Type checking
npm run typecheck
```

After building, reload the extension in `chrome://extensions/` to pick up changes.

## How This Project Was Built

The technical specification for AgentShell was authored by **Google Gemini**, designed as a comprehensive prompt that could be handed directly to a coding agent to scaffold and build the entire project from scratch. The full original specification is preserved in [`intitial_project_prompt.md`](intitial_project_prompt.md).

The implementation was then built by **Claude** (Anthropic) via [Claude Code](https://claude.ai/code), working from that specification.

An AI-designed project, built by another AI, intended for AI agents to use. It's agents all the way down.

## License

ISC
