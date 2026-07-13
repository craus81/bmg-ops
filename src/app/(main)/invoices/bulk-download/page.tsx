'use client';

import { useState } from 'react';
import JSZip from 'jszip';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';

type Customer = {
  id: string;
  company_name: string;
  entity_id: string;
};

type OpenInvoice = {
  id: string;
  tranid: string;
  trandate: string;
  total: number;
  status: string;
};

export default function BulkInvoiceDownloadPage() {
  const { loading: authLoading } = useAuth();

  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);

  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [invoices, setInvoices] = useState<OpenInvoice[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [listError, setListError] = useState<string | null>(null);

  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  if (authLoading) return null;

  const searchCustomers = async () => {
    if (search.trim().length < 2) return;
    setSearching(true);
    setListError(null);
    try {
      const res = await fetch(`/api/netsuite/customers/search?q=${encodeURIComponent(search.trim())}`);
      const data = await res.json();
      setResults(data.results || []);
    } catch {
      setResults([]);
    }
    setSearching(false);
  };

  const pickCustomer = async (c: Customer) => {
    setCustomer(c);
    setResults([]);
    setSearch(c.company_name);
    setInvoices([]);
    setListError(null);
    setDownloadError(null);
    setLoadingInvoices(true);
    try {
      // Page through everything — accounts can have more open invoices than
      // one API page, and a silent cutoff reads as "the app lost invoices".
      let list: OpenInvoice[] = [];
      let offset = 0;
      for (;;) {
        const res = await fetch(`/api/netsuite/customer-invoices?customerId=${c.id}&status=open&limit=1000&offset=${offset}`);
        const data = await res.json();
        if (!data.success) {
          setListError(data.error || 'Failed to load invoices');
          setInvoices([]);
          setSelectedIds(new Set());
          setLoadingInvoices(false);
          return;
        }
        list = [...list, ...(data.transactions || [])];
        if (!data.hasMore) break;
        offset += data.limit;
      }
      setInvoices(list);
      // Default to every invoice selected — matches the prior all-or-
      // nothing behavior; users can deselect what they don't want.
      setSelectedIds(new Set(list.map(i => i.id)));
    } catch (e: any) {
      setListError(e.message || 'Failed to load invoices');
    }
    setLoadingInvoices(false);
  };

  // Fetch each PDF through the quick per-invoice endpoint and assemble the
  // ZIP in the browser. The old approach (one server request fetching every
  // PDF and zipping) hit Vercel's 60s limit around ~50 invoices (504) and
  // had a hard cap; this way there is no cap and no server timeout, and the
  // button can show real progress.
  const downloadZip = async () => {
    if (!customer || selectedIds.size === 0) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const items = invoices.filter(inv => selectedIds.has(inv.id));
      const zip = new JSZip();
      const queue = [...items];
      const failed: string[] = [];
      let done = 0;
      // Small concurrency cap so we don't hammer NetSuite's PDF renderer.
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (;;) {
          const inv = queue.shift();
          if (!inv) return;
          try {
            const res = await fetch(`/api/netsuite/pdf?type=invoice&id=${encodeURIComponent(inv.id)}`);
            const data = await res.json();
            if (!data.success || !data.pdfBase64) throw new Error(data.error || 'PDF fetch failed');
            zip.file(`INV-${inv.tranid}.pdf`, Uint8Array.from(atob(data.pdfBase64), ch => ch.charCodeAt(0)));
          } catch {
            failed.push(inv.tranid);
          }
          done++;
          setDownloadProgress(`Fetching PDFs ${done}/${items.length}…`);
        }
      }));

      if (failed.length === items.length) {
        setDownloadError('Every PDF fetch failed — check that NetSuite is reachable and try again.');
        return;
      }

      setDownloadProgress('Zipping…');
      const blob = await zip.generateAsync({ type: 'blob' });
      const safeName = customer.company_name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'customer';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}-open-invoices.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (failed.length > 0) {
        setDownloadError(`Downloaded ${items.length - failed.length} of ${items.length} — failed: INV #${failed.join(', INV #')}. Retry to fetch just the rest.`);
      }
    } catch (e: any) {
      setDownloadError(e.message || 'Download failed');
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
    }
  };

  const selectedInvoices = invoices.filter(inv => selectedIds.has(inv.id));
  const selectedTotal = selectedInvoices.reduce((sum, inv) => sum + (inv.total || 0), 0);
  const allSelected = invoices.length > 0 && selectedIds.size === invoices.length;

  const toggleOne = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(invoices.map(i => i.id)));
  };

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ fontSize: '22px', fontWeight: 800, margin: '0 0 6px', color: theme.textPrimary }}>
        Download Open Invoices
      </h1>
      <div style={{ fontSize: '13px', color: theme.textMuted, marginBottom: '20px' }}>
        Pick a customer to fetch a single ZIP of every open invoice PDF from NetSuite.
      </div>

      {/* Customer search */}
      <div style={{
        background: theme.card, border: `1px solid ${theme.border}`,
        borderRadius: '14px', padding: '16px', marginBottom: '16px',
      }}>
        <div style={{
          fontSize: '11px', fontWeight: 700, color: theme.textMuted,
          textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px',
        }}>Customer</div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setCustomer(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') searchCustomers(); }}
            placeholder="Search customer name..."
            style={{
              flex: 1, padding: '10px 12px', borderRadius: '10px',
              border: `1px solid ${theme.border}`, background: theme.card,
              color: theme.textPrimary, fontSize: '14px', fontWeight: 600,
            }}
          />
          <button
            onClick={searchCustomers}
            disabled={searching || search.trim().length < 2}
            style={{
              padding: '10px 16px', borderRadius: '10px', background: theme.navy,
              color: '#fff', fontWeight: 700, fontSize: '13px', border: 'none',
              opacity: searching || search.trim().length < 2 ? 0.4 : 1, cursor: 'pointer',
            }}
          >{searching ? '...' : 'Search'}</button>
        </div>

        {results.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '10px' }}>
            {results.map(c => (
              <button
                key={c.id}
                onClick={() => pickCustomer(c)}
                style={{
                  textAlign: 'left', padding: '8px 10px', borderRadius: '8px',
                  background: 'transparent', border: `1px solid ${theme.border}`,
                  color: theme.textPrimary, fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                }}
              >
                {c.company_name}
                <span style={{ color: theme.textMuted, marginLeft: '6px', fontWeight: 500 }}>
                  · {c.entity_id}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Invoice list */}
      {customer && (
        <div style={{
          background: theme.card, border: `1px solid ${theme.border}`,
          borderRadius: '14px', padding: '16px',
        }}>
          {loadingInvoices ? (
            <div style={{ color: theme.textMuted, fontSize: '13px' }}>Loading open invoices…</div>
          ) : listError ? (
            <div style={{
              padding: '8px 12px', background: theme.errorBg, border: `1px solid ${theme.errorBorder}`,
              borderRadius: '10px', color: theme.error, fontSize: '13px',
            }}>{listError}</div>
          ) : invoices.length === 0 ? (
            <div style={{ color: theme.textMuted, fontSize: '13px' }}>
              No open invoices for {customer.company_name}.
            </div>
          ) : (
            <>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginBottom: '12px', gap: '12px',
              }}>
                <button
                  onClick={toggleAll}
                  style={{
                    fontSize: '12px', fontWeight: 700, color: theme.textPrimary,
                    background: 'transparent', border: `1px solid ${theme.border}`,
                    borderRadius: '8px', padding: '6px 10px', cursor: 'pointer',
                  }}
                >
                  {allSelected ? 'Deselect all' : 'Select all'} ({selectedIds.size}/{invoices.length})
                </button>
                <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textPrimary, textAlign: 'right' }}>
                  Selected total: ${selectedTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </div>
              </div>

              <div style={{
                display: 'flex', flexDirection: 'column', gap: '4px',
                maxHeight: '320px', overflowY: 'auto', marginBottom: '12px',
              }}>
                {invoices.map(inv => {
                  const checked = selectedIds.has(inv.id);
                  return (
                    <label key={inv.id} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '8px 10px', borderRadius: '8px', fontSize: '12px',
                      cursor: 'pointer', gap: '10px',
                      background: checked ? theme.subtleBg : 'transparent',
                      border: `1px solid ${checked ? theme.border : 'transparent'}`,
                    }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(inv.id)}
                        style={{ flexShrink: 0, width: '16px', height: '16px', cursor: 'pointer' }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: 700, color: theme.textPrimary }}>INV #{inv.tranid}</span>
                        <span style={{ color: theme.textMuted, marginLeft: '8px' }}>{inv.trandate}</span>
                      </div>
                      <div style={{ fontWeight: 700, color: theme.textPrimary }}>
                        ${(inv.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </div>
                    </label>
                  );
                })}
              </div>

              <button
                onClick={downloadZip}
                disabled={downloading || selectedIds.size === 0}
                style={{
                  width: '100%', padding: '14px', borderRadius: '12px',
                  background: theme.success, color: '#fff', fontWeight: 800,
                  fontSize: '14px', border: 'none', cursor: 'pointer',
                  opacity: (downloading || selectedIds.size === 0) ? 0.6 : 1,
                }}
              >
                {downloading
                  ? (downloadProgress || 'Preparing…')
                  : `Download ${selectedIds.size} invoice${selectedIds.size === 1 ? '' : 's'} as ZIP`}
              </button>

              {downloadError && (
                <div style={{
                  marginTop: '10px', padding: '8px 12px',
                  background: theme.errorBg, border: `1px solid ${theme.errorBorder}`,
                  borderRadius: '10px', color: theme.error, fontSize: '13px',
                }}>{downloadError}</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
