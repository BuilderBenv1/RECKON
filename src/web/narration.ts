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
      text: "Hi, I'm an AI voice, and I'll be taking you through Reckon. Reckon's an AI agent that looks after a company's cash, and it was built for the Airwallex Agentic Banking Hackathon.",
    },
    {
      focus: 'hero',
      extra: true,
      text:
        "It's aimed at UK businesses that work on projects, so fit-out firms, installers, builders. Their customers pay in stages, their suppliers want paying, sometimes in euros or dollars, and there are weeks when the money doesn't quite stretch. " +
        'Usually someone in the office sits down with a spreadsheet every morning and works out who gets paid and who has to wait.',
    },
    {
      focus: 'hero',
      extra: true,
      text:
        'Reckon does that every morning. It reads the spreadsheet the finance team already uses, checks the bank, pays what it safely can through Airwallex, and only goes to the managing director when a person really needs to decide. ' +
        'The AI never decides any amounts. That is all done by ordinary code, with fixed rules. The AI just reads the emails and writes the messages.',
    },
    {
      focus: 'hero',
      text:
        "So, let's go through a Monday morning. " +
        (v.mode === 'demo' ? 'Airwallex is simulated in this demo, but the live version runs the same steps for real.' : "This one's running against the real Airwallex sandbox."),
    },
  ];
  beats.push({
    focus: 'hero',
    text:
      s.gapUSD <= 0
        ? `Overnight it's been through the spreadsheet and the bank balance, and this week is covered. There's ${say(-s.gapUSD)} spare on top of the ${sayAdj(s.reserveFloorUSD)} reserve.`
        : `Overnight it's been through the spreadsheet and the bank balance, and this week is ${say(s.gapUSD)} short.`,
  });
  if (v.recon.total) {
    const dup = v.recon.notable.some((r) => r.kind === 'instalment' && /not a duplicate/i.test(r.explanation));
    const person = v.recon.person;
    beats.push({
      focus: 'recon',
      text:
        `It's matched ${v.recon.auto} of the ${v.recon.total} bank lines from overnight on its own.` +
        (dup ? ' One of them looked like a duplicate, but it was actually the next instalment of a payment plan.' : '') +
        (person ? (person === 1 ? " The one it couldn't match has been left for someone to check." : ` The ${person} it couldn't match have been left for someone to check.`) : ''),
    });
  }
  const first = v.decisions.find((d) => d.kind === 'pay' && /ranked 1 because paying it releases/.test(d.reason));
  const releases = first?.reason.match(/releases USD ([\d,]+) on Job (\w+)/);
  if (first && releases) {
    beats.push({
      focus: 'decisions',
      text: `Have a look at the order it's chosen. The ${sayAdj(first.amount, first.currency)} bill on Job ${first.job} is at the top, because paying it releases a ${sayAdj(num(releases[1]))} milestone ${releases[2] === first.job ? 'on the same job' : `on Job ${releases[2]}`}. Nobody had to flag it.`,
    });
  }
  const hold = v.needsYou.find((d) => d.kind === 'hold');
  if (hold) {
    const why = spoken(hold.reason.replace(/^Held for the MD:\s*/, '').replace(/\.$/, '').replace(/; /g, ', and '));
    beats.push({
      focus: 'brief',
      text: `${v.needsYou.length === 1 ? "There's one thing waiting for the managing director," : 'One of the things waiting for the managing director is'} a ${sayAdj(hold.amount, hold.currency)} payment on Job ${hold.job}. ${why}, so Reckon won't pay it, however much cash is in the bank.`,
    });
  }
  return beats;
}

export function before(step: TourStep, v: RunView): Beat[] {
  switch (step) {
    case 'delay_email':
      return [{ focus: 'steps', text: "Now an email comes in from a customer. Their milestone payment's going to be a week late." }];
    case 'run_0900':
      return [{ focus: 'steps', text: "It's nine o'clock, which is the cut-off for payments, so Reckon gets on with everything it's allowed to do by itself." }];
    case 'approve': {
      const c = v.needsYou.find((d) => d.kind === 'convert');
      return [{ focus: 'brief', text: c ? `The managing director approves the conversion, for exactly ${say(c.amount, c.currency, true)}.` : 'The managing director approves it.' }];
    }
    case 'customer_pays':
      return [{ focus: 'payments', text: 'Now the customer takes up the offer and pays the link.' }];
    case 'split_reply':
      return [{ focus: 'steps', text: 'The supplier replies, and says yes to splitting the bill.' }];
    case 'chase':
      return [{ focus: 'steps', text: "Next, a supplier emails to say they never got last week's payment." }];
    case 'replay':
      return [{ focus: 'proof', text: 'Finally, every decision Reckon makes is saved, along with the information it was based on.' }];
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
          ? 'Claude has read that email and pulled out the one fact that matters, and that gets checked against the books before anything happens. What it means for the money is worked out in code.'
          : 'In the live version, Claude reads that email and pulls out the one fact that matters. In this demo that comes from a test file. Either way, what it means for the money is worked out in code.',
      });
      const lost = prev.summary.expectedReceiptsUSD - s.expectedReceiptsUSD;
      beats.push({
        focus: 'hero',
        text:
          (lost > 0 ? `Reckon was relying on that ${say(lost)}, so ` : '') +
          (s.gapUSD > 0 ? `the week's now ${say(s.gapUSD)} short.` : `the week is still covered.`).replace(/^t/, lost > 0 ? 't' : 'T'),
      });
      const link = byKind(v, 'early_pay_link');
      const offer = link?.reason.match(/([\d.]+)% \(USD ([\d,]+)\) to pay USD ([\d,]+) today/);
      const levers: string[] = [];
      if (offer) levers.push(`It offers a customer who nearly always pays on time ${say(num(offer[2]))} off, that's ${offer[1]} percent, if they pay their ${say(num(offer[3]))} today with an Airwallex payment link.`);
      if (byKind(v, 'ask_split')) levers.push("It asks a supplier who's agreed to it before if they'll take their bill in two halves.");
      if (byKind(v, 'defer')) levers.push(`${levers.length ? 'And it puts' : 'It puts'} off a software renewal, which doesn't cost anything to delay.`);
      if (levers.length && s.gapUSD > 0) {
        beats.push({
          focus: 'decisions',
          text:
            `A lot of tools would just decide who doesn't get paid. Reckon looks at what it can do about it, and what each option costs. ${levers.join(' ')}` +
            (s.gapAfterLeversUSD <= 0 ? ` Between them, that covers the gap for ${say(s.leversCostUSD)}.` : ''),
        });
      }
      const was = byId(prev, 'convert:EUR');
      const now = byId(v, 'convert:EUR');
      const limit = now?.reason.match(/Autonomous limit is USD ([\d,]+)/);
      if (was?.execution === 'auto' && now?.execution === 'approval' && limit) {
        const dropped = prev.summary.forecastConfidence !== s.forecastConfidence;
        beats.push({
          focus: 'brief',
          text: `Watch the euro conversion as well. First thing this morning, Reckon could have done that by itself. ${dropped ? 'The forecast is less certain now, so its own limit has dropped to' : `Forecast confidence is ${s.forecastConfidence}, so its own limit is`} ${say(num(limit[1]))}, which means the ${sayAdj(now.amountUSD)} conversion goes to the managing director.`,
        });
      }
      return beats;
    }
    case 'run_0900': {
      const kinds = new Set((v.last?.executed ?? []).map((id) => id.split(':')[0]));
      const did: string[] = [];
      if (kinds.has('pay')) did.push('made the payment it could');
      if (kinds.has('ask_split')) did.push('sent the request to split the bill');
      if (kinds.has('early_pay_link')) did.push('sent the payment link');
      if (kinds.has('defer')) did.push('put off the renewal');
      const n = v.last?.executed.length ?? 0;
      beats.push({ focus: 'payments', text: `That's ${n} thing${n === 1 ? '' : 's'} done without anyone touching it. It ${listJoin(did)}.` });
      return beats;
    }
    case 'approve': {
      const paid = (v.last?.executed ?? []).filter((id) => id.startsWith('pay:')).map((id) => id.slice(4));
      const who = v.payments.filter((p) => paid.includes(p.payableId)).map((p) => spoken(p.supplier));
      beats.push({
        focus: 'payments',
        text:
          'That approval only covers those exact figures. If anything changed, it would come back for approval again. ' +
          `Reckon buys the euros${who.length ? ` and pays ${listJoin(who)} straight away` : ''}.`,
      });
      return beats;
    }
    case 'customer_pays': {
      beats.push({
        focus: 'hero',
        text: s.gapUSD <= 0 ? `The money comes in, Reckon re-plans on its own, and the week is covered again, with ${say(-s.gapUSD)} spare.` : `The money comes in and Reckon re-plans on its own. The week is ${say(s.gapUSD)} short.`,
      });
      const paid = (v.last?.executed ?? []).filter((id) => id.startsWith('pay:')).map((id) => id.slice(4));
      const who = v.payments.filter((p) => paid.includes(p.payableId));
      if (who.length) beats.push({ focus: 'payments', text: `It also pays ${listJoin(who.map((p) => `${spoken(p.supplier)}, ${say(p.amount, p.currency)}`))}, which it had been holding back until the money arrived.` });
      return beats;
    }
    case 'split_reply': {
      const half = v.payments.filter((p) => (v.last?.executed ?? []).includes(`pay:${p.payableId}`));
      beats.push({
        focus: 'payments',
        text: `So Reckon converts just the pounds it needs and pays the first half${half.length ? `, ${listJoin(half.map((p) => `${say(p.amount, p.currency)} to ${spoken(p.supplier)}`))}` : ''}. The other half is due in two weeks.`,
      });
      return beats;
    }
    case 'chase': {
      const inc = v.incident;
      if (inc && inc.outcome === 'replaced' && inc.original) {
        const ft = inc.original.failureType ?? '';
        const why = ft === 'ACCOUNT_CLOSED' ? 'because the account was closed' : ft ? `with the reason ${ft.replace(/_/g, ' ').toLowerCase()}` : 'unpaid';
        beats.push({
          focus: 'payments',
          text: `Before paying anything, Reckon checks that payment on Airwallex. It was returned, ${why}. So it sends one replacement, for ${say(inc.original.amount, inc.original.currency)}.`,
        });
        beats.push({
          focus: 'payments',
          text: "Then the supplier chases again. This time Reckon sees the replacement is already on its way, so it doesn't pay anything. It'll retry a failed payment, but it won't ever pay the same bill twice.",
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
          ? 'If you replay the euro conversion from that saved information, you get exactly the same decision, down to the same digital fingerprint.'
          : "Replaying the euro conversion from that saved information doesn't match.",
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
        ? "And here's a copy where someone has quietly raised the currency limit. It doesn't match the fingerprint, so it gets caught. The record can't be changed after the event."
        : 'The altered copy was checked.',
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
        "So that's Reckon. It pays what matters first, holds back anything without a budget, finds the cheapest way to cover a shortfall, and can show exactly why it made every decision. " +
        (name ? `Thanks for watching. I'll hand you over to ${name}.` : 'Thanks for watching.'),
    },
  ];
}

function listJoin(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
