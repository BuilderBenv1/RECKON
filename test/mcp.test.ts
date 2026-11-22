import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultPolicy, seedBalances, seedBook, seedRates } from '../src/domain/seed.js';
import { plan } from '../src/policy/plan.js';
import { initialState } from '../src/policy/state.js';
import { handleHttp, handleMessage, PROTOCOL_VERSIONS } from '../src/mcp/server.js';
import { callTool, ToolInputError, TOOLS } from '../src/mcp/tools.js';

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const call = (name: string, args?: unknown) => handleMessage(rpc('tools/call', { name, arguments: args }))!;
const late = { late_receipts: [{ receivable_id: 'REC-109-M3', new_expected_day: 8 }] };

describe('MCP tools: read-only answers from the planner', () => {
  it('says the week is covered on the books as they stand', () => {
    const r = callTool('cash_position', {});
    expect(r).toMatchObject({ covered: true, gapUSD: 0, costToCloseUSD: 0, spendableUSD: 10085 });
  });

  it('reports the same gap and cost the planner does when a customer pays late', () => {
    const s = initialState(structuredClone(seedBook), { ...seedBalances }, { ...seedRates });
    s.signals.push({ kind: 'receipt_delayed', receivableId: 'REC-109-M3', newExpectedDay: 8, evidence: 'test' });
    const direct = plan(s, defaultPolicy).summary;

    const r = callTool('cash_position', late);
    expect(r).toMatchObject({ covered: false, gapUSD: direct.gapUSD, costToCloseUSD: direct.leversCostUSD, stillShortUSD: 0, forecastConfidence: 'low' });
    expect(r.gapUSD).toBeGreaterThan(0);
  });

  it('gives every decision with its rule and reason, and marks what needs a person', () => {
    const r = callTool('get_plan', late) as { decisions: { id: string; who: string; rule: string; reason: string }[]; needsApproval: string[]; ranking: { billId: string; supplier: string }[] };
    expect(r.decisions.map((d) => d.id)).toEqual(expect.arrayContaining(['defer:PAY-OH-SAAS', 'ask_split:PAY-121-COMP', 'early_pay_link:REC-121-INV', 'convert:EUR']));
    expect(r.decisions.every((d) => d.rule && d.reason)).toBe(true);
    expect(r.needsApproval).toContain('convert:EUR');
    expect(r.decisions.find((d) => d.id === 'convert:EUR')?.who).toBe('needs_approval');
    expect(r.ranking[0]).toMatchObject({ billId: 'PAY-114-FREIGHT', supplier: 'Rheinfracht Logistik GmbH' });
  });

  it('what_if shows the position before and after and only the decisions that moved', () => {
    const r = callTool('what_if', late) as { before: { covered: boolean }; after: { covered: boolean }; changes: { id: string; change: string }[] };
    expect(r.before.covered).toBe(true);
    expect(r.after.covered).toBe(false);
    expect(r.changes.map((c) => c.id)).toContain('early_pay_link:REC-121-INV');
    expect(r.changes.map((c) => c.id)).not.toContain('pay:PAY-114-FREIGHT');
  });

  it('replans when a supplier agrees to split, naming both parts in the ranking', () => {
    const r = callTool('get_plan', { ...late, split_replies: [{ payable_id: 'PAY-121-COMP', accepted: true }] }) as { ranking: { billId: string; supplier: string | null }[] };
    expect(r.ranking.find((x) => x.billId === 'PAY-121-COMP-A')?.supplier).toBe('Pennine Joinery Supplies Ltd');
  });

  it('is pure: the same question gives the same answer and leaves the books untouched', () => {
    const before = JSON.stringify(seedBook);
    expect(callTool('get_plan', late)).toEqual(callTool('get_plan', late));
    callTool('what_if', late);
    expect(JSON.stringify(seedBook)).toBe(before);
    expect(callTool('cash_position', {})).toMatchObject({ covered: true });
  });

  it('lists the books without customer email addresses', () => {
    const r = callTool('list_bills_and_invoices', {});
    expect((r.bills as unknown[]).length).toBe(seedBook.payables.length);
    expect(JSON.stringify(r)).not.toMatch(/@/);
  });

  it('refuses input it does not understand, and says what is allowed', () => {
    expect(() => callTool('cash_position', { late_receipts: [{ receivable_id: 'REC-NOPE', new_expected_day: 3 }] })).toThrow(/Unknown receivable_id.*REC-109-M3/);
    expect(() => callTool('cash_position', { late_receipts: [{ receivable_id: 'REC-109-M3', new_expected_day: 2.5 }] })).toThrow(ToolInputError);
    expect(() => callTool('cash_position', { pay_now: true })).toThrow(/unknown field "pay_now"/);
    expect(() => callTool('what_if', {})).toThrow(/at least one change/);
    expect(() => callTool('what_if', { split_replies: [{ payable_id: 'PAY-109-SUB', accepted: true }] })).toThrow(/has not accepted split payments/);
    expect(() => callTool('list_bills_and_invoices', { anything: 1 })).toThrow(ToolInputError);
  });
});

describe('MCP tools cannot move money', () => {
  it('every tool is declared read-only', () => {
    expect(TOOLS.length).toBeGreaterThan(0);
    for (const t of TOOLS) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('nothing under src/mcp imports Airwallex, the ledger, the run store, the agent that acts, or a model', () => {
    const dir = new URL('../src/mcp/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const imports = [...readFileSync(new URL(f, dir), 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(/airwallex|ledger|store|reckon\.js|session|anthropic|webhooks|drafter|reader/);
    }
  });
});

describe('MCP protocol', () => {
  it('initializes at the version the client asks for, or offers its newest', () => {
    const a = handleMessage(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } }))!;
    expect(a.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'reckon' }, capabilities: { tools: {} } });
    const b = handleMessage(rpc('initialize', { protocolVersion: '1999-01-01' }))!;
    expect((b.result as { protocolVersion: string }).protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it('lists the tools and answers ping', () => {
    const names = (handleMessage(rpc('tools/list'))!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(['list_bills_and_invoices', 'cash_position', 'get_plan', 'what_if']);
    expect(handleMessage(rpc('ping'))!.result).toEqual({});
  });

  it('returns a tool result as text and as structured content', () => {
    const r = call('cash_position', {}).result as { content: { type: string; text: string }[]; structuredContent: unknown; isError: boolean };
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content[0]!.text)).toEqual(r.structuredContent);
  });

  it('reports bad arguments as a tool error the agent can read, and an unknown tool as a protocol error', () => {
    const bad = call('cash_position', { late_receipts: 'soon' }).result as { isError: boolean; content: { text: string }[] };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/must be a list/);
    expect(call('pay_supplier', { amount: 1 }).error).toMatchObject({ code: -32602 });
  });

  it('stays silent on notifications and rejects what is not JSON-RPC', () => {
    expect(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(handleMessage({ jsonrpc: '2.0', id: 9, result: {} })).toBeNull();
    expect(handleMessage({ hello: 'world' })!.error).toMatchObject({ code: -32600 });
    expect(handleMessage(rpc('resources/list'))!.error).toMatchObject({ code: -32601 });
  });
});

describe('MCP over HTTP', () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handleHttp(new Request('http://localhost/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }));

  it('answers a request with JSON and a notification with 202', async () => {
    const res = await post(rpc('tools/list'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(TOOLS.length);
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
  });

  it('answers a batch, in order', async () => {
    const res = await post([rpc('ping', undefined, 'a'), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('tools/list', undefined, 'b')]);
    expect(((await res.json()) as { id: string }[]).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('refuses GET, bad JSON, an unknown protocol version and an oversized body', async () => {
    const get = await handleHttp(new Request('http://localhost/api/mcp', { method: 'GET' }));
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toMatch(/POST/);
    expect((await post('{not json')).status).toBe(400);
    expect((await post(rpc('ping'), { 'mcp-protocol-version': '1999-01-01' })).status).toBe(400);
    expect((await post(rpc('ping'), { 'mcp-protocol-version': PROTOCOL_VERSIONS[1] })).status).toBe(200);
    expect((await post(rpc('ping', { pad: 'x'.repeat(120_000) }))).status).toBe(413);
    expect((await post([])).status).toBe(400);
  });

  it('answers a browser preflight', async () => {
    const res = await handleHttp(new Request('http://localhost/api/mcp', { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('a real MCP client can use it', () => {
  let server: Server;
  let url: URL;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const out = await handleHttp(new Request(`http://localhost${req.url}`, { method: req.method, headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}) }));
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('connects with the official SDK, lists the tools and asks a what-if', async () => {
    const client = new Client({ name: 'reckon-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    expect(client.getServerVersion()).toMatchObject({ name: 'reckon' });
    expect(client.getInstructions()).toMatch(/read-only/);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('what_if');
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

    const res = await client.callTool({ name: 'what_if', arguments: late });
    expect(res.isError).toBe(false);
    expect(res.structuredContent).toMatchObject({ before: { covered: true }, after: { covered: false } });

    const bad = await client.callTool({ name: 'cash_position', arguments: { late_receipts: [{ receivable_id: 'X', new_expected_day: 1 }] } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});
