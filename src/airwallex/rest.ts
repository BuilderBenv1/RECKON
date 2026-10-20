import type { Balances, Currency } from '../domain/types.js';
import type { PayeeDetails } from '../domain/payees.js';
import type { AirwallexPort, FxQuote, PaymentLinkView, SandboxSimulator, TransferStatus, TransferView } from './port.js';

// REST client for the Airwallex sandbox, written from the hackathon builder guide.
// Lines marked VERIFY are field names the guide does not spell out; confirm them with the
// Airwallex docs MCP (https://mcp.sandbox.airwallex.com/docs) and `npm run sandbox:smoke`.
//
// Conventions from the guide:
// - Base URL https://api.sandbox.airwallex.com, paths under /api/v1
// - Login with x-client-id + x-api-key headers, no body; bearer token lasts 30 minutes
// - Amounts in major units; request_id is a UUID reused only for a retry of the same operation
// - No x-api-version on FX calls; FX conversions are REST-only (no MCP tool)

const TOKEN_TTL_MS = 25 * 60 * 1000; // re-login before the 30-minute expiry

export class AirwallexRest implements AirwallexPort, SandboxSimulator {
  private token: { value: string; at: number } | null = null;

  constructor(
    private readonly cfg: { baseUrl: string; clientId: string; apiKey: string },
    private readonly now: () => number = Date.now,
  ) {}

  static fromEnv(): AirwallexRest {
    const clientId = process.env.AWX_CLIENT_ID;
    const apiKey = process.env.AWX_API_KEY;
    if (!clientId || !apiKey) throw new Error('Set AWX_CLIENT_ID and AWX_API_KEY in .env (sandbox keys only).');
    return new AirwallexRest({ baseUrl: process.env.AWX_BASE_URL ?? 'https://api.sandbox.airwallex.com', clientId, apiKey });
  }

  private async auth(): Promise<string> {
    if (this.token && this.now() - this.token.at < TOKEN_TTL_MS) return this.token.value;
    const res = await fetch(`${this.cfg.baseUrl}/api/v1/authentication/login`, {
      method: 'POST',
      headers: { 'x-client-id': this.cfg.clientId, 'x-api-key': this.cfg.apiKey },
    });
    if (!res.ok) throw new AirwallexError('login', res.status, await res.text());
    const body = (await res.json()) as { token: string };
    this.token = { value: body.token, at: this.now() };
    return body.token;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, attempt = 0): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.auth()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && attempt === 0) {
      this.token = null;
      return this.call(method, path, body, 1);
    }
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return this.call(method, path, body, attempt + 1);
    }
    const text = await res.text();
    if (!res.ok) throw new AirwallexError(`${method} ${path}`, res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async balances(): Promise<Balances> {
    const rows = await this.call<{ currency: string; available_amount: number }[]>('GET', '/balances/current');
    const out: Balances = { USD: 0, EUR: 0, GBP: 0 };
    for (const r of rows) if (r.currency in out) out[r.currency as Currency] = r.available_amount;
    return out;
  }

  async quote(sell: Currency, buy: Currency, buyAmount: number): Promise<FxQuote> {
    // VERIFY: quote request/response field names (validity window, client_rate location).
    const q = await this.call<{ quote_id: string; client_rate: number }>('POST', '/fx/quotes/create', {
      sell_currency: sell,
      buy_currency: buy,
      buy_amount: buyAmount.toFixed(2),
      validity: 'MIN_1',
    });
    return { quoteId: q.quote_id, sellCurrency: sell, buyCurrency: buy, buyAmount, clientRate: q.client_rate };
  }

  async convert({ requestId, quote }: { requestId: string; quote: FxQuote }) {
    const c = await this.call<{ conversion_id?: string; id?: string; status: string }>('POST', '/fx/conversions/create', {
      request_id: requestId,
      buy_currency: quote.buyCurrency,
      sell_currency: quote.sellCurrency,
      buy_amount: quote.buyAmount.toFixed(2),
      quote_id: quote.quoteId,
    });
    return { conversionId: c.conversion_id ?? c.id ?? '', status: c.status };
  }

  async ensureBeneficiary(payee: PayeeDetails): Promise<string> {
    const bank_details =
      payee.bank.kind === 'US'
        ? { account_name: payee.supplier, account_currency: 'USD', bank_country_code: 'US', account_number: payee.bank.account_number, account_routing_type1: 'aba', account_routing_value1: payee.bank.aba, bank_account_category: payee.bank.bank_account_category }
        : payee.bank.kind === 'GB'
          ? { account_name: payee.supplier, account_currency: 'GBP', bank_country_code: 'GB', account_number: payee.bank.account_number, account_routing_type1: 'sort_code', account_routing_value1: payee.bank.sort_code, bank_name: payee.bank.bank_name }
          : { account_name: payee.supplier, account_currency: 'EUR', bank_country_code: 'DE', iban: payee.bank.iban, swift_code: payee.bank.swift_code };
    // VERIFY: beneficiary envelope (entity_type, company_name) against POST /beneficiaries/schema.
    const b = await this.call<{ id?: string; beneficiary_id?: string }>('POST', '/beneficiaries/create', {
      request_id: crypto.randomUUID(),
      nickname: payee.supplier,
      beneficiary: {
        entity_type: 'COMPANY',
        company_name: payee.supplier,
        address: payee.address,
        bank_details,
      },
      transfer_methods: [payee.method],
    });
    return b.beneficiary_id ?? b.id ?? '';
  }

  async createTransfer(args: Parameters<AirwallexPort['createTransfer']>[0]): Promise<TransferView> {
    // Guide: send transfer_currency and transfer_amount (payment_currency returns code 001).
    // VERIFY: whether `reason` and `source_currency` are required on this account.
    const t = await this.call<RawTransfer>('POST', '/transfers/create', {
      request_id: args.requestId,
      beneficiary_id: args.beneficiaryId,
      transfer_amount: args.amount.toFixed(2),
      transfer_currency: args.currency,
      source_currency: args.currency,
      transfer_method: args.method,
      reference: args.reference.slice(0, 35),
      reason: 'payment_to_supplier',
    });
    return toView(t);
  }

  async getTransfer(id: string): Promise<TransferView> {
    return toView(await this.call<RawTransfer>('GET', `/transfers/${id}`));
  }

  async findTransferByRequestId(requestId: string): Promise<TransferView | null> {
    // VERIFY: list filter name; falls back to scanning the first page.
    const page = await this.call<{ items: RawTransfer[] }>('GET', `/transfers?request_id=${encodeURIComponent(requestId)}`);
    const hit = page.items?.find((t) => t.request_id === requestId);
    return hit ? toView(hit) : null;
  }

  async createPaymentLink(args: { title: string; amount: number; currency: Currency; reference: string }): Promise<PaymentLinkView> {
    const l = await this.call<{ id: string; url: string; status: 'UNPAID' | 'PAID' }>('POST', '/pa/payment_links/create', {
      title: args.title,
      amount: args.amount.toFixed(2),
      currency: args.currency,
      reusable: false,
      reference: args.reference,
    });
    return { id: l.id, url: l.url, status: l.status ?? 'UNPAID', amount: args.amount, currency: args.currency };
  }

  async notifyShopper(linkId: string, email: string): Promise<void> {
    // VERIFY: body field name for the shopper's email.
    await this.call('POST', `/pa/payment_links/${linkId}/notify_shopper`, { shopper_email: email });
  }

  async getPaymentLink(id: string): Promise<PaymentLinkView> {
    const l = await this.call<{ id: string; url: string; status: 'UNPAID' | 'PAID'; amount: number; currency: Currency }>('GET', `/pa/payment_links/${id}`);
    return { id: l.id, url: l.url, status: l.status, amount: Number(l.amount), currency: l.currency };
  }

  // ---- sandbox simulation ----

  async deposit(amount: number, currency: Currency, payerName: string): Promise<void> {
    // The deposit lands in the Global Account's currency; pick an account in `currency`.
    const accounts = await this.call<{ items: { id: string; required_features?: { currency: string }[] }[] }>('GET', '/global_accounts');
    const acct = accounts.items.find((a) => a.required_features?.some((f) => f.currency === currency)) ?? accounts.items[0];
    if (!acct) throw new Error('No Global Account in the sandbox; create one first (see README).');
    await this.call('POST', '/simulation/deposit/create', { global_account_id: acct.id, amount, payer_name: payerName });
  }

  async transitionTransfer(id: string, next: 'SENT' | 'PAID' | 'FAILED', failureType?: string): Promise<void> {
    // Guide: simulate SENT before PAID; failure_type only applies after SENT.
    // VERIFY: body field names for the target status and failure type.
    await this.call('POST', `/simulation/transfers/${id}/transition`, failureType ? { next_status: next, failure_type: failureType } : { next_status: next });
  }

  async payLink(): Promise<void> {
    throw new Error('In the live sandbox, open the payment link and pay with test card 4035501000000008 (any future expiry, any CVC).');
  }
}

interface RawTransfer {
  id: string;
  request_id: string;
  status: string;
  transfer_amount: number | string;
  transfer_currency: Currency;
  reference: string;
  failure_type?: string;
  failure_reason?: string;
}

function toView(t: RawTransfer): TransferView {
  const v: TransferView = {
    id: t.id,
    requestId: t.request_id,
    status: t.status as TransferStatus,
    amount: Number(t.transfer_amount),
    currency: t.transfer_currency,
    reference: t.reference,
  };
  if (t.failure_type) v.failureType = t.failure_type;
  if (t.failure_reason) v.failureReason = t.failure_reason;
  return v;
}

export class AirwallexError extends Error {
  constructor(readonly op: string, readonly status: number, readonly body: string) {
    super(`Airwallex ${op} failed (${status}): ${body.slice(0, 300)}`);
  }
}
