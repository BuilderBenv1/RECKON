import { describe, expect, it } from 'vitest';
import { requestIds } from '../src/agent/ids.js';
import { FakeAirwallex } from '../src/airwallex/fake.js';
import { Session } from '../src/demo/session.js';
import { seedRates } from '../src/domain/seed.js';
import { MemoryRunStore } from '../src/store/runs.js';
import { withRun } from '../src/store/withRun.js';

// 9 Nov 2026: in a live sandbox run, the guided tour's payment check and the page's own poll
// arrived together after the customer paid. Both replanned and both paid the deferred renewal,
// so Airwallex shows two USD 850 transfers for PAY-OH-SAAS. These tests pin the fix.

/** A live run, one shared "Airwallex" behind it, advanced to the moment the customer has paid. */
async function paidLinkRun() {
  const airwallex = new FakeAirwallex({ USD: 1e7, EUR: 1e7, GBP: 1e7 }, seedRates);
  const deps = { claude: false, live: () => airwallex };
  const store = new MemoryRunStore(false);
  const s = await Session.create('live', deps);
  const run = await store.create('live', s.snapshot(), s.refs());
  for (const action of [{ type: 'delay_email' }, { type: 'run' }, { type: 'approve', decisionId: 'convert:EUR' }] as const) {
    await withRun(store, run.id, (x) => x.act(action as never), deps);
  }
  const linkId = (await store.get(run.id))!.data.reckon.links[0]![1];
  await airwallex.payLink(linkId);
  const renewals = () => [...(airwallex.snapshot().transfers as [string, { reference: string }][])].filter(([, t]) => t.reference === 'PAY-OH-SAAS');
  return { airwallex, deps, store, run, renewals };
}

describe('two requests racing on one live run', () => {
  it('pays the deferred renewal once when two payment checks arrive together', async () => {
    const { deps, store, run, renewals } = await paidLinkRun();
    expect(renewals()).toHaveLength(0);
    await Promise.all([
      withRun(store, run.id, (x) => x.act({ type: 'check_links' }), deps),
      withRun(store, run.id, (x) => x.act({ type: 'check_links' }), deps),
    ]);
    expect(renewals()).toHaveLength(1);
  });

  it('still pays once if the lock were bypassed: both send the same request id and Airwallex refuses the second', async () => {
    const { deps, store, run, renewals } = await paidLinkRun();
    const snap = (await store.get(run.id))!.data;
    const a = Session.restore(snap, deps);
    const b = Session.restore(snap, deps);
    await Promise.all([a.act({ type: 'check_links' }), b.act({ type: 'check_links' })]);
    expect(renewals()).toHaveLength(1);
  });

  it('lets one request act at a time, and the second sees the first one\'s work', async () => {
    const store = new MemoryRunStore(false);
    const s = await Session.create('demo', { claude: false });
    const run = await store.create('demo', s.snapshot(), s.refs());
    const order: string[] = [];
    await Promise.all(
      ['a', 'b'].map((tag) =>
        withRun(store, run.id, async (x) => {
          order.push(`${tag}:start:${x.snap.done.length}`);
          await new Promise((r) => setTimeout(r, 30));
          if (!x.snap.done.includes('delay_email')) await x.act({ type: 'delay_email' });
          order.push(`${tag}:end`);
        }, { claude: false }),
      ),
    );
    expect(order).toEqual(['a:start:1', 'a:end', 'b:start:2', 'b:end']);
  });
});

describe('request ids', () => {
  it('are the same for the same operation in the same run, and differ otherwise', () => {
    const id = requestIds('run-seed');
    expect(id('pay|PAY-OH-SAAS|0')).toBe(requestIds('run-seed')('pay|PAY-OH-SAAS|0'));
    expect(id('pay|PAY-OH-SAAS|1')).not.toBe(id('pay|PAY-OH-SAAS|0')); // a replacement is a new payment
    expect(requestIds('other-run')('pay|PAY-OH-SAAS|0')).not.toBe(id('pay|PAY-OH-SAAS|0'));
    expect(id('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
