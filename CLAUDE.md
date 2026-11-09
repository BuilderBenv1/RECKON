# Reckon: notes for Claude Code

Hackathon entry for the Airwallex Agentic Banking Hackathon 2026. Submission due Fri 13 Nov 2026, 11:59pm IST (6:29pm UK).
Needs: working demo, video under 5 minutes, this repo with setup instructions.

## Commands

- `npm run dev` / `npm run build`: the Next.js web app (MD brief, approvals, diff, replay, story steps)
- `npm test`: vitest suite; must stay green
- `npm run typecheck`
- `npm run seed:sheet`: rebuild `data/finance.xlsx` and `data/recon.json` from `src/domain/seed.ts` and `src/recon/fixture.ts`
- `npm run demo:offline`: the full story against `FakeAirwallex`, no keys
- `npm run sandbox:smoke`: every Airwallex call against the real sandbox (needs `.env`); 16/16 passed on 25 Oct 2026
- `npm run demo:live`: the full story against the real sandbox through `OperatingEnvelope` (needs `.env`; you pay the payment link with test card 4035501000000008)

## Rules

- **Money logic lives in code, never in the model.** Amounts, limits, ordering, FX sizing and approvals are in `src/policy/`. The model only reads emails into typed `EmailSignal`s (validated in `src/agent/reader.ts`) and drafts message wording.
- **`plan(state, policy)` must stay pure and deterministic.** No I/O, no clocks, no randomness. Replay depends on it.
- **Never pay twice.** Every transfer goes through `Ledger.beginPayment`. On an ambiguous failure, look the transfer up by request id before doing anything else. Request ids are derived from the run seed and the operation (`src/agent/ids.ts`): attempt n of a payable, or the nth conversion for a decision, always gets the same id, so racing requests are refused by Airwallex; a replacement is attempt n + 1. Only one request acts on a run at a time: `withRun` holds the run's lease (`lock`/`unlock`, migration 0004). Never move money outside `withRun`. (9 Nov 2026: a poll and the tour's check raced and paid PAY-OH-SAAS twice in the sandbox; `test/race.test.ts` pins the fix.)
- **Synthetic data only.** No real client, customer or supplier names or figures anywhere in the repo, the video or the README. The origin story is "a UK project-based business", unnamed.
- **Live runs plan from story-sized balances.** A new sandbox holds millions per currency; `src/airwallex/envelope.ts` sends every call to the real sandbox but reports an operating balance that starts at `seedBalances` and moves with each real money movement. A transfer reading FAILED or CANCELLED is dead (FAILED shows for a few seconds before auto-cancel).
- **Live runs use the scoped key `reckon-sandbox`.** Admin keys are disabled for new accounts.
- **Never commit keys.** `.env` is gitignored; use `.env.example` for new variables.
- Airwallex conventions from the builder guide: amounts in major units; failed transfers end CANCELLED (read `failure_type`); simulate SENT before FAILED; SWIFT costs EUR 12.85 per payout; FX quotes are single-use; no `x-api-version` on FX calls; FX conversions are REST-only; bearer token lasts 30 minutes.
- Airwallex field names in `src/airwallex/rest.ts` were checked against the API reference (linked per method) on 23 Oct 2026. `npm run sandbox:smoke` confirms them live. Transfer `reason` is a closed list; simulated `failure_type` values include ACCOUNT_CLOSED (not BENEFICIARY_ACCOUNT_CLOSED).

## Web app

- `app/` is thin: pages and API routes call `src/web/server.ts`. All behaviour lives in `src/demo/session.ts` (one run, saved as a snapshot between requests) and `src/web/view.ts` (what the page shows, from a fresh pure plan).
- Runs are stored by `src/store/runs.ts`: Supabase over REST with an optimistic `version` check, or memory without Supabase env vars. `withRun` retries on conflict.
- Webhooks: `app/api/webhooks/airwallex` verifies hex HMAC-SHA256 over `x-timestamp + raw body`, dedupes on event id, then `src/webhooks/airwallex.ts` applies it to live runs.
- Demo runs never call Airwallex. Live runs need `RECKON_LIVE_CODE`. Public demo runs use Claude only with `RECKON_DEMO_CLAUDE=1`, capped at `CLAUDE_CALL_LIMIT` calls a run.
- Guided demo: `src/web/narration.ts` builds the voice-over from the run view (pure, no hard-coded numbers); `app/components/narrator.ts` speaks it with browser speech synthesis, a sentence at a time. Keep the narration under about 4 minutes so the video fits. With `ELEVENLABS_API_KEY`, `src/web/voice.ts` voices each line once (allowlist = the demo's own script) and caches it in the public Supabase bucket `narration`; any wording change re-records that line. `/voices` auditions the shortlisted voices. Clips play through one AudioContext kept alive for the whole tour, so speakers don't clip first words. Guided live run (access code) uses the real sandbox, pauses at the payment link until it's paid, and voices its lines via `POST /api/narration/live` (live-run cookie only). Narration wording is plain spoken English for non-technical owners: no AI-style flourishes.
- Engine files import each other with `.js` extensions; `next.config.mjs` maps them to `.ts`. JSON fixtures the server needs are imported statically so Vercel bundles them.

## Next up

- Submitted on HackerEarth 9 Nov 2026, 2:02pm (Build Phase, published). Video: https://youtu.be/ocjtQWg_QEg (4:48, replays the clean live sandbox run of 9 Nov 12:02, run 1c7d65df).
- Deployed at https://reckon-henna.vercel.app with Supabase. A daily Vercel cron hits `/api/cron/keepalive` so the free Supabase project doesn't pause.
- Finalists announced 15 Nov; Demo Day 19 Nov (remote optional).
- Optional: add the Airwallex webhook; change the live access code after judging.
