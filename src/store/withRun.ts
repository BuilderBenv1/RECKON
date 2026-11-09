import { Session, type SessionDeps } from '../demo/session.js';
import { ConflictError, type RunStore, type StoredRun } from './runs.js';

export class RunBusyError extends Error {
  constructor() {
    super('Reckon is still working on this run. Try again in a moment.');
  }
}

const LEASE_MS = 90_000; // longer than any one action; a crashed request's lease simply expires

/** Waits for the run's lease. Only one request acts on a run at a time. */
async function acquire(store: RunStore, id: string, waitMs: number): Promise<string> {
  const end = Date.now() + waitMs;
  for (;;) {
    const token = await store.lock(id, LEASE_MS);
    if (token) return token;
    if (Date.now() > end) throw new RunBusyError();
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Loads a run, applies a change, and saves it, holding the run's lease throughout so no other
 * request can act on it at the same time. Acting moves real money, so two requests must never
 * both act: an optimistic version check alone would catch the second save, but only after its
 * payment had gone out. The version check stays as a second line of defence.
 */
export async function withRun<T>(
  store: RunStore,
  id: string,
  fn: (s: Session) => Promise<T>,
  deps: SessionDeps = {},
  attempts = 3,
  waitMs = 25_000,
): Promise<{ run: StoredRun; session: Session; result: T }> {
  const token = await acquire(store, id, waitMs);
  try {
    return await actOnce(store, id, fn, deps, attempts);
  } finally {
    await store.unlock(id, token).catch(() => undefined);
  }
}

async function actOnce<T>(
  store: RunStore,
  id: string,
  fn: (s: Session) => Promise<T>,
  deps: SessionDeps,
  attempts: number,
): Promise<{ run: StoredRun; session: Session; result: T }> {
  for (let i = 0; ; i++) {
    const run = await store.get(id);
    if (!run) throw new Error('Run not found');
    const session = Session.restore(run.data, deps);
    const result = await fn(session);
    try {
      const saved = await store.save(run, session.snapshot(), session.refs());
      return { run: saved, session, result };
    } catch (err) {
      if (!(err instanceof ConflictError) || i >= attempts - 1) throw err;
    }
  }
}
