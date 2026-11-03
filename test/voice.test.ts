import { describe, expect, it } from 'vitest';
import { clipFor, clipKey, demoScript, findLine, lineId, MemoryClipStore, SupabaseClipStore, voiceConfig } from '../src/web/voice.js';

const cfg = { apiKey: 'test-key', voiceId: 'voice1', modelId: 'model1' };

describe('guided demo voice', () => {
  it('builds the allowlist from the demo itself, Claude-on lines included', async () => {
    const lines = await demoScript();
    expect(lines.length).toBeGreaterThan(25);
    expect(new Set(lines.map(lineId)).size).toBe(lines.length);
    expect(lines.some((l) => l.startsWith('In a live run, Claude reads that email'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Claude reads that email'))).toBe(true);
    expect(lines.join(' ').length).toBeLessThan(5000); // fits a free ElevenLabs month
  });

  it('matches the browser id (sha256 hex, first 20)', async () => {
    const text = (await demoScript())[0]!;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
    expect(lineId(text)).toBe(hex);
  });

  it('refuses anything that is not a line of the demo', async () => {
    expect(await findLine('../../etc')).toBeNull();
    expect(await findLine('0'.repeat(20))).toBeNull();
    const out = await clipFor('0'.repeat(20), { cfg, store: new MemoryClipStore() });
    expect(out).toEqual({ missing: 'not a line from the guided demo' });
  });

  it('voices a line once with neighbouring text for flow, then serves the cached clip', async () => {
    const lines = await demoScript();
    const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const store = new MemoryClipStore();
    const id = lineId(lines[1]!);
    const first = await clipFor(id, { cfg, store, fetchImpl });
    expect('audio' in first).toBe(true);
    expect(calls[0]!.url).toContain('/v1/text-to-speech/voice1');
    expect(calls[0]!.headers['xi-api-key']).toBe('test-key');
    expect(calls[0]!.body).toMatchObject({ text: lines[1], model_id: 'model1', previous_text: lines[0], next_text: lines[2] });
    await clipFor(id, { cfg, store, fetchImpl });
    expect(calls).toHaveLength(1);
  });

  it('re-records when the voice changes, and needs a key', async () => {
    expect(clipKey(cfg, 'x')).not.toBe(clipKey({ ...cfg, voiceId: 'voice2' }, 'x'));
    expect(voiceConfig({})).toBeNull();
    expect(voiceConfig({ ELEVENLABS_API_KEY: ' k ' })).toMatchObject({ apiKey: 'k', voiceId: 'JBFqnCBsd6RMkjVDRZzb' });
    const id = lineId((await demoScript())[0]!);
    expect(await clipFor(id, { cfg: null, store: new MemoryClipStore() })).toEqual({ missing: 'no voice configured' });
  });

  it('redirects to a clip already in Supabase Storage without calling ElevenLabs', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url}`);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const store = new SupabaseClipStore('https://x.supabase.co/', 'sb_secret_abc', fetchImpl);
    const id = lineId((await demoScript())[0]!);
    const out = await clipFor(id, { cfg, store, fetchImpl });
    expect(out).toEqual({ redirect: expect.stringMatching(/^https:\/\/x\.supabase\.co\/storage\/v1\/object\/public\/narration\/[0-9a-f]{32}\.mp3$/) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^HEAD /);
  });
});
