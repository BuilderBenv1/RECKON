import type { DecisionView, RunView } from './view.js';

// The guided demo's voice-over. Every number is read from the run as it stands, never typed in,
// so the narrator can't say something the page doesn't show. Pure: same view in, same words out.

export type Focus = 'hero' | 'brief' | 'changes' | 'decisions' | 'payments' | 'outbox' | 'recon' | 'signals' | 'steps' | 'proof';

export interface Beat {
  focus: Focus;
  text: string;
  /** Part of the longer spoken introduction; skipped in the short cut (?short). */
  extra?: true;
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

/** Company names as a person would say them: no GmbH, Ltd, Inc or LLP. */
export const spoken = (name: string) => name.replace(/,?\s+(GmbH|Ltd|Limited|Inc|LLP|plc)\.?(?=\b|$)/gi, '').trim();

const num = (s: string | undefined) => (s ? Number(s.replace(/,/g, '')) : NaN);
const all = (v: RunView): DecisionView[] => [...v.decisions, ...v.doneToday];
const byId = (v: RunView, id: string) => all(v).find((d) => d.id === id);
const byKind = (v: RunView, kind: DecisionView['kind']) => all(v).find((d) => d.kind === kind);

export function intro(v: RunView): Beat[] {
  const s = v.summary;
  const beats: Beat[] = [
    {
      focus: 'hero',
      extra: true,
      text: "Hi. I'm an AI narrator, and I'm going to walk you through a project called Reckon. It was built for the Airwallex Agentic Banking Hackathon, and it's an AI agent that looks after a company's cash.",
    },
    {
      focus: 'hero',
      extra: true,
      text:
        "Here's the problem it solves. Lots of UK businesses work project by project: fit-outs, installations, building work. Customers pay in stages, suppliers want paying, often in different currencies, and some weeks there isn't quite enough cash to go round. " +
        'So every morning, someone sits with a spreadsheet and decides who gets paid, and who waits.',
    },
    {
      focus: 'hero',
      extra: true,
      text:
        "Reckon does that job. Every morning it reads the finance team's own spreadsheet and the bank, works out what's due, pays what it safely can through Airwallex, and only asks the managing director about the things that really need a person. " +
        "And one rule matters more than any other. The AI never decides the money. Amounts, limits and approvals are all ordinary code. The AI reads emails and writes messages, and that's all.",
    },
    {
      focus: 'hero',
      text:
        "Let's watch Reckon run one Monday morning. " +
        (v.mode === 'demo' ? 'In this demo, Airwallex is simulated. Live mode runs exactly the same steps for real.' : 'This run is talking to the real Airwallex sandbox.'),
    },
  ];
  beats.push({
    focus: 'hero',
    text:
      s.gapUSD <= 0
        ? `Overnight, it's read the finance team's own spreadsheet and the bank balances. And right now the week's covered, with ${say(-s.gapUSD)} to spare above the ${sayAdj(s.reserveFloorUSD)} reserve.`
        : `Overnight, it's read the finance team's own spreadsheet and the bank balances, and the week is ${say(s.gapUSD)} short.`,
  });
  if (v.recon.total) {
    const dup = v.recon.notable.some((r) => r.kind === 'instalment' && /not a duplicate/i.test(r.explanation));
    const person = v.recon.person;
    beats.push({
      focus: 'recon',
      text:
        `It's also matched ${v.recon.auto} of the ${v.recon.total} overnight bank lines by itself` +
        (dup ? ', including one that looks like a duplicate, but is really the next instalment.' : '.') +
        (person ? (person === 1 ? " The one it couldn't place, it leaves for a person." : ` The ${person} it couldn't place, it leaves for a person.`) : ''),
    });
  }
  const first = v.decisions.find((d) => d.kind === 'pay' && /ranked 1 because paying it releases/.test(d.reason));
  const releases = first?.reason.match(/releases USD ([\d,]+) on Job (\w+)/);
  if (first && releases) {
    beats.push({
      focus: 'decisions',
      text: `Now look at the order of the plan. That ${sayAdj(first.amount, first.currency)} bill on Job ${first.job} goes first. Nobody marked it urgent. It's first because paying it releases a ${sayAdj(num(releases[1]))} milestone ${releases[2] === first.job ? 'on the same job' : `on Job ${releases[2]}`}.`,
    });
  }
  const hold = v.needsYou.find((d) => d.kind === 'hold');
  if (hold) {
    const why = spoken(hold.reason.replace(/^Held for the MD:\s*/, '').replace(/\.$/, '').replace(/; /g, ', and '));
    beats.push({
      focus: 'brief',
      text: `${v.needsYou.length === 1 ? "There's just one thing" : 'One thing'} for the managing director: a ${sayAdj(hold.amount, hold.currency)} payment on Job ${hold.job}. ${why}. So however much cash there is, Reckon won't pay it.`,
    });
  }
  return beats;
}

export function before(step: TourStep, v: RunView): Beat[] {
  switch (step) {
    case 'delay_email':
      return [{ focus: 'steps', text: "Right. Now an email comes in. A customer's milestone payment is going to be a week late." }];
    case 'run_0900':
      return [{ focus: 'steps', text: "Nine o'clock. That's the payment cut-off, and Reckon gets on with everything policy lets it do by itself." }];
    case 'approve': {
      const c = v.needsYou.find((d) => d.kind === 'convert');
      return [{ focus: 'brief', text: c ? `So the MD approves the conversion. Exactly ${say(c.amount, c.currency, true)}, and not a cent more.` : 'So the MD approves.' }];
    }
    case 'customer_pays':
      return [{ focus: 'payments', text: 'Now the customer takes the early-pay offer, and pays through the Airwallex link.' }];
    case 'split_reply':
      return [{ focus: 'steps', text: "The supplier agrees to split." }];
    case 'chase':
      return [{ focus: 'steps', text: "Now for the awkward one. A supplier emails to say last week's payment never arrived." }];
    case 'replay':
      return [{ focus: 'proof', text: 'Last thing: proof. Every decision is stored with the inputs it was made from.' }];
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
          ? 'Claude reads that email into one simple fact, checked against the books. Code, not the AI, decides what it means for the money.'
          : "In a live run, Claude reads that email into one simple fact. Here it's a test fixture. Either way, code, not the AI, decides what it means.",
      });
      const lost = prev.summary.expectedReceiptsUSD - s.expectedReceiptsUSD;
      beats.push({
        focus: 'hero',
        text:
          (lost > 0 ? `Reckon was counting on that ${say(lost)}. ` : '') +
          (s.gapUSD > 0 ? `${lost > 0 ? 'So now' : 'Now'} the week is ${say(s.gapUSD)} short.` : `The week is still covered.`),
      });
      const link = byKind(v, 'early_pay_link');
      const offer = link?.reason.match(/([\d.]+)% \(USD ([\d,]+)\) to pay USD ([\d,]+) today/);
      const levers: string[] = [];
      if (offer) levers.push(`It offers a reliable customer ${say(num(offer[2]))}, that's ${offer[1]} percent, to pay ${say(num(offer[3]))} today by Airwallex payment link.`);
      if (byKind(v, 'ask_split')) levers.push(`It asks a supplier who's said yes before to split their bill.`);
      if (byKind(v, 'defer')) levers.push(`${levers.length ? 'And it' : 'It'} defers a software renewal that costs nothing to delay.`);
      if (levers.length && s.gapUSD > 0) {
        beats.push({
          focus: 'decisions',
          text:
            `This is where most cash tools just pick who waits. Reckon prices every way to close the gap. ${levers.join(' ')}` +
            (s.gapAfterLeversUSD <= 0 ? ` Altogether, that closes the gap for ${say(s.leversCostUSD)}.` : ''),
        });
      }
      const was = byId(prev, 'convert:EUR');
      const now = byId(v, 'convert:EUR');
      const limit = now?.reason.match(/Autonomous limit is USD ([\d,]+)/);
      if (was?.execution === 'auto' && now?.execution === 'approval' && limit) {
        beats.push({
          focus: 'brief',
          text: `And watch the euro conversion. At breakfast, Reckon could do that on its own. But forecast confidence has ${prev.summary.forecastConfidence !== s.forecastConfidence ? 'dropped to' : 'stayed'} ${s.forecastConfidence}, so its own limit drops to ${say(num(limit[1]))}, and a ${sayAdj(now.amountUSD)} conversion now goes to the MD.`,
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
      beats.push({ focus: 'payments', text: `That's ${n} decision${n === 1 ? '' : 's'} done without anyone. It ${listJoin(did)}.` });
      return beats;
    }
    case 'approve': {
      const paid = (v.last?.executed ?? []).filter((id) => id.startsWith('pay:')).map((id) => id.slice(4));
      const who = v.payments.filter((p) => paid.includes(p.payableId)).map((p) => spoken(p.supplier));
      beats.push({
        focus: 'payments',
        text:
          "That approval is tied to those exact terms. Change any number, and it goes back to the MD. " +
          `Reckon buys the euros${who.length ? `, and pays ${listJoin(who)} straight away` : ''}.`,
      });
      return beats;
    }
    case 'customer_pays': {
      beats.push({
        focus: 'hero',
        text: s.gapUSD <= 0 ? `The cash lands, Reckon replans on its own, and the week's covered again, with ${say(-s.gapUSD)} to spare.` : `The cash lands, and Reckon replans on its own. The week is ${say(s.gapUSD)} short.`,
      });
      const paid = (v.last?.executed ?? []).filter((id) => id.startsWith('pay:')).map((id) => id.slice(4));
      const who = v.payments.filter((p) => paid.includes(p.payableId));
      if (who.length) beats.push({ focus: 'payments', text: `And it pays what it was holding back until the money arrived. That's ${listJoin(who.map((p) => `${spoken(p.supplier)}, ${say(p.amount, p.currency)}`))}.` });
      return beats;
    }
    case 'split_reply': {
      const half = v.payments.filter((p) => (v.last?.executed ?? []).includes(`pay:${p.payableId}`));
      beats.push({
        focus: 'payments',
        text: `So Reckon converts only the pounds it actually needs, and pays the first half.${half.length ? ` ${listJoin(half.map((p) => `${say(p.amount, p.currency)} to ${spoken(p.supplier)}`))}.` : ''} The rest is due in two weeks.`,
      });
      return beats;
    }
    case 'chase': {
      const inc = v.incident;
      if (inc && inc.outcome === 'replaced' && inc.original) {
        const failure = inc.original.failureType ? inc.original.failureType.replace(/_/g, ' ').toLowerCase() : 'failed';
        beats.push({
          focus: 'payments',
          text: `Before it pays a thing, Reckon looks the transfer up on Airwallex. And it came back. ${failure[0]!.toUpperCase()}${failure.slice(1)}. So it sends one replacement, for ${say(inc.original.amount, inc.original.currency)}.`,
        });
        beats.push({
          focus: 'payments',
          text: "Then the supplier chases again. This time, Reckon finds the replacement already on its way, and pays nothing. It'll retry a payment, but it will never pay twice.",
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
          ? 'Replay the euro conversion from those inputs, and you get the identical decision, with the same hash.'
          : "Replaying the euro conversion from its stored inputs doesn't match.",
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
        ? "Now here's a copy where someone's quietly raised the FX limit. It fails the hash check. Nobody can edit the record after the fact."
        : 'The tampered copy was checked.',
    },
  ];
}

/** A presenter's name as it can be spoken: letters, spaces, hyphens, apostrophes and "&" only. */
export const presenterName = (raw: string | null | undefined): string | null => {
  const n = (raw ?? '').replace(/[^\p{L} '&-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return n || null;
};

export function outro(_v: RunView, presenter?: string | null): Beat[] {
  const name = presenterName(presenter);
  return [
    {
      focus: 'hero',
      text:
        "So that's Reckon. It ranks payments by what they unlock, holds spend with no budget, prices every way to close a gap, and can prove every decision it made. " +
        'The money logic is all code, and every number the AI writes is checked. ' +
        (name ? `Thanks for watching. Now, over to ${name}.` : 'Thanks for watching.'),
    },
  ];
}

function listJoin(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
