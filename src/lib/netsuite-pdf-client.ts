'use client';

/**
 * Open a NetSuite transaction PDF in a new tab from the browser.
 *
 * The window is opened synchronously inside the caller's click handler
 * (popup blockers require a direct user gesture) and pointed at a blob URL
 * once the PDF arrives from /api/netsuite/pdf.
 */
export async function openNetSuitePdf(
  type: 'invoice' | 'salesOrder',
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const w = window.open('about:blank', '_blank');
  try {
    const res = await fetch(`/api/netsuite/pdf?type=${type}&id=${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!data.success || !data.pdfBase64) throw new Error(data.error || 'PDF fetch failed');
    const bytes = Uint8Array.from(atob(data.pdfBase64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    if (w) w.location.href = url;
    else window.open(url, '_blank');
    return { ok: true };
  } catch (e: any) {
    w?.close();
    return { ok: false, error: e?.message || 'Could not open the PDF' };
  }
}
