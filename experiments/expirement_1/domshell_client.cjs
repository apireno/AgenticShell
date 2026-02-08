// DOMShell MCP Client - sends commands via stdio MCP protocol
const { spawn } = require('child_process');
const readline = require('readline');

const TOKEN = '52642f3f8e93d6be3e59aa90aa3526d06392a2cb5493aaf4';
const PORT = 9876;
const SERVER_PATH = '/Users/apireno/repos/DOMShell/mcp-server/index.ts';

async function main() {
  const command = process.argv[2];
  if (!command) {
    console.error('Usage: node domshell_client.js "<command>"');
    process.exit(1);
  }

  // Start MCP server
  const child = spawn('npx', ['tsx', SERVER_PATH, '--port', String(PORT), '--allow-write', '--no-confirm', '--token', TOKEN], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: '/Users/apireno/repos/DOMShell/mcp-server'
  });

  let serverReady = false;
  let chromeConnected = false;

  // Monitor stderr for status
  child.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('WebSocket server listening')) serverReady = true;
    if (msg.includes('Extension connected')) chromeConnected = true;
  });

  // Read stdout line by line
  const rl = readline.createInterface({ input: child.stdout });
  const responses = [];
  rl.on('line', (line) => {
    try {
      const parsed = JSON.parse(line);
      responses.push(parsed);
    } catch {}
  });

  function sendMsg(obj) {
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  // Wait for server ready
  await waitFor(() => serverReady, 5000, 'Server did not start');

  // Send MCP initialize
  sendMsg({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'domshell-client', version: '1.0' }
    }
  });

  // Wait for initialize response
  await waitFor(() => responses.some(r => r.id === 1), 3000, 'Initialize timeout');

  // Send initialized notification
  sendMsg({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // Wait for Chrome to reconnect
  console.error('Waiting for Chrome to reconnect...');
  await waitFor(() => chromeConnected, 15000, 'Chrome did not reconnect');
  console.error('Chrome connected!');

  // Now execute the command using domshell_execute tool
  sendMsg({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: {
      name: 'domshell_execute',
      arguments: { command }
    }
  });

  // Wait for response
  await waitFor(() => responses.some(r => r.id === 2), 35000, 'Command timeout');

  const result = responses.find(r => r.id === 2);
  if (result && result.result && result.result.content) {
    for (const c of result.result.content) {
      console.log(c.text || '');
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
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

main().catch(e => { console.error(e.message); process.exit(1); });
