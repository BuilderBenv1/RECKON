import { callTool, ToolInputError, TOOLS, UnknownToolError } from './tools.js';

// A small Model Context Protocol server over Reckon's planner, so an agent in ChatGPT, Claude or
// any other MCP client can ask Reckon questions. Stateless JSON-RPC: one request in, one response
// out, no sessions and no streams, which is all four read-only tools need and suits serverless.

export const SERVER_INFO = { name: 'reckon', title: 'Reckon', version: '0.1.0' } as const;

/** Newest first. A client asking for a version we don't know is offered the newest we do. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

export const INSTRUCTIONS =
  'Reckon is a finance agent for businesses that get paid in stages. These tools are read-only: they answer whether the business can cover the bills due this week, ' +
  'show the plan Reckon would follow and why, and replan for a what-if such as a customer paying late. They cannot pay, convert or send anything. ' +
  'Money moves only inside Reckon, through fixed rules in code, after a person approves anything above the limits. Amounts are in major units (USD 850 is eight hundred and fifty dollars). ' +
  'The data is a demo business with synthetic figures. Start with list_bills_and_invoices to get ids.';

type Id = string | number | null;
interface RpcResponse {
  jsonrpc: '2.0';
  id: Id;
  result?: unknown;
  error?: { code: number; message: string };
}

const ok = (id: Id, result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id, code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Handles one JSON-RPC message. Returns null for notifications and for responses, which need no reply. */
export function handleMessage(msg: unknown): RpcResponse | null {
  if (!isRecord(msg) || msg.jsonrpc !== '2.0') return fail(null, -32600, 'Invalid request: expected a JSON-RPC 2.0 message.');
  const hasId = typeof msg.id === 'string' || typeof msg.id === 'number';
  if (typeof msg.method !== 'string') {
    // A response to something we never asked: nothing to do.
    if (hasId && ('result' in msg || 'error' in msg)) return null;
    return fail(hasId ? (msg.id as Id) : null, -32600, 'Invalid request: missing method.');
  }
  if (!hasId) return null; // notification
  const id = msg.id as Id;
  const params = isRecord(msg.params) ? msg.params : {};

  switch (msg.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked as string) ? (asked as string) : PROTOCOL_VERSIONS[0];
      return ok(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      if (typeof params.name !== 'string') return fail(id, -32602, 'tools/call needs a tool name.');
      try {
        const result = callTool(params.name, params.arguments);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
      } catch (err) {
        if (err instanceof UnknownToolError) return fail(id, -32602, err.message);
        // Bad arguments go back as a tool result so the agent can read the message and try again.
        if (err instanceof ToolInputError) return ok(id, { content: [{ type: 'text', text: err.message }], isError: true });
        return fail(id, -32603, 'Internal error.');
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${msg.method}`);
  }
}

const MAX_BODY_BYTES = 100_000;
const MAX_BATCH = 20;

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, authorization',
  'access-control-max-age': '86400',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });

/**
 * MCP's Streamable HTTP transport, stateless form: every POST is answered with plain JSON.
 * The endpoint is public and unauthenticated on purpose: it serves read-only answers about
 * synthetic data, reads no run, and calls nothing outside this process.
 */
export async function handleHttp(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') {
    // No server-to-client stream is offered, and there are no sessions to end.
    return new Response(JSON.stringify(fail(null, -32000, 'Method not allowed: POST JSON-RPC messages to this endpoint.')), {
      status: 405,
      headers: { 'content-type': 'application/json', allow: 'POST, OPTIONS', ...CORS },
    });
  }

  const version = req.headers.get('mcp-protocol-version');
  if (version && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return json(fail(null, -32600, `Unsupported MCP-Protocol-Version: ${version}. Supported: ${PROTOCOL_VERSIONS.join(', ')}.`), 400);
  }

  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json(fail(null, -32600, 'Request too large.'), 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(fail(null, -32700, 'Parse error: the body is not valid JSON.'), 400);
  }

  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > MAX_BATCH) return json(fail(null, -32600, `A batch must hold 1 to ${MAX_BATCH} messages.`), 400);
    const replies = body.map(handleMessage).filter((r): r is RpcResponse => r !== null);
    return replies.length ? json(replies) : new Response(null, { status: 202, headers: CORS });
  }
  const reply = handleMessage(body);
  return reply ? json(reply) : new Response(null, { status: 202, headers: CORS });
}
