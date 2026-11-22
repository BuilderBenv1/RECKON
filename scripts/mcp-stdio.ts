import { createInterface } from 'node:readline';
import { handleMessage } from '../src/mcp/server.js';

// Reckon's MCP server over stdio, for clients that start a local process (Claude Code, Claude
// Desktop, Cursor): one JSON-RPC message per line in, one per line out. No keys needed.
//   npm run mcp

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the line is not valid JSON.' } }) + '\n');
    return;
  }
  const replies = (Array.isArray(msg) ? msg : [msg]).map(handleMessage).filter((r) => r !== null);
  if (!replies.length) return;
  process.stdout.write(JSON.stringify(Array.isArray(msg) ? replies : replies[0]) + '\n');
});
