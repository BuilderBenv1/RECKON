import { mdBrief } from '../agent/messages.js';
import { defaultPolicy, seedBalances, seedBook, seedRates } from '../domain/seed.js';
import type { EmailSignal, Policy } from '../domain/types.js';
import { diffPlans } from '../policy/diff.js';
import { round2 } from '../policy/money.js';
import { plan, type Decision, type Plan } from '../policy/plan.js';
import { initialState, type CashState } from '../policy/state.js';

// Reckon's planner as tools an agent can call. Every tool here is read-only and pure: it builds a
// state from the demo business's books plus the caller's "what if", runs plan(state, policy), and
// reports the answer. Nothing in this file can move money, call Airwallex, call a model or touch a
// run. Money still moves only through Reckon's own ledger, after any approval the policy requires.

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: false };
}

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
  }
}

/** A tool input the caller got wrong. Reported to the agent as a tool error it can correct. */
export class ToolInputError extends Error {}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const DATA_NOTE = 'Demo business with synthetic data. Read-only: this tool cannot move money.';

const scenarioProps = {
  late_receipts: {
    type: 'array',
    description: 'Customer invoices now expected later than the books say.',
    items: {
      type: 'object',
      properties: {
        receivable_id: { type: 'string', description: 'Invoice id from list_bills_and_invoices, e.g. REC-109-M3.' },
        new_expected_day: { type: 'integer', minimum: 0, maximum: 365, description: 'Days from today the cash is now expected.' },
      },
      required: ['receivable_id', 'new_expected_day'],
      additionalProperties: false,
    },
  },
  split_replies: {
    type: 'array',
    description: "Suppliers' answers to a request to pay a bill in two parts.",
    items: {
      type: 'object',
      properties: {
        payable_id: { type: 'string', description: 'Bill id from list_bills_and_invoices, e.g. PAY-121-COMP.' },
        accepted: { type: 'boolean' },
      },
      required: ['payable_id', 'accepted'],
      additionalProperties: false,
    },
  },
} as const;

// Kept to plain properties: some clients reject anyOf/oneOf at the top of a tool's input schema.
// what_if's "at least one change" rule is enforced in code instead.
const scenarioSchema = { type: 'object', properties: scenarioProps, additionalProperties: false };

export const TOOLS: ToolDef[] = [
  {
    name: 'list_bills_and_invoices',
    title: 'List bills and invoices',
    description:
      "The demo business's books as Reckon reads them: cash by currency, bills due, customer invoices owed, and the limits Reckon works within. " +
      'Use it to find the ids the other tools take. ' + DATA_NOTE,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: 'cash_position',
    title: 'Can we cover this week?',
    description:
      "Answers 'can we cover the bills due in the next few days without going below the reserve floor?'. Returns cash, what is due, the gap if there is one, " +
      'what it would cost to close it, and how many decisions need a person. Optionally apply a what-if first. ' + DATA_NOTE,
    inputSchema: scenarioSchema,
    annotations: READ_ONLY,
  },
  {
    name: 'get_plan',
    title: "Reckon's plan",
    description:
      "Reckon's full plan: every bill ranked by what paying it unlocks, and each decision (pay, hold, defer, ask to split, early-payment link, convert) with the rule and reason behind it, " +
      'and whether Reckon may do it alone or a person must approve. Optionally apply a what-if first. ' + DATA_NOTE,
    inputSchema: scenarioSchema,
    annotations: READ_ONLY,
  },
  {
    name: 'what_if',
    title: 'What if something changes?',
    description:
      'Replans after a change, such as a customer paying late or a supplier agreeing to split a bill, and returns the position before and after and only the decisions that moved. Needs at least one change. ' +
      DATA_NOTE,
    inputSchema: scenarioSchema,
    annotations: READ_ONLY,
  },
];

interface Scenario {
  state: CashState;
  applied: string[];
}

const baseState = (): CashState => initialState(structuredClone(seedBook), { ...seedBalances }, { ...seedRates });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(obj: Record<string, unknown>, allowed: string[], where: string) {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ToolInputError(`${where}: unknown field ${extra.map((k) => `"${k}"`).join(', ')}. Allowed: ${allowed.join(', ') || 'none'}.`);
}

function list(value: unknown, name: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isRecord)) throw new ToolInputError(`${name} must be a list of objects.`);
  if (value.length > 20) throw new ToolInputError(`${name} takes at most 20 entries.`);
  return value;
}

/** Turns the caller's what-if into the same typed signals an email would produce. */
function buildScenario(args: Record<string, unknown>): Scenario {
  onlyKeys(args, Object.keys(scenarioProps), 'Arguments');
  const state = baseState();
  const applied: string[] = [];
  const signals: EmailSignal[] = [];

  for (const item of list(args.late_receipts, 'late_receipts')) {
    onlyKeys(item, ['receivable_id', 'new_expected_day'], 'late_receipts');
    const r = state.book.receivables.find((x) => x.id === item.receivable_id);
    if (!r) throw new ToolInputError(`Unknown receivable_id ${JSON.stringify(item.receivable_id)}. Known: ${state.book.receivables.map((x) => x.id).join(', ')}.`);
    const day = item.new_expected_day;
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 365) throw new ToolInputError('new_expected_day must be a whole number of days from 0 to 365.');
    signals.push({ kind: 'receipt_delayed', receivableId: r.id, newExpectedDay: day, evidence: 'what-if from an agent' });
    applied.push(`${r.customer}'s ${r.currency} ${r.amount.toLocaleString('en-GB')} (${r.id}) now expected in ${day} days, not ${r.expectedDay}`);
  }

  for (const item of list(args.split_replies, 'split_replies')) {
    onlyKeys(item, ['payable_id', 'accepted'], 'split_replies');
    const p = state.book.payables.find((x) => x.id === item.payable_id);
    if (!p) throw new ToolInputError(`Unknown payable_id ${JSON.stringify(item.payable_id)}. Known: ${state.book.payables.map((x) => x.id).join(', ')}.`);
    if (typeof item.accepted !== 'boolean') throw new ToolInputError('accepted must be true or false.');
    if (!p.acceptsSplit) throw new ToolInputError(`${p.supplier} (${p.id}) has not accepted split payments before, so Reckon would not ask them.`);
    signals.push({ kind: item.accepted ? 'split_accepted' : 'split_declined', payableId: p.id, evidence: 'what-if from an agent' });
    applied.push(`${p.supplier} ${item.accepted ? 'agrees' : 'declines'} to split ${p.id}`);
  }

  state.signals.push(...signals);
  return { state, applied };
}

function position(p: Plan, policy: Policy) {
  const s = p.summary;
  const needsApproval = p.decisions.filter((d) => d.execution === 'approval');
  return {
    horizonDays: policy.horizonDays,
    cashUSD: s.cashUSD,
    reserveFloorUSD: s.reserveFloorUSD,
    spendableUSD: round2(s.cashUSD - s.reserveFloorUSD),
    dueUSD: s.dueInHorizonUSD,
    heldForApprovalUSD: s.heldUSD,
    trustedReceiptsUSD: s.expectedReceiptsUSD,
    covered: s.gapUSD <= 0,
    gapUSD: Math.max(0, s.gapUSD),
    costToCloseUSD: s.leversCostUSD,
    stillShortUSD: Math.max(0, s.gapAfterLeversUSD),
    forecastConfidence: s.forecastConfidence,
    approvalsNeeded: needsApproval.length,
  };
}

const decisionOut = (d: Decision) => ({
  id: d.id,
  kind: d.kind,
  target: d.target,
  amount: d.amount,
  currency: d.currency,
  amountUSD: d.amountUSD,
  who: d.execution === 'approval' ? 'needs_approval' : 'reckon_alone',
  status: d.status,
  dependsOn: d.dependsOn,
  rule: d.rule,
  reason: d.reason,
});

function args(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (!isRecord(input)) throw new ToolInputError('Arguments must be an object.');
  return input;
}

/** Runs one tool. Pure: the same arguments always give the same answer. Throws ToolInputError on bad input. */
export function callTool(name: string, input: unknown, policy: Policy = defaultPolicy): Record<string, unknown> {
  const a = args(input);
  switch (name) {
    case 'list_bills_and_invoices': {
      onlyKeys(a, [], 'Arguments');
      const book = seedBook;
      return {
        note: DATA_NOTE,
        asOf: book.asOf,
        balances: { ...seedBalances },
        ratesToUSD: { ...seedRates },
        limits: {
          reserveFloorUSD: policy.reserveFloorUSD,
          horizonDays: policy.horizonDays,
          paymentAloneUpToUSD: policy.autonomousPaymentLimitUSD,
          conversionAloneUpToUSD: policy.autonomousFxLimitUSD,
          earlyPayDiscount: policy.earlyPayDiscount,
          discountAloneUpToUSD: policy.autonomousDiscountLimitUSD,
        },
        bills: book.payables.map((p) => ({
          id: p.id, supplier: p.supplier, description: p.description, amount: p.amount, currency: p.currency,
          dueInDays: p.dueDay, job: p.job, acceptsSplit: p.acceptsSplit, newPayee: p.newPayee, ...(p.note ? { note: p.note } : {}),
        })),
        invoices: book.receivables.map((r) => ({
          id: r.id, customer: r.customer, milestone: r.milestone, amount: r.amount, currency: r.currency,
          status: r.status, expectedInDays: r.expectedDay, paysOnTimeRate: r.onTimeRate, earlyPayEligible: r.earlyPayEligible, job: r.job,
        })),
      };
    }
    case 'cash_position': {
      const { state, applied } = buildScenario(a);
      const p = plan(state, policy);
      return {
        note: DATA_NOTE,
        whatIf: applied,
        ...position(p, policy),
        summary: mdBrief(p, p.decisions.filter((d) => d.execution === 'approval')),
      };
    }
    case 'get_plan': {
      const { state, applied } = buildScenario(a);
      const p = plan(state, policy);
      const suppliers = new Map(state.book.payables.map((x) => [x.id, x.supplier]));
      return {
        note: DATA_NOTE,
        whatIf: applied,
        policyVersion: p.policyVersion,
        position: position(p, policy),
        ranking: p.ranking.map((r, i) => ({
          rank: i + 1, billId: r.payableId, supplier: suppliers.get(r.payableId.replace(/-[AB]$/, '')) ?? null, unlocksUSD: r.unlockUSD, weeklyDelayCostUSD: r.delayCostUSD,
        })),
        decisions: p.decisions.map(decisionOut),
        needsApproval: p.decisions.filter((d) => d.execution === 'approval').map((d) => d.id),
      };
    }
    case 'what_if': {
      const { state, applied } = buildScenario(a);
      if (!applied.length) throw new ToolInputError('Give at least one change in late_receipts or split_replies.');
      const before = plan(baseState(), policy);
      const after = plan(state, policy);
      return {
        note: DATA_NOTE,
        whatIf: applied,
        before: position(before, policy),
        after: position(after, policy),
        changes: diffPlans(before, after).map((c) => ({
          id: c.id,
          change: c.change,
          ...(c.fields.length ? { fields: c.fields } : {}),
          reason: (c.after ?? c.before)!.reason,
        })),
      };
    }
    default:
      throw new UnknownToolError(name);
  }
}
