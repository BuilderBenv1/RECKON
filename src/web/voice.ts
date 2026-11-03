import { createHash } from 'node:crypto';
import { Session } from '../demo/session.js';
import { after, afterTamper, before, intro, outro, TOUR_STEPS } from './narration.js';
import { buildView, type RunView } from './view.js';

// Human narration for the guided demo. Each line is voiced once by ElevenLabs and cached in
// Supabase Storage, so judges replaying the demo cost nothing. Only lines the demo itself would
// say can be voiced: the allowlist is the demo script, rebuilt here from a fresh demo run.

export const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb'; // ElevenLabs "George": warm, British
export const DEFAULT_MODEL = 'eleven_multilingual_v2';

/** The id the browser asks for. Same algorithm in narrator.ts: sha256 hex, first 20. */
export const lineId = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 20);

export interface VoiceConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
}

export function voiceConfig(env: Record<string, string | undefined> = process.env): VoiceConfig | null {
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, voiceId: env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE, modelId: env.ELEVENLABS_MODEL?.trim() || DEFAULT_MODEL };
}

let script: Promise<string[]> | null = null;

/** Every line the guided demo can say, in order. Includes the Claude-on wording of the lines that differ. */
export function demoScript(): Promise<string[]> {
  return (script ??= (async () => {
    const s = await Session.create('demo', { claude: false });
    let v: RunView = buildView('script', s);
    const lines: string[] = [];
    const add = (beats: { text: string }[]) => beats.forEach((b) => lines.push(b.text));
    const both = (f: (x: RunView) => { text: string }[], x: RunView) => {
      add(f(x));
      add(f({ ...x, claude: true }).filter((b) => !lines.includes(b.text)));
    };
    both(intro, v);
    for (const step of TOUR_STEPS) {
      add(before(step, v));
      const prev = v;
      await s.act(v.steps.find((x) => x.id === step)!.action!);
      v = buildView('script', s);
      both((x) => after(step, { ...prev, claude: x.claude }, x), v);
    }
    await s.act({ type: 'replay', decisionId: 'convert:EUR', tamper: true });
    v = buildView('script', s);
    add(afterTamper(v));
    add(outro(v));
    return [...new Set(lines)];
  })());
}

export async function findLine(id: string): Promise<{ text: string; previous?: string; next?: string } | null> {
  if (!/^[0-9a-f]{20}$/.test(id)) return null;
  const lines = await demoScript();
  const i = lines.findIndex((t) => lineId(t) === id);
  if (i < 0) return null;
  return { text: lines[i]!, ...(i > 0 ? { previous: lines[i - 1] } : {}), ...(i < lines.length - 1 ? { next: lines[i + 1] } : {}) };
}

/** The storage key changes with the voice and model, so switching voice re-records. */
export const clipKey = (cfg: VoiceConfig, text: string) =>
  createHash('sha256').update(`${cfg.voiceId}|${cfg.modelId}|${text}`).digest('hex').slice(0, 32);

export async function synthesise(cfg: VoiceConfig, line: { text: string; previous?: string; next?: string }, fetchImpl: typeof fetch = fetch): Promise<ArrayBuffer> {
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: line.text,
      model_id: cfg.modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true },
      ...(line.previous ? { previous_text: line.previous } : {}),
      ...(line.next ? { next_text: line.next } : {}),
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.arrayBuffer();
}

// ---------------------------------------------------------------- clip cache

export interface ClipStore {
  /** A URL the browser can fetch the cached clip from, or null if it isn't cached. */
  url(key: string): Promise<string | null>;
  put(key: string, mp3: ArrayBuffer): Promise<void>;
  get?(key: string): ArrayBuffer | undefined;
}

const BUCKET = 'narration';

/** Supabase Storage, public bucket `narration` (created by migration 0002). */
export class SupabaseClipStore implements ClipStore {
  constructor(
    private readonly base: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private publicUrl(key: string) {
    return `${this.base.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/${key}.mp3`;
  }
  async url(key: string) {
    const u = this.publicUrl(key);
    const res = await this.fetchImpl(u, { method: 'HEAD', cache: 'no-store' });
    return res.ok ? u : null;
  }
  async put(key: string, mp3: ArrayBuffer) {
    const res = await this.fetchImpl(`${this.base.replace(/\/$/, '')}/storage/v1/object/${BUCKET}/${key}.mp3`, {
      method: 'POST',
      headers: {
        apikey: this.key,
        ...(this.key.startsWith('eyJ') ? { Authorization: `Bearer ${this.key}` } : {}),
        'Content-Type': 'audio/mpeg',
        'x-upsert': 'true',
        'Cache-Control': 'max-age=31536000',
      },
      body: mp3,
    });
    if (!res.ok) throw new Error(`Storage upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

const g = globalThis as unknown as { __reckonClips?: Map<string, ArrayBuffer> };

/** Without Supabase: keep clips in this server's memory. */
export class MemoryClipStore implements ClipStore {
  private m = (g.__reckonClips ??= new Map());
  async url() {
    return null;
  }
  get(key: string) {
    return this.m.get(key);
  }
  async put(key: string, mp3: ArrayBuffer) {
    this.m.set(key, mp3);
  }
}

export function clipStore(env: Record<string, string | undefined> = process.env): ClipStore {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? new SupabaseClipStore(url, key) : new MemoryClipStore();
}

export type ClipResult = { redirect: string } | { audio: ArrayBuffer } | { missing: string };

/** Cached clip if there is one; otherwise voice it now and cache it. */
export async function clipFor(id: string, deps: { cfg: VoiceConfig | null; store: ClipStore; fetchImpl?: typeof fetch }): Promise<ClipResult> {
  const line = await findLine(id);
  if (!line) return { missing: 'not a line from the guided demo' };
  if (!deps.cfg) return { missing: 'no voice configured' };
  const key = clipKey(deps.cfg, line.text);
  const mem = deps.store.get?.(key);
  if (mem) return { audio: mem };
  const cached = await deps.store.url(key).catch(() => null);
  if (cached) return { redirect: cached };
  const audio = await synthesise(deps.cfg, line, deps.fetchImpl);
  await deps.store.put(key, audio).catch((err) => console.error('narration cache', (err as Error).message));
  return { audio };
}
