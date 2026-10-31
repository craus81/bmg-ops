import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./supabase-browser', () => ({ createClient: () => ({ auth: { getSession: async () => ({}) } }) }));

import { withFileExtension, nameBlobUrl, blobUrlName, fileNameFromDisposition, saveFile } from './native-files';
import { attachmentDisposition } from './estimate-approval-downloads';

const PDF_HEAD = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

describe('withFileExtension', () => {
  it('keeps a name that already has an ending', () => {
    expect(withFileExtension('Invoice_INV1532.pdf', 'application/pdf')).toBe('Invoice_INV1532.pdf');
    expect(withFileExtension('EST-2610-024.pdf', '')).toBe('EST-2610-024.pdf');
  });

  it('adds .pdf to a PDF named without one (the "File" Save to Files bug)', () => {
    expect(withFileExtension('File', 'application/pdf')).toBe('File.pdf');
    expect(withFileExtension('Pro Forma Invoice', 'application/pdf; charset=binary')).toBe('Pro Forma Invoice.pdf');
  });

  it('tells a PDF by its first bytes when the type is missing', () => {
    expect(withFileExtension('File', '', PDF_HEAD)).toBe('File.pdf');
    expect(withFileExtension('File', 'application/octet-stream', PDF_HEAD)).toBe('File.pdf');
  });

  it('uses the type for images', () => {
    expect(withFileExtension('Photo', 'image/jpeg')).toBe('Photo.jpg');
  });

  it('falls back to File and strips characters Files refuses', () => {
    expect(withFileExtension('', 'application/pdf')).toBe('File.pdf');
    expect(withFileExtension(null, 'application/pdf')).toBe('File.pdf');
    expect(withFileExtension('INV/1532', 'application/pdf')).toBe('INV-1532.pdf');
  });

  it('leaves an unknown type alone', () => {
    expect(withFileExtension('Notes', 'application/x-unknown')).toBe('Notes');
  });
});

describe('blob URL names', () => {
  it('remembers the name a screen gave a blob: URL', () => {
    const url = nameBlobUrl('blob:https://go.bmgfleet.com/abc', 'Invoice_INV1532.pdf');
    expect(url).toBe('blob:https://go.bmgfleet.com/abc');
    expect(blobUrlName(url)).toBe('Invoice_INV1532.pdf');
    expect(blobUrlName('blob:https://go.bmgfleet.com/other')).toBeNull();
  });
});

describe('fileNameFromDisposition', () => {
  it("reads back the name a route's attachment header gives, the UTF-8 one first", () => {
    expect(fileNameFromDisposition(attachmentDisposition('BMG 1200 Receivables 2026-08 to 2026-09.xlsx'))).toBe('BMG 1200 Receivables 2026-08 to 2026-09.xlsx');
    expect(fileNameFromDisposition(attachmentDisposition('Café Report.xlsx'))).toBe('Café Report.xlsx');
    expect(fileNameFromDisposition('attachment; filename="Report.xlsx"')).toBe('Report.xlsx');
    expect(fileNameFromDisposition('attachment; filename=Report.xlsx')).toBe('Report.xlsx');
  });

  it('falls back to the plain name when the UTF-8 one is garbled, and gives null for none', () => {
    expect(fileNameFromDisposition(`attachment; filename="Report.xlsx"; filename*=UTF-8''%E0%A4%A`)).toBe('Report.xlsx');
    expect(fileNameFromDisposition('inline')).toBeNull();
    expect(fileNameFromDisposition('')).toBeNull();
    expect(fileNameFromDisposition(null)).toBeNull();
  });
});

describe('saveFile', () => {
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const blob = () => new Blob(['PK'], { type: XLSX });
  let link: { href: string; download: string; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  let share: ReturnType<typeof vi.fn>;
  let canShare: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    link = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal('document', { createElement: () => link, body: { appendChild: vi.fn() } });
    share = vi.fn(async () => {});
    canShare = true;
    vi.stubGlobal('navigator', { canShare: () => canShare, share });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:https://go.bmgfleet.com/x1');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const inApp = (yes: boolean) => vi.stubGlobal('window', yes ? { Capacitor: { isNativePlatform: () => true } } : {});

  it('downloads the file under its name on a computer, and lets the link go after', async () => {
    inApp(false);
    await saveFile(blob(), 'BMG Balance Sheet 2026-09-30.xlsx');
    expect(share).not.toHaveBeenCalled();
    expect(link).toMatchObject({ href: 'blob:https://go.bmgfleet.com/x1', download: 'BMG Balance Sheet 2026-09-30.xlsx' });
    expect(link.click).toHaveBeenCalledTimes(1);
    expect(link.remove).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:https://go.bmgfleet.com/x1');
  });

  it("hands the file to the iPhone's share sheet in the app, and backing out isn't a failure", async () => {
    inApp(true);
    await saveFile(blob(), 'BMG Balance Sheet 2026-09-30.xlsx');
    expect(share).toHaveBeenCalledTimes(1);
    const shared = share.mock.calls[0][0] as { files: File[]; title: string };
    expect(shared.title).toBe('BMG Balance Sheet 2026-09-30.xlsx');
    expect(shared.files.map((f) => [f.name, f.type])).toEqual([['BMG Balance Sheet 2026-09-30.xlsx', XLSX]]);
    expect(link.click).not.toHaveBeenCalled();

    share.mockRejectedValueOnce(Object.assign(new Error('Share canceled'), { name: 'AbortError' }));
    await expect(saveFile(blob(), 'a.xlsx')).resolves.toBeUndefined();
    // Safari wants a fresh tap: the caller asks for one.
    share.mockRejectedValueOnce(Object.assign(new Error('Not allowed'), { name: 'NotAllowedError' }));
    await expect(saveFile(blob(), 'a.xlsx')).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it("downloads in the app too when the share sheet can't take the file", async () => {
    inApp(true);
    canShare = false;
    await saveFile(blob(), 'Client files.zip');
    expect(share).not.toHaveBeenCalled();
    expect(link).toMatchObject({ download: 'Client files.zip' });
    expect(link.click).toHaveBeenCalledTimes(1);
  });
});
