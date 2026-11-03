'use client';

// The guided demo's voice. Uses the browser's own speech synthesis, so there are no keys and
// anyone can play it. Speaks a sentence at a time: Chrome cuts long utterances off, and it makes
// pause and resume reliable (pause cancels the sentence; resume says it again).

export class Cancelled extends Error {
  constructor() {
    super('Tour stopped');
  }
}

const PREFERRED = [
  /Microsoft (Sonia|Ryan|Libby|Maisie|Thomas).*Natural/i, // Edge's neural en-GB voices
  /Google UK English (Male|Female)/i,
  /^(Daniel|Arthur|Serena|Kate|Oliver)\b/i, // macOS en-GB
  /Natural/i,
];

export function englishVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  return window.speechSynthesis.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
}

export function pickVoice(voices: SpeechSynthesisVoice[], wanted?: string | null): SpeechSynthesisVoice | null {
  if (wanted) {
    const w = voices.find((v) => v.name === wanted);
    if (w) return w;
  }
  for (const re of PREFERRED) {
    const gb = voices.find((v) => re.test(v.name) && /GB/i.test(v.lang));
    if (gb) return gb;
    const any = voices.find((v) => re.test(v.name));
    if (any) return any;
  }
  return voices.find((v) => /en[-_]GB/i.test(v.lang)) ?? voices[0] ?? null;
}

/** Same id as the server's lineId: sha256 hex, first 20 characters. */
async function lineId(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

const sentences = (text: string) => text.match(/[^.!?]+(?:[.!?]+["']?|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
const readingMs = (text: string) => Math.max(1600, (text.split(/\s+/).length / 2.7) * 1000);

export class Narrator {
  voice: SpeechSynthesisVoice | null = null;
  rate = 1.05;
  muted = false;
  private cancelled = false;
  private paused = false;
  private wake: (() => void) | null = null;
  private interrupted = false;
  /** Use the voiced clips from /api/narration when the server has a voice. */
  human = false;
  private clips = new Map<string, Promise<string | null>>();
  private queue: Promise<unknown> = Promise.resolve();
  private audio: HTMLAudioElement | null = null;
  private endAudio: (() => void) | null = null;

  private get synth(): SpeechSynthesis | null {
    return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
  }

  get isPaused() {
    return this.paused;
  }

  /** Waits while paused; throws once stopped. */
  async gate(): Promise<void> {
    while (this.paused && !this.cancelled) await new Promise<void>((r) => (this.wake = r));
    if (this.cancelled) throw new Cancelled();
  }

  async wait(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await this.gate();
      await new Promise((r) => setTimeout(r, Math.min(150, end - Date.now())));
    }
    await this.gate();
  }

  /** Starts fetching clips one after another (generation is rate-limited), ahead of need. */
  prefetch(texts: string[]) {
    if (!this.human) return;
    for (const t of texts) {
      if (this.clips.has(t)) continue;
      const p = this.queue.then(() => this.fetchClip(t));
      this.clips.set(t, p);
      this.queue = p.catch(() => null);
    }
  }

  private async fetchClip(text: string): Promise<string | null> {
    try {
      const res = await fetch(`/api/narration/${await lineId(text)}`);
      if (!res.ok) return null;
      return URL.createObjectURL(await res.blob());
    } catch {
      return null;
    }
  }

  async speak(text: string): Promise<void> {
    if (this.human) {
      this.prefetch([text]);
      const url = await this.clips.get(text);
      await this.gate();
      if (url) {
        await this.playClip(url);
        await this.gate();
        return;
      }
    }
    const synth = this.synth;
    for (const line of sentences(text)) {
      for (;;) {
        await this.gate();
        if (this.muted || !synth) {
          await this.wait(readingMs(line));
          break;
        }
        this.interrupted = false;
        await this.utter(synth, line);
        if (!this.interrupted) break; // paused mid-sentence: say it again on resume
      }
    }
    await this.gate();
  }

  private playClip(url: string): Promise<void> {
    return new Promise((resolve) => {
      const a = new Audio(url);
      a.muted = this.muted;
      this.audio = a;
      const done = () => {
        if (this.audio === a) {
          this.audio = null;
          this.endAudio = null;
        }
        resolve();
      };
      this.endAudio = done;
      a.onended = done;
      a.onerror = done;
      a.play().catch(done);
    });
  }

  private utter(synth: SpeechSynthesis, line: string): Promise<void> {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(line);
      if (this.voice) {
        u.voice = this.voice;
        u.lang = this.voice.lang;
      } else u.lang = 'en-GB';
      u.rate = this.rate;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolve();
      };
      // Some engines never fire onend; don't let the tour hang on one.
      const guard = setTimeout(finish, readingMs(line) * 2 + 4000);
      u.onend = finish;
      u.onerror = finish;
      synth.speak(u);
    });
  }

  pause() {
    this.paused = true;
    if (this.audio) {
      this.audio.pause();
      return;
    }
    this.interrupted = true;
    this.synth?.cancel();
  }

  resume() {
    this.paused = false;
    if (this.audio) void this.audio.play().catch(() => this.endAudio?.());
    this.wake?.();
    this.wake = null;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.audio) {
      this.audio.muted = m;
      return;
    }
    if (m) {
      this.interrupted = true;
      this.synth?.cancel();
    }
  }

  stop() {
    this.cancelled = true;
    this.interrupted = true;
    this.synth?.cancel();
    this.audio?.pause();
    this.endAudio?.();
    this.wake?.();
    this.wake = null;
  }
}
