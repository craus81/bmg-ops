// The Download Excel buttons' hook (src/lib/use-file-download.ts): fetch the
// file a route makes, save it, and when Safari wants a fresh tap for the
// share sheet, keep the file for the next tap. React's two hooks it uses are
// stood in for by a few lines that keep state between "renders".
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: unknown[] = [];
let slot = 0;
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const at = slot++;
    if (!(at in state)) state[at] = initial;
    return [state[at], (v: unknown) => { state[at] = v; }];
  },
  useCallback: (fn: unknown) => fn,
}));
const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (url: string) => apiFetch(url) }));
const saveFile = vi.fn();
vi.mock('@/lib/native-files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./native-files')>()),
  saveFile: (blob: Blob, name: string) => saveFile(blob, name),
}));

import { useFileDownload } from './use-file-download';

const URL1 = '/api/admin/books/reports/download?company=BMG&report=balance_sheet&from=2026-09&to=2026-09';
const errors: string[] = [];
// One "render": the hook called afresh, its state where the last one left it.
// eslint-disable-next-line react-hooks/rules-of-hooks
const render = () => { slot = 0; return useFileDownload((m) => { errors.push(m); }); };
const xlsx = (name: string | null, status = 200, body: BodyInit = 'PK') => new Response(body, {
  status,
  headers: name ? { 'content-disposition': `attachment; filename="${name}"` } : {},
});
const refused = () => Object.assign(new Error('The request is not allowed by the user agent'), { name: 'NotAllowedError' });

beforeEach(() => {
  state.length = 0;
  errors.length = 0;
  apiFetch.mockReset();
  saveFile.mockReset();
});

describe('useFileDownload', () => {
  it("fetches the route's file and saves it under the route's name, busy only while it's made", async () => {
    let finish!: (r: Response) => void;
    apiFetch.mockReturnValueOnce(new Promise<Response>((r) => { finish = r; }));
    const tap = render().download(URL1, 'Report.xlsx');
    expect(render().busy).toBe(true);
    finish(xlsx('BMG Balance Sheet 2026-09-30.xlsx'));
    await tap;
    expect(apiFetch).toHaveBeenCalledWith(URL1);
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(saveFile.mock.calls[0][1]).toBe('BMG Balance Sheet 2026-09-30.xlsx');
    expect(await (saveFile.mock.calls[0][0] as Blob).text()).toBe('PK');
    expect(render().busy).toBe(false);
    expect(render().ready(URL1)).toBe(false);
    expect(errors).toEqual([]);
  });

  it('uses the fallback name when the route gives none', async () => {
    apiFetch.mockResolvedValueOnce(xlsx(null));
    await render().download(URL1, 'Report.xlsx');
    expect(saveFile.mock.calls[0][1]).toBe('Report.xlsx');
  });

  it("says what the route said when it can't make the file, and saves nothing", async () => {
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'That account has nothing in these books' }), { status: 404 }));
    await render().download(URL1, 'Report.xlsx');
    apiFetch.mockResolvedValueOnce(xlsx(null, 502, 'Bad gateway'));
    await render().download(URL1, 'Report.xlsx');
    apiFetch.mockRejectedValueOnce(new Error('Load failed'));
    await render().download(URL1, 'Report.xlsx');
    expect(errors).toEqual(['That account has nothing in these books', 'The download failed (502)', 'Load failed']);
    expect(saveFile).not.toHaveBeenCalled();
    expect(render().busy).toBe(false);
  });

  it('keeps the file for one more tap when Safari wants a fresh one, without making it again', async () => {
    apiFetch.mockResolvedValueOnce(xlsx('BMG Balance Sheet 2026-09-30.xlsx'));
    saveFile.mockRejectedValueOnce(refused());
    await render().download(URL1, 'Report.xlsx');
    expect(errors).toEqual([]);
    expect(render().ready(URL1)).toBe(true);
    expect(render().ready(`${URL1}&x=1`)).toBe(false);

    saveFile.mockResolvedValueOnce(undefined);
    await render().download(URL1, 'Report.xlsx');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(saveFile.mock.calls.map((c) => c[1])).toEqual(['BMG Balance Sheet 2026-09-30.xlsx', 'BMG Balance Sheet 2026-09-30.xlsx']);
    expect(saveFile.mock.calls[1][0]).toBe(saveFile.mock.calls[0][0]);
    expect(render().ready(URL1)).toBe(false);
  });

  it('makes a fresh file for different months, and any other save failure is an error', async () => {
    apiFetch.mockResolvedValueOnce(xlsx('a.xlsx'));
    saveFile.mockRejectedValueOnce(refused());
    await render().download(URL1, 'Report.xlsx');
    apiFetch.mockResolvedValueOnce(xlsx('b.xlsx'));
    saveFile.mockRejectedValueOnce(new Error('No space left'));
    await render().download(`${URL1}&x=1`, 'Report.xlsx');
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(errors).toEqual(['No space left']);
  });
});
