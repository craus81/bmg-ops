import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createJournalEntry, findJournalEntry, type JournalEntryPayload } from './netsuite';

// What FleetSuite sends NetSuite to make a journal entry from a month of card
// charges (src/lib/card-charges.ts), and how it looks one up by FleetSuite's
// own name for it. Every call is mocked; the requests and how the answers are
// read are what's held. Made-up data.

const ENV = {
  NETSUITE_ACCOUNT_ID: '1234567_SB1',
  NETSUITE_CONSUMER_KEY: 'ck',
  NETSUITE_CONSUMER_SECRET: 'cs',
  NETSUITE_TOKEN_ID: 'tk',
  NETSUITE_TOKEN_SECRET: 'ts',
};
const BASE = 'https://1234567-sb1.suitetalk.api.netsuite.com/services';

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const queryOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body).q as string;

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('findJournalEntry', () => {
  it('finds the journal entry NetSuite has under its External ID', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 7001, tranid: 'JE-501' }] }));
    expect(await findJournalEntry(' fleetsuite-card-6b0c1d2e-0000-4000-8000-000000000001 ')).toEqual({ journalId: '7001', number: 'JE-501' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/query/v1/suiteql?limit=1000&offset=0`);
    expect(init.method).toBe('POST');
    const q = queryOf(0).replace(/\s+/g, ' ').trim();
    expect(q).toBe(
      "SELECT id, tranid FROM transaction WHERE type = 'Journal' AND externalid = 'fleetsuite-card-6b0c1d2e-0000-4000-8000-000000000001' "
      + 'ORDER BY id FETCH FIRST 1 ROWS ONLY',
    );
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    expect(await findJournalEntry('fleetsuite-card-x')).toBeNull();
  });

  it("asks nothing for a name FleetSuite doesn't make, and throws when NetSuite can't answer, so the caller sends nothing", async () => {
    await expect(findJournalEntry("x' OR '1'='1")).rejects.toThrow("isn't an external id FleetSuite makes");
    await expect(findJournalEntry('')).rejects.toThrow("isn't an external id FleetSuite makes");
    await expect(findJournalEntry('a'.repeat(81))).rejects.toThrow("isn't an external id FleetSuite makes");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    await expect(findJournalEntry('fleetsuite-card-x')).rejects.toThrow('NetSuite SuiteQL error (503)');
  });
});

describe('createJournalEntry', () => {
  const ENTRY: JournalEntryPayload = {
    subsidiaryId: '2',
    tranDate: '2027-01-31',
    memo: '2100 Company card charges, January 2027, from FleetSuite',
    externalId: 'fleetsuite-card-send-1',
    lines: [
      { accountId: '610', debit: 125.5, memo: 'ACME HARDWARE · Jan 3 · card 1234' },
      { accountId: '900', credit: 125.5, memo: 'ACME HARDWARE · Jan 3 · card 1234' },
      { accountId: '620', credit: 20 },
      { accountId: '900', debit: 20 },
    ],
  };

  it('makes it with its External ID, subsidiary, date, memo and a debit or a credit on each line', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204, headers: { Location: `${BASE}/rest/record/v1/journalEntry/7002` } }));
    expect(await createJournalEntry(ENTRY)).toEqual({ success: true, journalId: '7002' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/record/v1/journalEntry`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^OAuth realm="1234567_SB1"/);
    expect(JSON.parse(init.body)).toEqual({
      externalId: 'fleetsuite-card-send-1',
      subsidiary: { id: '2' },
      tranDate: '2027-01-31',
      memo: '2100 Company card charges, January 2027, from FleetSuite',
      line: {
        items: [
          { account: { id: '610' }, debit: 125.5, memo: 'ACME HARDWARE · Jan 3 · card 1234' },
          { account: { id: '900' }, credit: 125.5, memo: 'ACME HARDWARE · Jan 3 · card 1234' },
          { account: { id: '620' }, credit: 20 },
          { account: { id: '900' }, debit: 20 },
        ],
      },
    });
  });

  it('reads the id from the answer when there is no Location', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 7003 }));
    expect(await createJournalEntry(ENTRY)).toEqual({ success: true, journalId: '7003' });
  });

  it("sends nothing that doesn't balance, has one line, or has a line with both sides or neither", async () => {
    const lines = ENTRY.lines;
    expect(await createJournalEntry({ ...ENTRY, lines: [lines[0]] }))
      .toEqual({ success: false, error: 'A journal entry needs two lines or more' });
    expect(await createJournalEntry({ ...ENTRY, lines: [lines[0], { ...lines[1], credit: 125.49 }] }))
      .toEqual({ success: false, error: "The journal entry's debits and credits don't match" });
    const bothSides = 'Each journal entry line needs a debit or a credit above $0, not both';
    expect(await createJournalEntry({ ...ENTRY, lines: [{ accountId: '610', debit: 5, credit: 5 }, { accountId: '900', credit: 0.001 }] }))
      .toEqual({ success: false, error: bothSides });
    expect(await createJournalEntry({ ...ENTRY, lines: [{ accountId: '610', debit: 5 }, { accountId: '900' }] }))
      .toEqual({ success: false, error: bothSides });
    expect(await createJournalEntry({ ...ENTRY, lines: [{ accountId: '610', debit: 5 }, { accountId: '900', credit: 5, debit: -5 }] }))
      .toEqual({ success: false, error: bothSides });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('balances to the cent, not to the floating-point sum, and sends only the side a line has an amount on', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 7004 }));
    const r = await createJournalEntry({
      ...ENTRY,
      lines: [{ accountId: '610', debit: 0.29, credit: 0 }, { accountId: '620', debit: 0.01 }, { accountId: '900', debit: 0, credit: 0.3 }],
    });
    expect(r).toEqual({ success: true, journalId: '7004' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).line.items).toEqual([
      { account: { id: '610' }, debit: 0.29 },
      { account: { id: '620' }, debit: 0.01 },
      { account: { id: '900' }, credit: 0.3 },
    ]);
  });

  it('says NetSuite refused it after a 4xx, and that it may have made it after a server error, no answer or no id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'The period is closed.' }] }, 400));
    expect(await createJournalEntry(ENTRY)).toEqual({ success: false, error: 'NetSuite error (400): The period is closed.' });
    fetchMock.mockResolvedValueOnce(new Response('Server busy', { status: 503 }));
    expect(await createJournalEntry(ENTRY)).toEqual({ success: false, error: 'NetSuite error (503): Server busy', unsure: true });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await createJournalEntry(ENTRY)).toEqual({
      success: false, error: "NetSuite said it made the journal entry but didn't say its id.", unsure: true,
    });
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await createJournalEntry(ENTRY)).toEqual({ success: false, error: "NetSuite didn't answer (socket hang up).", unsure: true });
  });
});
