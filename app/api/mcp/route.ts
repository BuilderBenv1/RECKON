import { handleHttp } from '../../../src/mcp/server';

// Reckon's MCP endpoint: read-only tools over the planner for ChatGPT, Claude and other MCP clients.
// Add it to a client as a remote (streamable HTTP) server with no authentication.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handleHttp;
export const GET = handleHttp;
export const DELETE = handleHttp;
export const OPTIONS = handleHttp;
