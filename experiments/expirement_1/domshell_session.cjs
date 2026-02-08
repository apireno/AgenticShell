// DOMShell MCP Session Client - runs multiple commands in sequence
const { spawn } = require('child_process');
const readline = require('readline');

const TOKEN = '52642f3f8e93d6be3e59aa90aa3526d06392a2cb5493aaf4';
const PORT = 9876;
const SERVER_PATH = '/Users/apireno/repos/DOMShell/mcp-server/index.ts';

// Read commands from stdin, one per line
const commands = [];
const stdinRl = readline.createInterface({ input: process.stdin });

stdinRl.on('line', (line) => {
  if (line.trim()) commands.push(line.trim());
});

stdinRl.on('close', async () => {
  if (commands.length === 0) {
    console.error('No commands provided');
    process.exit(1);
  }
  await runSession(commands);
});

async function runSession(cmds) {
  // Start MCP server
  const child = spawn('npx', ['tsx', SERVER_PATH, '--port', String(PORT), '--allow-write', '--no-confirm', '--token', TOKEN], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: '/Users/apireno/repos/DOMShell/mcp-server'
  });

  let serverReady = false;
  let chromeConnected = false;

  child.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('WebSocket server listening')) serverReady = true;
    if (msg.includes('Extension connected')) chromeConnected = true;
  });

  let buffer = '';
  const responses = new Map();

  child.stdout.on('data', (data) => {
    buffer += data.toString();
    // Try to parse complete JSON objects
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line
    for (const line of lines) {
      if (line.trim()) {
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.id !== undefined) {
            responses.set(parsed.id, parsed);
          }
        } catch {}
      }
    }
  });

  function sendMsg(obj) {
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  // Wait for server
  await waitFor(() => serverReady, 5000, 'Server did not start');

  // Initialize MCP
  sendMsg({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'domshell-client', version: '1.0' }
    }
  });
  await waitFor(() => responses.has(1), 3000, 'Initialize timeout');
  sendMsg({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // Wait for Chrome
  console.error('Waiting for Chrome...');
  await waitFor(() => chromeConnected, 15000, 'Chrome did not reconnect');
  console.error('Chrome connected!');

  // Execute commands sequentially
  let cmdId = 10;
  for (const cmd of cmds) {
    cmdId++;
    console.log(`\n===== COMMAND: ${cmd} =====`);

    // Determine the right MCP tool based on the command
    let toolName = 'domshell_execute';
    let toolArgs = { command: cmd };

    // Map specific commands to dedicated tools
    const parts = cmd.split(/\s+/);
    const verb = parts[0];

    if (verb === 'navigate') {
      toolName = 'domshell_navigate';
      toolArgs = { url: parts.slice(1).join(' ') };
    } else if (verb === 'open') {
      toolName = 'domshell_open';
      toolArgs = { url: parts.slice(1).join(' ') };
    } else if (verb === 'text') {
      toolName = 'domshell_text';
      toolArgs = {};
      if (parts[1]) toolArgs.name = parts.slice(1).join(' ');
    } else if (verb === 'find') {
      toolName = 'domshell_find';
      toolArgs = {};
      // Parse find arguments
      for (let i = 1; i < parts.length; i++) {
        if (parts[i] === '--type' && parts[i+1]) { toolArgs.type = parts[++i]; }
        else if (parts[i] === '--meta') { toolArgs.meta = true; }
        else if (parts[i] === '--limit' && parts[i+1]) { toolArgs.limit = parseInt(parts[++i]); }
        else if (!parts[i].startsWith('-')) { toolArgs.pattern = parts[i]; }
      }
    } else if (verb === 'cd') {
      toolName = 'domshell_cd';
      toolArgs = { path: parts.slice(1).join(' ') };
    } else if (verb === 'ls') {
      toolName = 'domshell_ls';
      toolArgs = parts.length > 1 ? { options: parts.slice(1).join(' ') } : {};
    } else if (verb === 'cat') {
      toolName = 'domshell_cat';
      toolArgs = { name: parts.slice(1).join(' ') };
    } else if (verb === 'tree') {
      toolName = 'domshell_tree';
      toolArgs = parts[1] ? { depth: parseInt(parts[1]) } : {};
    } else if (verb === 'pwd') {
      toolName = 'domshell_pwd';
      toolArgs = {};
    } else if (verb === 'click') {
      toolName = 'domshell_click';
      toolArgs = { name: parts.slice(1).join(' ') };
    } else if (verb === 'grep') {
      toolName = 'domshell_grep';
      toolArgs = { pattern: parts.slice(1).join(' '), recursive: true };
    } else if (verb === 'tabs') {
      toolName = 'domshell_tabs';
      toolArgs = {};
    } else if (verb === 'here') {
      toolName = 'domshell_here';
      toolArgs = {};
    }

    sendMsg({
      jsonrpc: '2.0', id: cmdId, method: 'tools/call',
      params: { name: toolName, arguments: toolArgs }
    });

    try {
      await waitFor(() => responses.has(cmdId), 35000, `Timeout: ${cmd}`);
      const result = responses.get(cmdId);
      if (result && result.result && result.result.content) {
        for (const c of result.result.content) {
          console.log(c.text || '');
        }
      } else if (result && result.error) {
        console.log(`ERROR: ${JSON.stringify(result.error)}`);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }

  child.kill();
  process.exit(0);
}

function waitFor(condition, timeoutMs, errMsg) {
  return new Promise((resolve, reject) => {
    if (condition()) return resolve();
    const interval = setInterval(() => {
      if (condition()) { clearInterval(interval); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(interval); reject(new Error(errMsg)); }, timeoutMs);
  });
}
