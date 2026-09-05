'use client';

/**
 * Open a NetSuite transaction PDF in a new tab from the browser.
 *
 * The window is opened synchronously inside the caller's click handler
 * (popup blockers require a direct user gesture) and pointed at a blob URL
 * once the PDF arrives from /api/netsuite/pdf.
 */
export async function openNetSuitePdf(
  type: 'invoice' | 'salesOrder' | 'estimate',
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  return openResolved(type, async () => id);
}

/**
 * Open an invoice's PDF from its NUMBER (tranid) — for places that only hold
 * the stamped number (fleet_checkins.invoice_number). Resolves the internal
 * id via /api/netsuite/lookup-transaction?type=invoice; a number that is all
 * digits and doesn't resolve is treated as an internal id (the vehicle
 * invoice route stamps the id when NetSuite returns no tranid).
 */
export async function openNetSuiteInvoicePdfByNumber(
  invoiceNumber: string,
): Promise<{ ok: boolean; error?: string }> {
  return openResolved('invoice', async () => {
    const res = await fetch(`/api/netsuite/lookup-transaction?type=invoice&tranid=${encodeURIComponent(invoiceNumber)}`);
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.found && data.match?.id) return String(data.match.id);
    if (/^\d+$/.test(invoiceNumber)) return invoiceNumber;
    throw new Error(data.error || `Invoice ${invoiceNumber} was not found in NetSuite`);
  });
}

async function openResolved(
  type: 'invoice' | 'salesOrder' | 'estimate',
  resolveId: () => Promise<string>,
): Promise<{ ok: boolean; error?: string }> {
  // Open the tab first, inside the click, then fill it — any await before
  // window.open and the popup blocker eats it.
  const w = window.open('about:blank', '_blank');
  try {
    const id = await resolveId();
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
