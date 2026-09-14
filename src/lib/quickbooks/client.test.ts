import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QboApiError, createQboClient, entityPath } from './client';
import { makeFakeService, type FakeService } from './test-fake-service';

const ORIGINAL = { ...process.env };
const REALM = '4620816365208163';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.QBO_ENVIRONMENT = 'production';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(global, 'setTimeout').mockImplementation(((fn: any) => { fn(); return 0 as any; }) as any);
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

function service(caps: Record<string, unknown> = {}): FakeService {
  return makeFakeService({
    quickbooks_tokens: [{
      id: 1, realm_id: REALM, environment: 'production', company_name: 'BMG Fleet',
      access_token: 'access-1', access_expires_at: iso(3_600_000),
      refresh_token: 'refresh-1', refresh_expires_at: iso(100 * 86_400_000),
      minor_version: '73', needs_reauth_at: null, refresh_lease_until: null, capabilities: caps,
    }],
  });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const queryResponse = (entity: string, items: any[], extra: Record<string, unknown> = {}) =>
  json({ QueryResponse: { [entity]: items, startPosition: 1, maxResults: items.length, ...extra } });

const fault = (message: string, code = '4000', status = 400) =>
  new Response(JSON.stringify({ Fault: { Error: [{ Message: message, Detail: 'detail', code }], type: 'ValidationFault' } }), { status });

const urlOf = (call: number) => String(fetchMock.mock.calls[call][0]);
const statementOf = (call: number) => decodeURIComponent(new URL(urlOf(call)).searchParams.get('query') || '');

describe('entityPath', () => {
  it('maps the six PDF-able entities to their REST segment', () => {
    expect(entityPath('Invoice')).toBe('invoice');
    expect(entityPath('CreditMemo')).toBe('creditmemo');
    expect(entityPath('SalesReceipt')).toBe('salesreceipt');
    expect(entityPath('RefundReceipt')).toBe('refundreceipt');
    expect(entityPath('Estimate')).toBe('estimate');
    expect(entityPath('Bill')).toBe('bill');
  });

  it('throws for a type QuickBooks renders no PDF for', () => {
    // Asking would be a 404 misread as transient and retried three times.
    expect(() => entityPath('Payment')).toThrow('unsupported_pdf_entity');
    expect(() => entityPath('JournalEntry')).toThrow('unsupported_pdf_entity');
  });
});

describe('fetch', () => {
  it('pins the minor version on every call and sends the bearer token', async () => {
    fetchMock.mockResolvedValue(queryResponse('Invoice', []));
    const client = createQboClient(service() as any);
    await client.query('SELECT * FROM Invoice');
    const url = new URL(urlOf(0));
    expect(url.origin).toBe('https://quickbooks.api.intuit.com');
    expect(url.pathname).toBe(`/v3/company/${REALM}/query`);
    expect(url.searchParams.get('minorversion')).toBe('73');
    expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer access-1');
  });

  it('a 401 triggers ONE refresh and one retry', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      // The forced refresh POSTs the token endpoint.
      .mockResolvedValueOnce(json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, x_refresh_token_expires_in: 8726400, token_type: 'Bearer' }))
      .mockResolvedValueOnce(queryResponse('Invoice', [{ Id: '1' }]));
    const svc = service();
    const client = createQboClient(svc as any);
    const result = await client.query('SELECT * FROM Invoice');
    expect(result.items).toHaveLength(1);
    expect(svc.tables.quickbooks_tokens[0].access_token).toBe('access-2');
  });

  it('a 429 backs off, retries, and counts the throttle', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('throttled', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(queryResponse('Invoice', [{ Id: '1' }]));
    const svc = service();
    const client = createQboClient(svc as any);
    await client.query('SELECT * FROM Invoice');
    expect(client.stats().throttled).toBe(1);
    expect(svc.tables.quickbooks_tokens[0].capabilities.throttle.hits).toBe(1);
  });

  it('a 403 whose body says ThrottleExceeded is a throttle, not a permission error', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ Fault: { Error: [{ Message: 'ThrottleExceeded' }] } }), { status: 403 }))
      .mockResolvedValueOnce(queryResponse('Invoice', []));
    const client = createQboClient(service() as any);
    await client.query('SELECT * FROM Invoice');
    expect(client.stats().throttled).toBe(1);
  });

  it('a 5xx is tried three times and then raised', async () => {
    // A fresh Response per call: a Body can only be read once.
    fetchMock.mockImplementation(async () => new Response('boom', { status: 503 }));
    const client = createQboClient(service() as any);
    await expect(client.query('SELECT * FROM Invoice')).rejects.toBeInstanceOf(QboApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('any other 4xx is raised at ONCE with the Fault text — it is an answer, not an outage', async () => {
    fetchMock.mockImplementation(async () => fault('Invalid query', '4000', 400));
    const client = createQboClient(service() as any);
    await expect(client.query('SELECT * FROM Nope')).rejects.toMatchObject({
      message: 'Invalid query', status: 400, code: '4000', throttled: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('query envelope [probe]', () => {
  it('a 200 with no QueryResponse is bad_envelope, NEVER an empty page', async () => {
    // Reporting it as empty would mark the walk finished with the history
    // half imported.
    fetchMock.mockResolvedValue(json({ time: '2026-01-01' }));
    const client = createQboClient(service() as any);
    await expect(client.query('SELECT * FROM Invoice')).rejects.toThrow('bad_envelope');
  });
});

describe('page — the ORDERBY Id probe', () => {
  it('uses ORDERBY Id with the right STARTPOSITION/MAXRESULTS and records orderById=true', async () => {
    fetchMock.mockResolvedValue(queryResponse('Invoice', [{ Id: '1' }]));
    const svc = service();
    const client = createQboClient(svc as any);
    const page = await client.page('Invoice', null, 201, 200);
    expect(statementOf(0)).toBe('SELECT * FROM Invoice ORDERBY Id STARTPOSITION 201 MAXRESULTS 200');
    expect(page.orderBy).toBe('Id');
    expect(svc.tables.quickbooks_tokens[0].capabilities.orderById).toBe(true);
  });

  it('a rejected ORDERBY Id is retried ONCE as MetaData.LastUpdatedTime and recorded as false', async () => {
    fetchMock
      .mockResolvedValueOnce(fault('ORDERBY Id not supported'))
      .mockResolvedValueOnce(queryResponse('Invoice', [{ Id: '1' }]));
    const svc = service();
    const client = createQboClient(svc as any);
    const page = await client.page('Invoice', null, 1, 200);
    expect(statementOf(1)).toContain('ORDERBY MetaData.LastUpdatedTime');
    expect(page.orderBy).toBe('MetaData.LastUpdatedTime');
    expect(svc.tables.quickbooks_tokens[0].capabilities.orderById).toBe(false);
  });

  it('once orderById is settled false, later pages go straight to the fallback clause', async () => {
    fetchMock.mockResolvedValue(queryResponse('Invoice', []));
    const client = createQboClient(service({ orderById: false }) as any);
    await client.page('Invoice', null, 1, 200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statementOf(0)).toContain('ORDERBY MetaData.LastUpdatedTime');
  });

  it('once orderById is settled TRUE, a later failure propagates instead of re-probing', async () => {
    fetchMock.mockImplementation(async () => fault('something else'));
    const client = createQboClient(service({ orderById: true }) as any);
    await expect(client.page('Invoice', null, 1, 200)).rejects.toBeInstanceOf(QboApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an explicit order FORCES the clause and settles no capability', async () => {
    // The windowed walk in sync.ts asks for MetaData.LastUpdatedTime because
    // that is the column it is also filtering on. Nothing was tried once, so
    // nothing may be recorded.
    fetchMock.mockResolvedValue(queryResponse('Invoice', [{ Id: '1' }]));
    const svc = service();
    const client = createQboClient(svc as any);
    const page = await client.page('Invoice', "MetaData.LastUpdatedTime > '2026-09-01T00:00:00Z'", 1, 200, {
      order: 'MetaData.LastUpdatedTime',
    });
    expect(statementOf(0)).toBe(
      "SELECT * FROM Invoice WHERE MetaData.LastUpdatedTime > '2026-09-01T00:00:00Z' " +
      'ORDERBY MetaData.LastUpdatedTime STARTPOSITION 1 MAXRESULTS 200',
    );
    expect(page.orderBy).toBe('MetaData.LastUpdatedTime');
    expect(svc.tables.quickbooks_tokens[0].capabilities.orderById).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps MAXRESULTS at 1000', async () => {
    fetchMock.mockResolvedValue(queryResponse('Customer', []));
    const client = createQboClient(service() as any);
    await client.page('Customer', null, 1, 5000);
    expect(statementOf(0)).toContain('MAXRESULTS 1000');
  });

  it('threads a WHERE clause through', async () => {
    fetchMock.mockResolvedValue(queryResponse('Invoice', []));
    const client = createQboClient(service({ orderById: true }) as any);
    await client.page('Invoice', "MetaData.LastUpdatedTime > '2026-01-01'", 1, 200);
    expect(statementOf(0)).toContain("WHERE MetaData.LastUpdatedTime > '2026-01-01'");
  });
});

describe('count [probe: queryTotalCount]', () => {
  it('returns the totalCount and records support', async () => {
    fetchMock.mockResolvedValue(json({ QueryResponse: { totalCount: 4212 } }));
    const svc = service();
    const client = createQboClient(svc as any);
    expect(await client.count('Invoice')).toBe(4212);
    expect(svc.tables.quickbooks_tokens[0].capabilities.queryTotalCount).toBe(true);
  });

  it('returns NULL — not 0 — when QuickBooks reports no totalCount', async () => {
    fetchMock.mockResolvedValue(json({ QueryResponse: {} }));
    const svc = service();
    const client = createQboClient(svc as any);
    expect(await client.count('Invoice')).toBeNull();
    expect(svc.tables.quickbooks_tokens[0].capabilities.queryTotalCount).toBe(false);
  });
});

describe('latestTxnDate [probe: orderByTxnDate]', () => {
  it('returns the date when QuickBooks accepts ORDERBY TxnDate', async () => {
    fetchMock.mockResolvedValue(queryResponse('Invoice', [{ Id: '1', TxnDate: '2022-03-04' }]));
    const client = createQboClient(service() as any);
    expect(await client.latestTxnDate('Invoice')).toEqual({ date: '2022-03-04', supported: true });
  });

  it('a rejection DEGRADES rather than throwing — the cutover only needs the NetSuite side', async () => {
    fetchMock.mockImplementation(async () => fault('ORDERBY TxnDate not supported'));
    const svc = service();
    const client = createQboClient(svc as any);
    expect(await client.latestTxnDate('Invoice')).toEqual({ date: null, supported: false });
    expect(svc.tables.quickbooks_tokens[0].capabilities.orderByTxnDate).toBe(false);
  });
});

describe('cdc', () => {
  it('splits changed rows from Deleted stubs', async () => {
    fetchMock.mockResolvedValue(json({
      CDCResponse: [{ QueryResponse: [{ Invoice: [{ Id: '1' }, { Id: '2', status: 'Deleted' }] }] }],
    }));
    const svc = service();
    const client = createQboClient(svc as any);
    const result = await client.cdc(['Invoice'], '2026-01-01T00:00:00Z');
    expect(result).toEqual({ ok: true, changes: { Invoice: { items: [{ Id: '1' }], deleted: ['2'] } } });
    expect(svc.tables.quickbooks_tokens[0].capabilities.cdc).toBe(true);
  });

  it('an unrecognised envelope records cdc:false and reports unsupported', async () => {
    fetchMock.mockResolvedValue(json({ something: 'else' }));
    const svc = service();
    const client = createQboClient(svc as any);
    const result = await client.cdc(['Invoice'], '2026-01-01T00:00:00Z');
    expect(result).toMatchObject({ ok: false, unsupported: true });
    expect(svc.tables.quickbooks_tokens[0].capabilities.cdc).toBe(false);
  });

  it('a company already known to reject CDC is not asked again', async () => {
    const client = createQboClient(service({ cdc: false }) as any);
    const result = await client.cdc(['Invoice'], '2026-01-01T00:00:00Z');
    expect(result).toMatchObject({ ok: false, unsupported: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pdf [probe: pdf[<Entity>]]', () => {
  it('returns the bytes and records support for that type', async () => {
    fetchMock.mockResolvedValue(new Response(Buffer.from('%PDF-1.4 hello'), { status: 200 }));
    const svc = service();
    const client = createQboClient(svc as any);
    const result = await client.pdf('invoice', '101');
    expect(result).toMatchObject({ ok: true });
    expect(urlOf(0)).toContain('/invoice/101/pdf');
    expect(svc.tables.quickbooks_tokens[0].capabilities.pdf.Invoice).toBe(true);
  });

  it('classifies 400/404/415/501 as UNSUPPORTED and remembers it', async () => {
    for (const status of [400, 404, 415, 501]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => fault('no PDF for this entity', '4000', status));
      const svc = service();
      const client = createQboClient(svc as any);
      const result = await client.pdf('bill', '5');
      expect(result, String(status)).toMatchObject({ ok: false, unsupported: true });
      expect(svc.tables.quickbooks_tokens[0].capabilities.pdf.Bill).toBe(false);
    }
  });

  it('a type already known unsupported is not requested again', async () => {
    const client = createQboClient(service({ pdf: { Bill: false } }) as any);
    const result = await client.pdf('bill', '5');
    expect(result).toMatchObject({ ok: false, unsupported: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 5xx is an ERROR, not unsupported — it may work next time', async () => {
    fetchMock.mockImplementation(async () => new Response('boom', { status: 500 }));
    const svc = service();
    const client = createQboClient(svc as any);
    const result = await client.pdf('invoice', '101');
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(result).not.toHaveProperty('unsupported');
    expect(svc.tables.quickbooks_tokens[0].capabilities.pdf).toBeUndefined();
  });
});

describe('download [probe: attachableDownload]', () => {
  it('follows the download endpoint URL and records the winning path', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('https://files.example/tmp/abc', { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from('bytes'), { status: 200 }));
    const svc = service();
    const client = createQboClient(svc as any);
    const result = await client.download('80', null);
    expect(result).toMatchObject({ ok: true, via: 'download_endpoint' });
    expect(svc.tables.quickbooks_tokens[0].capabilities.attachableDownload).toBe('download_endpoint');
  });

  it('falls back to TempDownloadUri when the endpoint does not answer with a URL', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not a url', { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from('bytes'), { status: 200 }));
    const svc = service();
    const client = createQboClient(svc as any);
    const result = await client.download('80', 'https://files.example/temp');
    expect(result).toMatchObject({ ok: true, via: 'temp_uri' });
    expect(svc.tables.quickbooks_tokens[0].capabilities.attachableDownload).toBe('temp_uri');
  });

  it('with no path at all, reports unsupported rather than a silent empty file', async () => {
    // A 200 that is not a URL is the [M] download shape being WRONG for this
    // realm, so the verdict is about the capability and the caller may write
    // off every pending attachment.
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 200 }));
    const svc = service();
    const client = createQboClient(svc as any);
    expect(await client.download('80', null))
      .toMatchObject({ ok: false, unsupported: true, scope: 'capability' });
    expect(svc.tables.quickbooks_tokens[0].capabilities.attachableDownload).toBe(false);
  });

  it('a 5xx from /download/<id> with no TempDownloadUri is an ERROR, not unsupported', async () => {
    // One transient blip must never write off a whole class of attachments:
    // rawFetch raises QboApiError for a network error, a 401 and an
    // exhausted 5xx alike, so download() classifies like pdf() does and only
    // a definitive rejection settles the capability.
    fetchMock.mockImplementation(async () => new Response('boom', { status: 500 }));
    const svc = service();
    const client = createQboClient(svc as any);
    const result = await client.download('80', null);
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toHaveProperty('unsupported');
    expect(svc.tables.quickbooks_tokens[0].capabilities.attachableDownload).toBeUndefined();
  });

  it('a 404 from /download/<id> IS definitive and settles the capability', async () => {
    fetchMock.mockImplementation(async () => new Response('gone', { status: 404 }));
    const svc = service();
    const client = createQboClient(svc as any);
    expect(await client.download('80', null))
      .toMatchObject({ ok: false, unsupported: true, scope: 'capability' });
    expect(svc.tables.quickbooks_tokens[0].capabilities.attachableDownload).toBe(false);
  });

  it('a definitive rejection does NOT un-prove an endpoint that has already worked', async () => {
    // Once bytes have come back this way, a 404 is about this attachable id
    // (deleted at source), not about the realm — so the row is written off
    // and the capability we watched work stands.
    fetchMock.mockImplementation(async () => new Response('gone', { status: 404 }));
    const svc = service({ attachableDownload: 'download_endpoint' });
    const client = createQboClient(svc as any);
    expect(await client.download('80', null))
      .toMatchObject({ ok: false, unsupported: true, scope: 'document' });
    expect(svc.tables.quickbooks_tokens[0].capabilities.attachableDownload).toBe('download_endpoint');
  });

  it('no download path for THIS row is scoped to the document, not the realm', async () => {
    // The endpoint is already known unusable and this row's TempDownloadUri
    // expired with the chunk that indexed it. Nothing to retry, but it says
    // nothing about rows whose URI IS in hand — so the capability stands.
    const svc = service({ attachableDownload: 'temp_uri' });
    const client = createQboClient(svc as any);
    expect(await client.download('80', null))
      .toMatchObject({ ok: false, unsupported: true, scope: 'document' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(svc.tables.quickbooks_tokens[0].capabilities.attachableDownload).toBe('temp_uri');
  });
});

describe('report', () => {
  it('returns rawText BYTE-EXACT alongside the parsed JSON', async () => {
    // "as QuickBooks reported them" — re-serializing parsed JSON would
    // reorder keys and drop the source's own formatting.
    const raw = '{\n  "Header": { "Time": "2026-01-02T03:04:05-06:00", "ReportName": "ProfitAndLoss" },\n  "Rows": {}\n}';
    fetchMock.mockResolvedValue(new Response(raw, { status: 200 }));
    const client = createQboClient(service() as any);
    const result = await client.report('ProfitAndLoss', { start_date: '2024-01-01', end_date: '2024-01-31' });
    expect(result.rawText).toBe(raw);
    expect(result.generatedAt).toBe('2026-01-02T03:04:05-06:00');
    expect(urlOf(0)).toContain('/reports/ProfitAndLoss');
  });

  it('rejects a body that is neither Header nor Rows', async () => {
    fetchMock.mockResolvedValue(json({ nothing: true }));
    const client = createQboClient(service() as any);
    await expect(client.report('ProfitAndLoss', {})).rejects.toThrow('bad_envelope');
  });
});

describe('companyInfo', () => {
  it('tries the query endpoint first and records the probe', async () => {
    fetchMock.mockResolvedValue(json({ QueryResponse: { CompanyInfo: [{ CompanyName: 'BMG Fleet' }] } }));
    const svc = service();
    const client = createQboClient(svc as any);
    expect(await client.companyInfo()).toEqual({ companyName: 'BMG Fleet', probe: 'ok' });
    expect(urlOf(0)).toContain('/query');
    expect(svc.tables.quickbooks_tokens[0].capabilities.companyInfo).toBe(true);
  });

  it('falls back to the REST shape when the query returns nothing usable', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ QueryResponse: {} }))
      .mockResolvedValueOnce(json({ CompanyInfo: { CompanyName: 'BMG Fleet' } }));
    const client = createQboClient(service() as any);
    expect(await client.companyInfo()).toEqual({ companyName: 'BMG Fleet', probe: 'ok' });
    expect(urlOf(1)).toContain('/companyinfo/');
  });

  it('a total failure is reported, never thrown, and records companyInfo=false', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 500 }));
    const svc = service();
    const client = createQboClient(svc as any);
    const result = await client.companyInfo();
    expect(result.probe).toBe('failed');
    expect(result.companyName).toBeNull();
    expect(svc.tables.quickbooks_tokens[0].capabilities.companyInfo).toBe(false);
  });
});

describe('the limiter', () => {
  it('never runs more than six calls in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => process.nextTick(r));
      inFlight--;
      return queryResponse('Invoice', []);
    });
    const client = createQboClient(service({ orderById: true }) as any);
    await Promise.all(Array.from({ length: 20 }, () => client.query('SELECT * FROM Invoice')));
    expect(peak).toBeLessThanOrEqual(6);
    expect(client.stats().calls).toBe(20);
  });
});
