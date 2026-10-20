# Reckon: notes for Claude Code

Hackathon entry for the Airwallex Agentic Banking Hackathon 2026. Submission due Fri 13 Nov 2026, 11:59pm IST (6:29pm UK).
Needs: working demo, video under 5 minutes, this repo with setup instructions.

## Commands

- `npm test`: vitest suite; must stay green
- `npm run typecheck`
- `npm run seed:sheet`: rebuild `data/finance.xlsx` and `data/recon.json` from `src/domain/seed.ts` and `src/recon/fixture.ts`
- `npm run demo:offline`: the full story against `FakeAirwallex`, no keys
- `npm run sandbox:smoke`: every Airwallex call against the real sandbox (needs `.env`)

## Rules

- **Money logic lives in code, never in the model.** Amounts, limits, ordering, FX sizing and approvals are in `src/policy/`. The model only reads emails into typed `EmailSignal`s (validated in `src/agent/reader.ts`) and drafts message wording.
- **`plan(state, policy)` must stay pure and deterministic.** No I/O, no clocks, no randomness. Replay depends on it.
- **Never pay twice.** Every transfer goes through `Ledger.beginPayment`. On an ambiguous failure, look the transfer up by request id before doing anything else. New UUID per new operation; reuse it only for a retry of the same one.
- **Synthetic data only.** No real client, customer or supplier names or figures anywhere in the repo, the video or the README. The origin story is "a UK project-based business", unnamed.
- **Never commit keys.** `.env` is gitignored; use `.env.example` for new variables.
- Airwallex conventions from the builder guide: amounts in major units; failed transfers end CANCELLED (read `failure_type`); simulate SENT before FAILED; SWIFT costs EUR 12.85 per payout; FX quotes are single-use; no `x-api-version` on FX calls; FX conversions are REST-only; bearer token lasts 30 minutes.
- Field names marked `VERIFY` in `src/airwallex/rest.ts` are unconfirmed. Check them with the Airwallex docs MCP (`claude mcp add-json airwallex-docs '{ "type": "http", "url": "https://mcp.sandbox.airwallex.com/docs" }'`) and `npm run sandbox:smoke` before relying on them.

## Next up

- Run `sandbox:smoke` with real keys and fix the VERIFY fields
- `scripts/demo-live.ts`: the same story as `demo-offline.ts` against `AirwallexRest`
- Webhook receiver for `payment_intent.succeeded` and `payout.transfer.*` (verify HMAC on the raw body, dedupe on event id)
- MD brief and approval page (Next.js), plan diff view, replay button
- Supabase persistence for the ledger
- Claude-drafted supplier and customer messages, numbers still from code
