import type { DecisionView, RunView } from './view.js';

// The guided demo's voice-over. Every number is read from the run as it stands, never typed in,
// so the narrator can't say something the page doesn't show. Pure: same view in, same words out.

export type Focus = 'hero' | 'brief' | 'changes' | 'decisions' | 'payments' | 'outbox' | 'recon' | 'signals' | 'steps' | 'proof';

export interface Beat {
  focus: Focus;
  text: string;
}

export type TourStep = 'delay_email' | 'run_0900' | 'approve' | 'customer_pays' | 'split_reply' | 'chase' | 'replay';
export const TOUR_STEPS: TourStep[] = ['delay_email', 'run_0900', 'approve', 'customer_pays', 'split_reply', 'chase', 'replay'];

const NAME: Record<string, [string, string]> = { USD: ['dollar', 'dollars'], EUR: ['euro', 'euros'], GBP: ['pound', 'pounds'] };

/** Money as it should be spoken: "5,771 dollars", or exact to the cent when `exact`. */
export function say(n: number, ccy = 'USD', exact = false): string {
  const v = exact ? Math.abs(n) : Math.round(Math.abs(n));
  const num = v.toLocaleString('en-GB', { minimumFractionDigits: exact && v % 1 ? 2 : 0, maximumFractionDigits: exact ? 2 : 0 });
  const [one, many] = NAME[ccy] ?? [ccy, ccy];
  return `${num} ${v === 1 ? one : many}`;
}

/** Money used as an adjective: "a 24,000-dollar milestone". */
export function sayAdj(n: number, ccy = 'USD'): string {
  const v = Math.round(Math.abs(n)).toLocaleString('en-GB');
  return `${v}-${(NAME[ccy] ?? [ccy])[0]}`;
}

const num = (s: string | undefined) => (s ? Number(s.replace(/,/g, '')) : NaN);
const all = (v: RunView): DecisionView[] => [...v.decisions, ...v.doneToday];
const byId = (v: RunView, id: string) => all(v).find((d) => d.id === id);
const byKind = (v: RunView, kind: DecisionView['kind']) => all(v).find((d) => d.kind === kind);

export function intro(v: RunView): Beat[] {
  const s = v.summary;
  const beats: Beat[] = [
    {
      focus: 'hero',
      text:
        "This is Reckon, a treasury agent for UK project businesses, built on Airwallex. Here's one Monday morning. " +
        (v.mode === 'demo' ? 'Airwallex is simulated in this demo; live mode runs the same steps against the real sandbox.' : 'This run calls the real Airwallex sandbox.'),
    },
  ];
  beats.push({
    focus: 'hero',
    text:
      s.gapUSD <= 0
        ? `Overnight it read the finance team's own spreadsheet and the account balances. Right now the week is covered, with ${say(-s.gapUSD)} to spare above the ${sayAdj(s.reserveFloorUSD)} reserve floor.`
        : `Overnight it read the finance team's own spreadsheet and the account balances. The week is ${say(s.gapUSD)} short.`,
  });
  if (v.recon.total) {
    const dup = v.recon.notable.some((r) => r.kind === 'instalment' && /not a duplicate/i.test(r.explanation));
    const person = v.recon.person;
    beats.push({
      focus: 'recon',
      text:
        `It also matched ${v.recon.auto} of ${v.recon.total} overnight bank lines on its own` +
        (dup ? ", including one that looks like a duplicate but is really the next instalment." : '.') +
        (person ? ` The ${person === 1 ? 'one' : person} it couldn't place ${person === 1 ? 'is' : 'are'} left for a person rather than guessed.` : ''),
    });
  }
  const first = v.decisions.find((d) => d.kind === 'pay' && /ranked 1 because paying it releases/.test(d.reason));
  const releases = first?.reason.match(/releases USD ([\d,]+) on Job (\w+)/);
  if (first && releases) {
    beats.push({
      focus: 'decisions',
      text: `Here's the plan. Look at the order. The ${sayAdj(first.amount, first.currency)} bill on Job ${first.job} goes first. Nobody tagged it urgent: paying it releases a ${sayAdj(num(releases[1]))} milestone ${releases[2] === first.job ? 'on the same job' : `on Job ${releases[2]}`}.`,
    });
  }
  const hold = v.needsYou.find((d) => d.kind === 'hold');
  if (hold) {
    const why = hold.reason.replace(/^Held for the MD:\s*/, '').replace(/\.$/, '').replace(/; /g, ', and ');
    beats.push({
      focus: 'brief',
      text: `Only one thing needs the managing director: a ${sayAdj(hold.amount, hold.currency)} payment on Job ${hold.job}. ${why}. Reckon won't pay spend with no budget, however much cash there is.`,
    });
  }
  return beats;
}

export function before(step: TourStep, v: RunView): Beat[] {
  switch (step) {
    case 'delay_email':
      return [{ focus: 'steps', text: 'Now an email arrives. A customer says their milestone payment will be a week late.' }];
    case 'run_0900':
      return [{ focus: 'steps', text: "It's nine o'clock, the payment cut-off. Reckon does everything policy lets it do on its own." }];
    case 'approve': {
      const c = v.needsYou.find((d) => d.kind === 'convert');
      return [{ focus: 'brief', text: c ? `The MD approves the conversion, for exactly ${say(c.amount, c.currency, true)}.` : 'The MD approves.' }];
    }
    case 'customer_pays':
      return [{ focus: 'payments', text: 'Next, the customer takes the early-pay offer and pays the Airwallex payment link.' }];
    case 'split_reply':
      return [{ focus: 'steps', text: 'The supplier replies to the split request, and agrees.' }];
    case 'chase':
      return [{ focus: 'steps', text: "Now the awkward one. A supplier emails: last week's payment never arrived." }];
    case 'replay':
      return [{ focus: 'proof', text: 'Last, proof. Every decision is stored with the inputs it was made from.' }];
  }
}

export function after(step: TourStep, prev: RunView, v: RunView): Beat[] {
  const s = v.summary;
  const beats: Beat[] = [];
  switch (step) {
    case 'delay_email': {
      beats.push({
        focus: 'signals',
        text: v.claude
          ? 'Claude read that email into one typed fact, checked against the book. Code decides what it means.'
          : 'In live runs Claude reads that email into one typed fact. Here it comes from a fixture. Either way, code decides what it means.',
      });
      const lost = prev.summary.expectedReceiptsUSD - s.expectedReceiptsUSD;
      beats.push({
        focus: 'hero',
        text:
          (lost > 0 ? `Reckon was counting on that ${say(lost)}. ` : '') +
          (s.gapUSD > 0 ? `Now the week is ${say(s.gapUSD)} short.` : `The week is still covered.`),
      });
      const link = byKind(v, 'early_pay_link');
      const offer = link?.reason.match(/([\d.]+)% \(USD ([\d,]+)\) to pay USD ([\d,]+) today/);
      const levers: string[] = [];
      if (offer) levers.push(`it offers a reliable customer ${say(num(offer[2]))}, that's ${offer[1]} percent, to pay ${say(num(offer[3]))} today by Airwallex payment link`);
      if (byKind(v, 'ask_split')) levers.push('asks a supplier who has agreed before to split their bill');
      if (byKind(v, 'defer')) levers.push('defers a software renewal that costs nothing to delay');
      if (levers.length && s.gapUSD > 0) {
        beats.push({
          focus: 'decisions',
          text:
            `Most cash tools would just decide who waits. Reckon prices every way to close the gap: ${listJoin(levers)}.` +
            (s.gapAfterLeversUSD <= 0 ? ` Together they close it for ${say(s.leversCostUSD)}.` : ''),
        });
      }
      const was = byId(prev, 'convert:EUR');
      const now = byId(v, 'convert:EUR');
      const limit = now?.reason.match(/Autonomous limit is USD ([\d,]+)/);
      if (was?.execution === 'auto' && now?.execution === 'approval' && limit) {
        beats.push({
          focus: 'brief',
          text: `And notice the euro conversion. At breakfast Reckon could do it alone. Now forecast confidence is ${s.forecastConfidence}, so its own limit drops to ${say(num(limit[1]))}, and the ${sayAdj(now.amountUSD)} conversion goes to the MD.`,
        });
      }
      return beats;
    }
    case 'run_0900': {
      const kinds = new Set((v.last?.executed ?? []).map((id) => id.split(':')[0]));
      const did: string[] = [];
      if (kinds.has('pay')) did.push('made the payment it could');
      if (kinds.has('ask_split')) did.push('sent the split request');
      if (kinds.has('early_pay_link')) did.push('sent the early-pay link');
      if (kinds.has('defer')) did.push('deferred the renewal');
      const n = v.last?.executed.length ?? 0;
      beats.push({ focus: 'payments', text: `It carried out ${n} decision${n === 1 ? '' : 's'} on its own: it ${listJoin(did)}.` });
      if (v.outbox.length) {
        beats.push({
          focus: 'outbox',
          text: v.claude
            ? 'Claude wrote those emails, and every number and link was checked before sending.'
            : 'In live runs Claude writes those emails, and every number and link is checked before sending.',
        });
      }
      return beats;
    }
    case 'approve': {
      const paid = (v.last?.executed ?? []).filter((id) => id.startsWith('pay:')).map((id) => id.slice(4));
      const who = v.payments.filter((p) => paid.includes(p.payableId)).map((p) => p.supplier);
      beats.push({
        focus: 'payments',
        text:
          'That approval is tied to those exact terms. If any number had changed, it would have come back to the MD. ' +
          `Reckon bought the euros${who.length ? ` and paid ${listJoin(who)} straight away` : ''}.`,
      });
      return beats;
    }
    case 'customer_pays': {
      beats.push({
        focus: 'hero',
        text: s.gapUSD <= 0 ? `The cash lands, Reckon replans by itself, and the week is covered again, with ${say(-s.gapUSD)} to spare.` : `The cash lands and Reckon replans by itself. The week is ${say(s.gapUSD)} short.`,
      });
      const paid = (v.last?.executed ?? []).filter((id) => id.startsWith('pay:')).map((id) => id.slice(4));
      const who = v.payments.filter((p) => paid.includes(p.payableId));
      if (who.length) beats.push({ focus: 'payments', text: `It also pays what it was holding back until cash arrived: ${listJoin(who.map((p) => `${p.supplier}, ${say(p.amount, p.currency)}`))}.` });
      return beats;
    }
    case 'split_reply': {
      const half = v.payments.filter((p) => (v.last?.executed ?? []).includes(`pay:${p.payableId}`));
      beats.push({
        focus: 'payments',
        text: `Reckon converts only the pounds it needs and pays the first half${half.length ? `: ${listJoin(half.map((p) => `${say(p.amount, p.currency)} to ${p.supplier}`))}` : ''}. The rest is due in two weeks.`,
      });
      return beats;
    }
    case 'chase': {
      const inc = v.incident;
      if (inc && inc.outcome === 'replaced' && inc.original) {
        const failure = inc.original.failureType ? inc.original.failureType.replace(/_/g, ' ').toLowerCase() : 'failed';
        beats.push({
          focus: 'payments',
          text: `Before paying anything, Reckon looks the transfer up on Airwallex. It came back: ${failure}. So Reckon sends exactly one replacement, for ${say(inc.original.amount, inc.original.currency)}.`,
        });
        beats.push({
          focus: 'payments',
          text: 'Then the supplier chases again. This time Reckon finds the replacement already on its way, and pays nothing. A payment can be retried, but never made twice.',
        });
      } else if (v.last) {
        beats.push({ focus: 'payments', text: v.last.headline });
      }
      return beats;
    }
    case 'replay': {
      const r = v.replays[0];
      beats.push({
        focus: 'proof',
        text: r?.ok
          ? 'Replaying the euro conversion from its stored inputs gives the identical decision, with the same hash.'
          : 'Replaying the euro conversion from its stored inputs does not match.',
      });
      return beats;
    }
  }
}

export function afterTamper(v: RunView): Beat[] {
  const r = v.replays[0];
  return [
    {
      focus: 'proof',
      text: r?.tampered && !r.ok
        ? "Now a copy where someone has quietly raised the FX limit. It fails the hash check. The record can't be edited after the fact."
        : 'The tampered copy was checked.',
    },
  ];
}

export function outro(v: RunView): Beat[] {
  return [
    {
      focus: 'hero',
      text:
        'So that is Reckon. It ranks payments by what they unlock, holds spend with no budget, prices every way to close a gap, and can prove every decision afterwards. ' +
        'The money logic is code. The AI reads emails and drafts messages, and nothing more. ' +
        'The source is on GitHub.',
    },
  ];
}

function listJoin(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
