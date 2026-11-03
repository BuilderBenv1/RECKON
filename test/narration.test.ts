import { describe, expect, it } from 'vitest';
import { Session } from '../src/demo/session.js';
import { buildView, type RunView } from '../src/web/view.js';
import { after, afterTamper, before, intro, outro, presenterName, say, spoken, TOUR_STEPS, type Beat } from '../src/web/narration.js';

async function tour() {
  const s = await Session.create('demo', { claude: false });
  let v: RunView = buildView('t', s);
  const script: { step: string; beats: Beat[] }[] = [{ step: 'intro', beats: intro(v) }];
  for (const step of TOUR_STEPS) {
    script.push({ step: `before:${step}`, beats: before(step, v) });
    const action = v.steps.find((x) => x.id === step)!.action!;
    const prev = v;
    await s.act(action);
    v = buildView('t', s);
    script.push({ step: `after:${step}`, beats: after(step, prev, v) });
  }
  await s.act({ type: 'replay', decisionId: 'convert:EUR', tamper: true });
  v = buildView('t', s);
  script.push({ step: 'tamper', beats: afterTamper(v) }, { step: 'outro', beats: outro(v) });
  return script;
}

const text = (script: Awaited<ReturnType<typeof tour>>, step: string) => script.find((x) => x.step === step)!.beats.map((b) => b.text).join(' ');

describe('guided demo narration', () => {
  it('says company names without legal suffixes', () => {
    expect(spoken('Rheinfracht Logistik GmbH')).toBe('Rheinfracht Logistik');
    expect(spoken('Calder & Finch LLP')).toBe('Calder & Finch');
    expect(spoken('Job 117 has no quoted budget, and Klimatech Anlagen GmbH is a new payee')).toBe('Job 117 has no quoted budget, and Klimatech Anlagen is a new payee');
  });

  it('hands over to a presenter only by name, and only a speakable one', async () => {
    const script = await tour();
    expect(text(script, 'outro')).toMatch(/Thanks for watching\.$/);
    expect(presenterName('Ben')).toBe('Ben');
    expect(presenterName('Ben & Kieron')).toBe('Ben & Kieron');
    expect(presenterName('<script>x</script>')).toBe('scriptxscript');
    expect(presenterName('  ')).toBeNull();
  });

  it('has a short cut that drops only the longer introduction', async () => {
    const s = await Session.create('demo', { claude: false });
    const beats = intro(buildView('t', s));
    expect(beats.filter((b) => b.extra)).toHaveLength(3);
    expect(beats.filter((b) => !b.extra)[0]!.text).toMatch(/^So, let's go through a Monday morning/);
  });

  it('says money the way a person would', () => {
    expect(say(5770.99)).toBe('5,771 dollars');
    expect(say(3412.85, 'EUR', true)).toBe('3,412.85 euros');
    expect(say(1600, 'GBP', true)).toBe('1,600 pounds');
  });

  it('reads every number from the run, at every step', async () => {
    const script = await tour();
    for (const { step, beats } of script) {
      expect(beats.length, step).toBeGreaterThan(0);
      for (const b of beats) expect(b.text, step).not.toMatch(/undefined|NaN|null|\$\{/);
    }
    expect(text(script, 'intro')).toContain('5,771 dollars spare');
    expect(text(script, 'intro')).toContain('25 of the 26');
    expect(text(script, 'intro')).toContain('releases a 24,000-dollar milestone on the same job');
    expect(text(script, 'intro')).toContain('7,500-euro payment on Job 117');
    const late = text(script, 'after:delay_email');
    expect(late).toContain('relying on that 9,000 dollars');
    expect(late).toContain('3,229 dollars short');
    expect(late).toContain('180 dollars');
    expect(late).toContain('covers the gap for 200 dollars');
    expect(late).toContain('limit has dropped to 2,000 dollars');
    expect(text(script, 'before:approve')).toContain('3,412.85 euros');
    expect(text(script, 'after:customer_pays')).toContain('8,591 dollars spare');
    expect(text(script, 'after:split_reply')).toContain('1,600 pounds');
    expect(text(script, 'after:chase')).toContain('because the account was closed');
    expect(text(script, 'after:replay')).toContain('exactly the same decision');
    expect(text(script, 'tamper')).toContain('gets caught');
  });
});
