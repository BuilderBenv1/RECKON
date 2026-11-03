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

  async speak(text: string): Promise<void> {
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
    this.interrupted = true;
    this.synth?.cancel();
  }

  resume() {
    this.paused = false;
    this.wake?.();
    this.wake = null;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (m) {
      this.interrupted = true;
      this.synth?.cancel();
    }
  }

  stop() {
    this.cancelled = true;
    this.interrupted = true;
    this.synth?.cancel();
    this.wake?.();
    this.wake = null;
  }
}
