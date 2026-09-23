import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const xhrPut = vi.fn();
vi.mock('./storage', () => ({ SERVER_UPLOAD_LIMIT: 4 * 1024 * 1024, xhrPut: (...a: any[]) => xhrPut(...a) }));

import { uploadRecordFile } from './record-file-upload';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const photo = () => new File([new Uint8Array(10)], 'Proof_1A.jpeg', { type: 'image/jpeg' });

describe('uploadRecordFile', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { xhrPut.mockReset(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('presigns, PUTs directly, then records', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ success: true, uploadUrl: 'https://r2/x', path: 'e1/1-p.jpeg' }))
      .mockResolvedValueOnce(json({ success: true, file: { id: 'f1' } }));
    xhrPut.mockResolvedValue({ ok: true, status: 200, text: '' });
    const res = await uploadRecordFile('/api/x', { prospectId: 'p' }, photo(), { category: 'general' });
    expect(res).toEqual({ file: { id: 'f1' } });
    const record = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(record).toMatchObject({ action: 'record', prospectId: 'p', category: 'general', path: 'e1/1-p.jpeg', size: 10 });
  });

  it('falls back to the route upload when the direct PUT is blocked, and records its path', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ success: true, uploadUrl: 'https://r2/x', path: 'e1/1-p.jpeg' }))
      .mockResolvedValueOnce(json({ success: true, path: 'e1/2-p.jpeg' }))
      .mockResolvedValueOnce(json({ success: true, file: { id: 'f2' } }));
    xhrPut.mockRejectedValue(new TypeError('Load failed'));
    const res = await uploadRecordFile('/api/x', {}, photo());
    expect(res).toEqual({ file: { id: 'f2' } });
    const fd = fetchMock.mock.calls[1][1].body as FormData;
    expect(fd.get('action')).toBe('upload');
    expect((fd.get('file') as File).name).toBe('Proof_1A.jpeg');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).path).toBe('e1/2-p.jpeg');
  });

  it('names the step when storage refuses the PUT', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, uploadUrl: 'https://r2/x', path: 'e1/1-p.jpeg' }));
    xhrPut.mockResolvedValue({ ok: false, status: 403, text: '' });
    expect((await uploadRecordFile('/api/x', {}, photo())).error).toBe('Storage refused the upload (HTTP 403)');
  });

  it('reports a non-JSON server reply as a server error, not a network one', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>oops</html>', { status: 500 }));
    expect((await uploadRecordFile('/api/x', {}, photo())).error).toBe("FleetSuite's server returned an error (HTTP 500)");
  });
});
