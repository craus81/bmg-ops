// FleetSuite AI (src/app/api/ai-agent/chat) with "Financials on FleetSuite's
// books" off and on (Books part 83, docs/books.md "The AI assistant"): on,
// leadership's money questions are asked of BMG's books, and SuiteQL reading
// NetSuite's balances is refused; off, nothing changes. Claude's replies and
// what the books answer are made up here; the books' own reads are tested
// against made-up books in money-screens-route.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

let roles: string[] = [];
vi.mock('@/lib/api-auth', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: 'u-pat' }, profile: { role: roles[0], roles } })),
}));

// The route makes its service client when it loads, so the made-up one is hoisted with it.
const db = vi.hoisted(() => {
  const state = { switches: {} as Record<string, boolean>, switchError: false, switchReads: [] as string[] };
  const from = (table: string) => {
    const where: Record<string, unknown> = {};
    const answer = () => {
      if (table !== 'books_switches') return { data: [], error: null, count: 0 };
      state.switchReads.push(String(where.piece));
      return state.switchError
        ? { data: null, error: { message: "Couldn't read books_switches" } }
        : { data: [{ is_on: state.switches[String(where.piece)] === true }], error: null };
    };
    const q: any = {
      select: () => q,
      order: () => q,
      or: () => q,
      eq: (column: string, value: unknown) => { where[column] = value; return q; },
      maybeSingle: async () => { const a = answer(); return { data: a.data?.[0] ?? null, error: a.error }; },
      then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(answer()).then(done, failed),
    };
    return q;
  };
  return { state, service: { from, rpc: async () => ({ data: null, error: { message: 'No functions here' } }) } };
});
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => db.service }));

const netsuite = vi.hoisted(() => ({ suiteqlQuery: vi.fn(), transactionUrl: vi.fn(() => '') }));
vi.mock('@/lib/netsuite', () => netsuite);
const books = vi.hoisted(() => ({ loadBooksForAssistant: vi.fn() }));
vi.mock('@/lib/books/money-screens-data', () => books);
const audit = vi.hoisted(() => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/audit', () => audit);

import { POST } from '../../app/api/ai-agent/chat/route';
import { BOOKS_INSTEAD, BOOKS_OFF, BOOKS_PROMPT } from './assistant-books';

const AS_OF = "From BMG's books in FleetSuite, as Home → Financials shows them, as of the posting run at 11/2/2026, 11:48 AM Central (it runs every two hours).";
const AR_SQL = "SELECT c.companyname, SUM(t.foreignamountunpaid) FROM transaction t JOIN customer c ON c.id = t.entity WHERE t.type = 'CustInvc' AND t.status = 'A' GROUP BY c.companyname";
const SO_SQL = "SELECT t.tranid, t.trandate FROM transaction t WHERE t.type = 'SalesOrd' ORDER BY t.trandate DESC";

/** Claude's replies, in turn: the queries it asks, then its answer. */
let replies: string[];
/** What was sent to Claude each time. */
let sent: Array<{ system: string; messages: Array<{ role: string; content: string }> }>;

const queries = (...asked: Array<Record<string, unknown>>) => JSON.stringify({ queries: asked });

const chat = async (question: string) => {
  const res = await POST(new NextRequest('https://go.bmgfleet.com/api/ai-agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
  }));
  return { status: res.status, body: await res.json() };
};
/** What the assistant was told the queries came back with. */
const results = () => sent[1].messages[sent[1].messages.length - 1].content;
const audited = () => (audit.logAudit.mock.calls[0] as unknown[] | undefined)?.[1] as { detail: { queries: unknown[] } } | undefined;

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
  roles = ['super_admin'];
  db.state.switches = { money_screens: true };
  db.state.switchError = false;
  db.state.switchReads = [];
  replies = [];
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ content: [{ text: replies.shift() ?? 'Done.' }] }) };
  }));
  netsuite.suiteqlQuery.mockReset();
  netsuite.suiteqlQuery.mockResolvedValue({ items: [{ tranid: 'SO1177', trandate: '10/30/2026' }] });
  books.loadBooksForAssistant.mockReset();
  books.loadBooksForAssistant.mockResolvedValue({ items: [{ customer: 'Acme Fleet', balance: 1250, most_days_past_due: 32 }], asOf: AS_OF });
  audit.logAudit.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("FleetSuite AI with Financials on FleetSuite's books on", () => {
  it("asks BMG's books for leadership's money questions and passes on when they're as of", async () => {
    for (const r of [['super_admin'], ['executive'], ['sales', 'executive']]) {
      roles = r;
      replies = [queries({ id: 'owed', source: 'books', read: 'receivables', params: { customer: ' acme ' } }), 'Acme Fleet owes $1,250.'];
      sent = [];
      books.loadBooksForAssistant.mockClear();
      audit.logAudit.mockClear();

      expect(await chat('Who owes us the most?'), r.join()).toEqual({ status: 200, body: { reply: 'Acme Fleet owes $1,250.', queriesExecuted: 1 } });
      expect(books.loadBooksForAssistant).toHaveBeenCalledWith(db.service, { read: 'receivables', name: 'acme' });
      expect(results()).toContain(`"owed" (1 rows):\n${JSON.stringify([{ customer: 'Acme Fleet', balance: 1250, most_days_past_due: 32 }], null, 2)}\n${AS_OF}\n\nBased on these results`);
      expect(audited()?.detail.queries).toEqual([{ source: 'books', read: 'receivables', params: '{"customer":" acme "}' }]);
    }
    expect(netsuite.suiteqlQuery).not.toHaveBeenCalled();
  });

  it("swaps NetSuite's money examples in its prompt for the books' reads", async () => {
    replies = ['Hello.'];
    await chat('Hi');
    const system = sent[0].system;
    expect(system).toContain(BOOKS_PROMPT);
    for (const gone of ['- AR: SELECT', '- AP: Same but VendBill', '- Revenue by month: SELECT', '- Overdue invoices: SELECT']) {
      expect(system).not.toContain(gone);
    }
    expect(system).toContain('- Top customers: SELECT');
    expect(system).toContain('UPFIT VS GRAPHICS REVENUE');
    expect(db.state.switchReads).toContain('money_screens');
  });

  it("refuses SuiteQL reading NetSuite's balances, but not NetSuite's documents", async () => {
    replies = [queries({ id: 'ar', source: 'netsuite', sql: AR_SQL }, { id: 'gl', sql: 'SELECT a.acctnumber, a.balance FROM account a' }, { id: 'so', source: 'netsuite', sql: SO_SQL }), 'Done.'];
    await chat('What do customers owe, and what sold lately?');
    expect(results()).toContain(`"ar" ERROR: ${BOOKS_INSTEAD}`);
    expect(results()).toContain(`"gl" ERROR: ${BOOKS_INSTEAD}`);
    expect(results()).toContain('"so" (1 rows):');
    expect(netsuite.suiteqlQuery).toHaveBeenCalledTimes(1);
    expect(netsuite.suiteqlQuery).toHaveBeenCalledWith(SO_SQL, 200, 0);
    expect(audited()?.detail.queries).toEqual([
      { source: 'netsuite', sql: AR_SQL, blocked: true },
      { source: 'netsuite', sql: 'SELECT a.acctnumber, a.balance FROM account a', blocked: true },
      { source: 'netsuite', sql: SO_SQL },
    ]);
  });

  it("says why when the books can't answer, without going to NetSuite", async () => {
    books.loadBooksForAssistant.mockImplementation(async (_service: unknown, ask: { read: string }) => (ask.read === 'summary'
      ? { error: "Couldn't read FleetSuite's books: gl_party_balances failed" }
      : { items: [], asOf: AS_OF }));
    replies = [queries(
      { id: 'pl', source: 'books', read: 'profit_and_loss', params: { from: '2026-13' } },
      { id: 'what', source: 'books', read: 'balances' },
      { id: 'tiles', source: 'books', read: 'summary' },
      { id: 'none', source: 'books', read: 'open_bills', params: { vendor: 'Nobody' } },
    ), 'Sorry.'];
    expect(await chat('How are we doing?')).toEqual({ status: 200, body: { reply: 'Sorry.', queriesExecuted: 4 } });
    expect(results()).toContain('"pl" ERROR: "from" is a month written YYYY-MM, like 2026-10.');
    expect(results()).toContain(`"what" ERROR: FleetSuite's books answer these reads: summary, receivables, open_invoices, payables, open_bills, accounts, profit_and_loss, months.`);
    expect(results()).toContain(`"tiles" ERROR: Couldn't read FleetSuite's books: gl_party_balances failed`);
    expect(results()).toContain(`"none": No rows returned.\n${AS_OF}`);
    expect(books.loadBooksForAssistant.mock.calls.map(([, ask]) => ask)).toEqual([{ read: 'summary' }, { read: 'open_bills', name: 'Nobody' }]);
    expect(netsuite.suiteqlQuery).not.toHaveBeenCalled();
  });
});

describe("FleetSuite AI with Financials on FleetSuite's books off", () => {
  it('reads NetSuite as before: its examples in the prompt, no books, and a books read refused', async () => {
    db.state.switches = { money_screens: false };
    replies = [queries({ id: 'b', source: 'books', read: 'summary' }, { id: 'ar', source: 'netsuite', sql: AR_SQL }), 'Done.'];
    await chat('What do customers owe?');
    expect(sent[0].system).not.toContain("FLEETSUITE'S BOOKS");
    expect(sent[0].system).toContain('- AR: SELECT');
    expect(results()).toContain(`"b" ERROR: ${BOOKS_OFF}`);
    expect(results()).toContain('"ar" (1 rows):');
    expect(netsuite.suiteqlQuery).toHaveBeenCalledWith(AR_SQL, 200, 0);
    expect(books.loadBooksForAssistant).not.toHaveBeenCalled();
  });

  it("counts a switch it can't read as off", async () => {
    db.state.switchError = true;
    replies = [queries({ id: 'b', source: 'books', read: 'summary' }, { id: 'ar', source: 'netsuite', sql: AR_SQL }), 'Done.'];
    await chat('What do customers owe?');
    expect(sent[0].system).not.toContain(BOOKS_PROMPT);
    expect(results()).toContain(`"b" ERROR: ${BOOKS_OFF}`);
    expect(netsuite.suiteqlQuery).toHaveBeenCalledWith(AR_SQL, 200, 0);
    expect(books.loadBooksForAssistant).not.toHaveBeenCalled();
  });
});

describe("FleetSuite's books through the assistant are leadership's alone", () => {
  it('refuses them to everyone else, on or off, without reading the switch', async () => {
    for (const r of [['sales'], ['admin'], ['finance'], ['installer']]) {
      roles = r;
      replies = [queries({ id: 'b', source: 'books', read: 'receivables' }), 'Done.'];
      sent = [];
      db.state.switchReads = [];
      await chat('Who owes us the most?');
      expect(results(), r.join()).toContain(`"b" ERROR: FleetSuite's books are restricted to leadership. Ask about jobs, parts, customers, vehicles, or schedules instead.`);
      expect(sent[0].system).not.toContain(BOOKS_PROMPT);
      expect(db.state.switchReads).not.toContain('money_screens');
    }
    expect(books.loadBooksForAssistant).not.toHaveBeenCalled();
  });

  it("still refuses everyone else NetSuite's balances as financial data, not pointing them at the books", async () => {
    roles = ['sales'];
    replies = [queries({ id: 'ar', source: 'netsuite', sql: AR_SQL }), 'Done.'];
    await chat('What do customers owe?');
    expect(results()).toContain('"ar" ERROR: That involves financial data (GL balances, A/R, A/P, or payments), which is restricted to leadership.');
    expect(results()).not.toContain(BOOKS_INSTEAD);
    expect(netsuite.suiteqlQuery).not.toHaveBeenCalled();
  });
});
