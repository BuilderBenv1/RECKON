// Replays the whole demo story against an in-memory Airwallex, no keys needed.
//   npm run demo:offline
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { defaultPolicy, seedBalances, seedRates } from '../src/domain/seed.js';
import type { Email } from '../src/domain/types.js';
import { FakeAirwallex } from '../src/airwallex/fake.js';
import { FixtureReader } from '../src/agent/reader.js';
import { Reckon } from '../src/agent/reckon.js';
import { initialState } from '../src/policy/state.js';
import type { Plan } from '../src/policy/plan.js';
import type { DecisionChange } from '../src/policy/diff.js';
import { fmt } from '../src/policy/money.js';
import { reconcile } from '../src/recon/match.js';
import type { ReconFixture } from '../src/recon/types.js';
import { readBook, writeBook } from '../src/sheet/workbook.js';

const AS_OF = '2026-11-02';
let minute = 8 * 60 + 15;
const clock = () => {
  minute += 1;
  return `${AS_OF}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00Z`;
};
let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const h = (title: string) => console.log(`\n\x1b[1m== ${title} ==\x1b[0m`);
const showPlan = (p: Plan) => {
  const s = p.summary;
  console.log(
    `cash ${fmt(s.cashUSD, 'USD')} | floor ${fmt(s.reserveFloorUSD, 'USD')} | due ${fmt(s.dueInHorizonUSD, 'USD')} | held ${fmt(s.heldUSD, 'USD')} | ` +
      `trusted receipts ${fmt(s.expectedReceiptsUSD, 'USD')} | gap ${fmt(s.gapUSD, 'USD')} | levers cost ${fmt(s.leversCostUSD, 'USD')} | confidence ${s.forecastConfidence}`,
  );
  for (const d of p.decisions) console.log(`  ${d.id.padEnd(28)} ${d.execution.padEnd(8)} ${d.status.padEnd(7)} ${d.reason}`);
};
const showDiff = (changes: DecisionChange[]) => {
  if (!changes.length) return console.log('  (no decisions changed)');
  for (const c of changes) {
    const detail = c.fields.map((f) => `${f.field}: ${JSON.stringify(f.before)} -> ${JSON.stringify(f.after)}`).join('; ');
    // A decision that vanished because it was carried out is done, not dropped.
    const label = c.change === 'removed' && reckon.ledger.executed.has(c.id) ? 'done' : c.change;
    console.log(`  ${label.padEnd(8)} ${c.id}${detail ? `  (${detail})` : ''}`);
  }
};
const email = async (file: string) => JSON.parse(await readFile(`data/emails/${file}`, 'utf8')) as Email;

// ---- setup -------------------------------------------------------------------------
const book = await readBook('data/finance.xlsx', AS_OF);
const awx = new FakeAirwallex({ ...seedBalances, USD: seedBalances.USD + 2500 }, seedRates);
const reckon = new Reckon(initialState(book, seedBalances, seedRates), defaultPolicy, awx, new FixtureReader(), clock, newId);

// Last week's instalment 2 to the electrical subcontractor, sent and now in flight.
const prior = await reckon.pay({
  id: 'PAY-109-SUB-I2', job: '109', supplier: 'Brightline Electrical Inc', description: 'Subcontractor instalment 2',
  amount: 2500, currency: 'USD', dueDay: -6, method: 'LOCAL', newPayee: false, acceptsSplit: false, deferPenaltyUSD: 0,
});
await awx.transitionTransfer(prior.id, 'SENT');
await reckon.refreshBalances();

// ---- 1. morning read -----------------------------------------------------------------
h('1. Morning read: the finance team\'s sheet, balances and overnight receipts');
const remittance = await reckon.ingestEmail(await email('04-harbour-remittance.json'));
const recon = reconcile(JSON.parse(await readFile('data/recon.json', 'utf8')) as ReconFixture, [remittance]);
const counts = recon.reduce<Record<string, number>>((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {});
console.log(`Reconciled ${recon.length} bank lines:`, counts);
for (const r of recon.filter((x) => x.kind !== 'exact')) console.log(`  ${r.lineId} ${r.kind.padEnd(13)} ${r.needsPerson ? 'PERSON' : 'auto  '} ${r.explanation}`);

// ---- 2. first plan ---------------------------------------------------------------------
h('2. 08:30 plan (executes at the 09:00 cut-off)');
showPlan(reckon.plan().plan);

// ---- 3. new information ------------------------------------------------------------------
h('3. 08:42 email: Westfield milestone slips a week');
await reckon.ingestEmail(await email('01-westfield-delay.json'));
const v2 = reckon.plan();
showPlan(v2.plan);
console.log('What changed:');
showDiff(v2.changes);

// ---- 4. execute what policy allows; brief the MD ------------------------------------------
h('4. 09:00 execute what policy allows');
const run1 = await reckon.execute(v2.plan);
console.log('Executed:', run1.executed);
console.log('\nMD brief:\n' + reckon.brief());
console.log('\nOutbox:');
for (const m of reckon.outbox) console.log(`  to ${m.to}: ${m.subject}`);

// ---- 5. MD approves the exact conversion -----------------------------------------------------
h('5. MD approves the EUR conversion as shown; the deposit stays held');
reckon.approve('convert:EUR', 'MD');
const run2 = await reckon.run();
console.log('Executed:', run2.executed);
console.log('Still with the MD:', run2.awaitingApproval.map((d) => d.id));

// ---- 6. the world answers ---------------------------------------------------------------------
h('6. Customer pays the early-pay link; supplier agrees to split');
await awx.payLink(reckon.links.get('REC-121-INV')!);
console.log('Paid links:', await reckon.checkLinks());
const v3 = reckon.plan();
showDiff(v3.changes);
await reckon.ingestEmail(await email('02-pennine-split-yes.json'));
const run3 = await reckon.run();
console.log('After the split reply:');
showDiff(run3.changes);
console.log('Executed:', run3.executed);
const after = await awx.balances();
console.log(`Balances now: ${fmt(after.USD, 'USD')}, ${fmt(after.EUR, 'EUR')}, ${fmt(after.GBP, 'GBP')}`);
const final = reckon.plan().plan;
console.log(`Cash ${fmt(final.summary.cashUSD, 'USD')} vs floor ${fmt(final.summary.reserveFloorUSD, 'USD')}: ${final.summary.cashUSD >= final.summary.reserveFloorUSD ? 'floor holds' : 'FLOOR BREACHED'}`);

// ---- 7. never pay twice ---------------------------------------------------------------------------
h('7. Supplier chases last week\'s instalment');
await awx.transitionTransfer(prior.id, 'FAILED', 'ACCOUNT_CLOSED');
await reckon.ingestEmail(await email('03-brightline-not-received.json'));
const incident = await reckon.handleNotReceived('PAY-109-SUB-I2');
console.log('Outcome:', incident.outcome, incident.outcome === 'replaced' ? `${incident.original.id} -> ${incident.replacement.id}` : '');
const again = await reckon.handleNotReceived('PAY-109-SUB-I2');
console.log('Second chase:', again.outcome, '(no second payment)');
console.log('Attempts:', reckon.paymentAttempts().filter((a) => a.payableId === 'PAY-109-SUB-I2').map((a) => `${a.transferId} ${a.status}`).join(' | '));

// ---- 8. back to the sheet ----------------------------------------------------------------------------
h('8. Decisions written back to the finance team\'s sheet');
await mkdir('out', { recursive: true });
const rows = reckon.ledger.records.map((r) => ({
  decisionId: r.decisionId,
  kind: r.decision.kind,
  target: r.decision.target,
  amount: fmt(r.decision.amount, r.decision.currency),
  execution: reckon.ledger.executed.has(r.decisionId) ? 'done' : r.decision.execution,
  reason: r.decision.reason,
  replayHash: r.hash.slice(0, 16),
}));
await writeBook('out/finance-after.xlsx', book, rows);
console.log(`Wrote out/finance-after.xlsx with ${rows.length} decision rows.`);

// ---- 9. prove it -----------------------------------------------------------------------------------------
h('9. Replay');
for (const id of ['convert:EUR', 'early_pay_link:REC-121-INV', 'hold:PAY-117-DEPOSIT']) {
  const r = reckon.replay(id);
  console.log(`  ${id.padEnd(28)} ${r.ok ? 'identical decision from stored inputs' : `${r.reason}: ${r.detail}`}`);
}
console.log('  ledger chain:', reckon.ledger.verifyChain().ok ? 'intact' : 'BROKEN');
const tampered = structuredClone(reckon.ledger.latestRecord('convert:EUR')!);
tampered.policy.autonomousFxLimitUSD.low = 10000;
const { replay } = await import('../src/policy/replay.js');
const t = replay(tampered);
console.log('  tampered copy:', t.ok ? 'accepted (BAD)' : t.reason);

await writeFile('out/run.json', JSON.stringify({ log: reckon.log, outbox: reckon.outbox, attempts: reckon.paymentAttempts(), calls: awx.calls }, null, 2));
console.log('\nFull log in out/run.json');
