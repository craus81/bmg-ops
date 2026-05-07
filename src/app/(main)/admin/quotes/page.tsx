'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';
import { storage } from '@/lib/storage';
import { theme } from '@/lib/theme';
import type { VehicleTemplate, Quote, QuotePanel, QuoteElement, AIAnalysisResult, GraphicElement, RollNestingResult } from '@/lib/types';
import { applyBleed, nestElementsOnRoll, recalcFromPositions } from '@/lib/nesting-algorithm';

const supabase = createClient();

// ============ Helper: file to base64 ============
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data:xxx;base64, prefix
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ============ Helper: render PDF first page to image ============
async function pdfToImage(file: File, maxWidthPx = 2048, quality = 0.8): Promise<{ base64: string; mediaType: string }> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const page = await pdf.getPage(1);

  // Scale to maxWidthPx
  const unscaledViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(maxWidthPx / unscaledViewport.width, 3); // cap at 3x
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvasContext: ctx, viewport, canvas } as any).promise;

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const base64 = dataUrl.split(',')[1];
  return { base64, mediaType: 'image/jpeg' };
}

// ============ Helper: compress image to fit under size limit ============
async function compressImage(file: File, maxWidthPx = 2048, quality = 0.8): Promise<{ base64: string; mediaType: string }> {
  // Handle PDFs: render first page to image
  if (file.type === 'application/pdf') {
    return pdfToImage(file, maxWidthPx, quality);
  }

  // Non-image files: return base64 as-is
  if (!file.type.startsWith('image/')) {
    const b64 = await fileToBase64(file);
    return { base64: b64, mediaType: file.type || 'application/octet-stream' };
  }

  // Images: resize and compress
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width;
      let h = img.height;
      if (w > maxWidthPx) {
        h = Math.round(h * (maxWidthPx / w));
        w = maxWidthPx;
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const base64 = dataUrl.split(',')[1];
      resolve({ base64, mediaType: 'image/jpeg' });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image for compression')); };
    img.src = url;
  });
}

// ============ Helper: format currency ============
function fmtCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

// ============ Main Page ============
export default function QuotesPage() {
  const searchParams = useSearchParams();
  const { user, isAdmin, isSales } = useAuth();
  const [tab, setTab] = useState<'quotes' | 'templates' | 'new'>('quotes');
  const [editQuote, setEditQuote] = useState<Quote | null>(null);

  // Auto-open quote from URL param (deep link from notifications/search)
  useEffect(() => {
    const quoteId = searchParams.get('id');
    if (quoteId) {
      (async () => {
        const { data } = await supabase
          .from('quotes')
          .select('*, template:vehicle_templates(*)')
          .eq('id', quoteId)
          .maybeSingle();
        if (data) {
          setEditQuote(data as Quote);
          setTab('new');
        }
      })();
    }
  }, [searchParams]);

  if (!isAdmin && !isSales) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px', color: theme.textSecondary }}>
        <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '12px' }}>Access Restricted</div>
        <div style={{ fontSize: '16px', fontWeight: 700 }}>Admin Only</div>
      </div>
    );
  }

  const tabs = [
    { id: 'quotes' as const, label: 'Quotes' },
    { id: 'new' as const, label: '+ New Quote' },
    { id: 'templates' as const, label: 'Templates' },
  ];

  return (
    <div>
      <div style={{ marginBottom: '20px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 800, color: theme.textPrimary, margin: 0 }}>
          Estimating
        </h1>
        <p style={{ fontSize: '13px', color: theme.textSecondary, margin: '4px 0 0' }}>
          AI-powered vinyl wrap quoting
        </p>
      </div>

      {/* Tab Bar */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', background: theme.inputBg, borderRadius: '12px', padding: '4px' }}>
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              flex: 1, padding: '10px 8px', borderRadius: '10px', border: 'none', fontSize: '13px', fontWeight: 700,
              background: tab === t.id ? theme.tabActiveBg : 'transparent',
              color: tab === t.id ? theme.tabActiveColor : theme.textSecondary,
              cursor: 'pointer', transition: 'all 0.2s',
            }}
          >{t.label}</button>
        ))}
      </div>

      {tab === 'quotes' && <QuotesList onEdit={(q) => { setEditQuote(q); setTab('new'); }} />}
      {tab === 'new' && <NewQuote editQuote={editQuote} onCreated={() => { setEditQuote(null); setTab('quotes'); }} />}
      {tab === 'templates' && <TemplatesManager />}
    </div>
  );
}

// ============ Quotes List ============
function QuotesList({ onEdit }: { onEdit: (q: Quote) => void }) {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewQuote, setViewQuote] = useState<Quote | null>(null);

  useEffect(() => {
    loadQuotes();
  }, []);

  async function loadQuotes() {
    setLoading(true);
    const { data } = await supabase
      .from('quotes')
      .select('*, template:vehicle_templates(*)')
      .order('created_at', { ascending: false });
    setQuotes((data as Quote[]) || []);
    setLoading(false);
  }

  if (loading) return <LoadingSpinner />;

  if (viewQuote) {
    return <QuoteDetail quote={viewQuote} onBack={() => { setViewQuote(null); loadQuotes(); }} onEdit={(q) => { setViewQuote(null); onEdit(q); }} />;
  }

  if (quotes.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 20px', color: theme.textSecondary }}>
        <div style={{ fontSize: '15px', fontWeight: 600 }}>No quotes yet</div>
        <div style={{ fontSize: '13px', marginTop: '4px' }}>Create your first quote using the &quot;+ New Quote&quot; tab</div>
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    draft: theme.warning,
    sent: 'var(--navy)',
    accepted: theme.success,
    declined: theme.error,
    expired: theme.textMuted,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {quotes.map(q => (
        <button
          key={q.id}
          onClick={() => setViewQuote(q)}
          style={{
            background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px',
            padding: '14px 16px', cursor: 'pointer', textAlign: 'left', width: '100%',
            transition: 'all 0.15s',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: theme.textPrimary }}>{q.quote_number}</div>
              <div style={{ fontSize: '13px', color: theme.textSecondary, marginTop: '2px' }}>{q.customer_name}</div>
              <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '2px' }}>
                {q.vehicle_description}
                {(q as any).vehicle_qty > 1 && <span style={{ marginLeft: '6px', padding: '1px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 800, background: theme.navy + '20', color: theme.navy }}>×{(q as any).vehicle_qty}</span>}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{
                display: 'inline-block', padding: '3px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 700,
                background: statusColors[q.status] + '20', color: statusColors[q.status],
                textTransform: 'uppercase',
              }}>{q.status}</div>
              <div style={{ fontSize: '16px', fontWeight: 800, color: theme.textPrimary, marginTop: '6px' }}>
                {fmtCurrency(q.total_price)}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '16px', marginTop: '8px', fontSize: '12px', color: theme.textMuted }}>
            <span>{q.total_vinyl_sqft?.toFixed(1)} sq ft</span>
            <span>{q.coverage_percentage?.toFixed(0)}% coverage</span>
            <span>{new Date(q.created_at).toLocaleDateString()}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

// ============ Quote Detail View ============
function QuoteDetail({ quote, onBack, onEdit }: { quote: Quote; onBack: () => void; onEdit: (q: Quote) => void }) {
  const { user } = useAuth();
  const [panels, setPanels] = useState<QuotePanel[]>([]);
  const [elements, setElements] = useState<QuoteElement[]>([]);
  const [loading, setLoading] = useState(true);
  const [proofUrl, setProofUrl] = useState<string | null>(null);

  // NetSuite push state
  const [custSearch, setCustSearch] = useState('');
  const [custResults, setCustResults] = useState<{ id: string; netsuite_id: string; company_name: string; entity_id: string }[]>([]);
  const [showCustDrop, setShowCustDrop] = useState(false);
  const [selectedCustId, setSelectedCustId] = useState<string | null>((quote as any).customer_id || null);
  const [selectedCustNsId, setSelectedCustNsId] = useState<string | null>((quote as any).customer_netsuite_id || null);
  const [selectedCustName, setSelectedCustName] = useState<string>('');
  const [pushing, setPushing] = useState(false);
  const isPushed = !!(quote as any).netsuite_estimate_id;

  useEffect(() => {
    loadPanels();
    if (quote.proof_image_path) {
      const { data } = storage.from('quote-proofs').getPublicUrl(quote.proof_image_path);
      setProofUrl(data.publicUrl);
    }
    // Load linked customer name if already set
    if ((quote as any).customer_id) {
      supabase.from('customers').select('company_name, netsuite_id').eq('id', (quote as any).customer_id).single().then(({ data }: any) => {
        if (data) {
          setSelectedCustName(data.company_name);
          setSelectedCustNsId(data.netsuite_id);
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [quote]);

  // Customer search
  useEffect(() => {
    if (custSearch.length < 2) { setCustResults([]); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('customers')
        .select('id, netsuite_id, company_name, entity_id')
        .or(`company_name.ilike.%${custSearch}%,entity_id.ilike.%${custSearch}%`)
        .limit(8);
      setCustResults(data || []);
    }, 300);
    return () => clearTimeout(t);
  }, [custSearch]);

  async function loadPanels() {
    if (quote.analysis_version === 'individual_elements') {
      const { data } = await supabase
        .from('quote_elements')
        .select('*')
        .eq('quote_id', quote.id)
        .order('sort_order');
      setElements((data as QuoteElement[]) || []);
    } else {
      const { data } = await supabase
        .from('quote_panels')
        .select('*')
        .eq('quote_id', quote.id)
        .order('sort_order');
      setPanels((data as QuotePanel[]) || []);
    }
    setLoading(false);
  }

  async function updateStatus(status: string) {
    await supabase.from('quotes').update({ status, updated_at: new Date().toISOString() }).eq('id', quote.id);
    quote.status = status as Quote['status'];
    onBack();
  }

  async function pushToNetSuite() {
    if (!selectedCustNsId) { alert('Please select a customer first'); return; }
    if (!window.confirm('Push this quote to NetSuite as an Estimate?')) return;
    setPushing(true);
    try {
      const res = await fetch('/api/quotes/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId: quote.id,
          customerId: selectedCustId,
          customerNsId: selectedCustNsId,
          userId: user?.id,
        }),
      });
      const data = await res.json();
      if (data.success) {
        alert(`Pushed to NetSuite!\nEstimate #: ${data.netsuite_estimate_number || data.netsuite_estimate_id}`);
        onBack();
      } else {
        alert('Push failed: ' + (data.error || 'Unknown error'));
      }
    } catch {
      alert('Network error — please try again');
    }
    setPushing(false);
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: theme.orange, fontSize: '14px', fontWeight: 700, cursor: 'pointer', padding: 0 }}>
          ← Back to Quotes
        </button>
        <button
          onClick={() => onEdit(quote)}
          style={{
            background: theme.navy, color: '#fff', border: 'none', borderRadius: '8px',
            padding: '8px 16px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
          }}
        >
          Edit Quote
        </button>
      </div>

      {/* Header */}
      <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: theme.textPrimary }}>{quote.quote_number}</div>
            <div style={{ fontSize: '14px', color: theme.textSecondary, marginTop: '2px' }}>{quote.customer_name}</div>
            <div style={{ fontSize: '13px', color: theme.textMuted }}>
              {quote.vehicle_description}
              {(quote as any).vehicle_qty > 1 && <span style={{ marginLeft: '6px', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 800, background: theme.navy + '20', color: theme.navy }}>×{(quote as any).vehicle_qty} vehicles</span>}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '24px', fontWeight: 800, color: theme.orange }}>{fmtCurrency(quote.total_price)}</div>
            {(quote as any).vehicle_qty > 1 && <div style={{ fontSize: '12px', color: theme.textMuted }}>{fmtCurrency(quote.total_price / (quote as any).vehicle_qty)}/vehicle</div>}
          </div>
        </div>

        {/* Status Actions */}
        <div style={{ display: 'flex', gap: '6px', marginTop: '12px' }}>
          {['draft', 'sent', 'accepted', 'declined'].map(s => (
            <button
              key={s}
              onClick={() => updateStatus(s)}
              style={{
                flex: 1, padding: '8px', borderRadius: '8px', border: `1px solid ${theme.border}`,
                fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', cursor: 'pointer',
                background: quote.status === s ? theme.navy : 'transparent',
                color: quote.status === s ? '#fff' : theme.textMuted,
              }}
            >{s}</button>
          ))}
        </div>
      </div>

      {/* Proof Image */}
      {proofUrl && (
        <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '12px', marginBottom: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textSecondary, marginBottom: '8px' }}>Proof Design</div>
          <img src={proofUrl} alt="Proof" style={{ width: '100%', borderRadius: '8px' }} />
        </div>
      )}

      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
        {[
          { label: 'Roll Material', value: `${quote.total_vinyl_sqft?.toFixed(1)} sq ft` },
          { label: 'Coverage', value: `${quote.coverage_percentage?.toFixed(0)}%` },
          { label: 'Material', value: fmtCurrency(quote.material_total) },
          { label: 'Labor', value: fmtCurrency(quote.labor_total) },
          { label: 'Subtotal', value: fmtCurrency(quote.subtotal) },
          { label: 'Profit Margin', value: `${quote.markup_percentage}%` },
        ].map(item => (
          <div key={item.label} style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '12px' }}>
            <div style={{ fontSize: '11px', color: theme.textMuted, fontWeight: 600 }}>{item.label}</div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: theme.textPrimary }}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* Elements or Panel Breakdown */}
      {quote.analysis_version === 'individual_elements' ? (
        <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, marginBottom: '12px' }}>Graphic Elements</div>
          {loading ? <LoadingSpinner /> : elements.map((el, i) => (
            <div key={el.id} style={{ padding: '10px 0', borderBottom: i < elements.length - 1 ? `1px solid ${theme.border}` : 'none' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{el.element_name}</div>
                  <div style={{ fontSize: '11px', background: theme.subtleBg, color: theme.textMuted, fontWeight: 600, marginTop: '2px', padding: '2px 6px', borderRadius: '4px', display: 'inline-block' }}>
                    {el.element_type}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textPrimary }}>{el.width_in?.toFixed(1)}" × {el.height_in?.toFixed(1)}"</div>
                  <div style={{ fontSize: '12px', color: theme.textMuted }}>{((el.width_in || 0) * (el.height_in || 0)).toFixed(1)} sq in</div>
                </div>
              </div>
              {el.description && (
                <div style={{ marginTop: '6px', padding: '8px 10px', background: theme.subtleBg, borderRadius: '6px', fontSize: '12px', color: theme.textSecondary, borderLeft: `3px solid ${theme.orange}` }}>
                  {el.description}
                </div>
              )}
              {el.nested_x_in !== null && el.nested_y_in !== null && (
                <div style={{ marginTop: '4px', fontSize: '11px', color: theme.textMuted }}>
                  Positioned at: {el.nested_x_in.toFixed(1)}", {el.nested_y_in.toFixed(1)}"
                </div>
              )}
            </div>
          ))}
          {quote.notes && (
            <div style={{ marginTop: '12px', padding: '10px', background: theme.subtleBg, borderRadius: '8px', fontSize: '13px', color: theme.textSecondary }}>
              <strong>AI Notes:</strong> {quote.notes}
            </div>
          )}
        </div>
      ) : (
        <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, marginBottom: '12px' }}>Panel Breakdown</div>
          {loading ? <LoadingSpinner /> : panels.map(p => (
            <div key={p.id} style={{ padding: '10px 0', borderBottom: `1px solid ${theme.border}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{p.panel_name}</div>
                  <div style={{ fontSize: '12px', color: theme.textMuted }}>{p.vinyl_type} • {p.panel_area_sqft?.toFixed(1)} sq ft panel</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '15px', fontWeight: 800, color: theme.orange }}>{p.vinyl_sqft?.toFixed(1)} sq ft</div>
                  <div style={{ fontSize: '12px', color: theme.textMuted }}>{p.vinyl_coverage_pct?.toFixed(0)}% covered</div>
                </div>
              </div>
              {/* Coverage bar */}
              <div style={{ marginTop: '6px', height: '6px', borderRadius: '3px', background: theme.progressTrack, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(p.vinyl_coverage_pct, 100)}%`, background: theme.orange, borderRadius: '3px', transition: 'width 0.3s' }} />
              </div>
            </div>
          ))}
          {quote.notes && (
            <div style={{ marginTop: '12px', padding: '10px', background: theme.subtleBg, borderRadius: '8px', fontSize: '13px', color: theme.textSecondary }}>
              <strong>AI Notes:</strong> {quote.notes}
            </div>
          )}
        </div>
      )}

      {/* ══════ PUSH TO NETSUITE SECTION ══════ */}
      <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px', marginTop: '12px' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, marginBottom: '10px' }}>
          Push to NetSuite
        </div>

        {isPushed ? (
          <div style={{ padding: '12px', borderRadius: '10px', background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)', textAlign: 'center' }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#a78bfa', marginBottom: '4px' }}>
              Already Pushed to NetSuite
            </div>
            <div style={{ fontSize: '11px', color: theme.textMuted }}>
              NS Estimate #: {(quote as any).netsuite_estimate_number || (quote as any).netsuite_estimate_id || 'N/A'}
            </div>
            {(quote as any).pushed_at && (
              <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '2px' }}>
                Pushed: {new Date((quote as any).pushed_at).toLocaleString()}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Customer Selection */}
            <div style={{ marginBottom: '10px', position: 'relative' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '4px' }}>
                Link NetSuite Customer
              </div>
              {selectedCustName ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{
                    flex: 1, padding: '8px 10px', borderRadius: '8px',
                    background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
                    color: theme.textPrimary, fontSize: '12px', fontWeight: 700,
                  }}>
                    {selectedCustName}
                    {selectedCustNsId && <span style={{ color: theme.textMuted, fontWeight: 400, marginLeft: '6px' }}>NS #{selectedCustNsId}</span>}
                  </div>
                  <button
                    onClick={() => { setSelectedCustId(null); setSelectedCustNsId(null); setSelectedCustName(''); setCustSearch(''); }}
                    style={{ padding: '6px 10px', borderRadius: '6px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                  >
                    Change
                  </button>
                </div>
              ) : (
                <div>
                  <input
                    placeholder="Search customers..."
                    value={custSearch}
                    onChange={e => { setCustSearch(e.target.value); setShowCustDrop(true); }}
                    onFocus={() => setShowCustDrop(true)}
                    style={{
                      width: '100%', padding: '8px 10px', borderRadius: '8px',
                      border: `1px solid ${theme.border}`, background: theme.inputBg,
                      color: theme.textPrimary, fontSize: '12px',
                    }}
                  />
                  {showCustDrop && custResults.length > 0 && (
                    <div style={{
                      position: 'absolute', left: 0, right: 0, zIndex: 50,
                      background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '8px',
                      maxHeight: '200px', overflowY: 'auto', marginTop: '2px',
                    }}>
                      {custResults.map(c => (
                        <button
                          key={c.id}
                          onClick={() => {
                            setSelectedCustId(c.id);
                            setSelectedCustNsId(c.netsuite_id);
                            setSelectedCustName(c.company_name);
                            setCustSearch('');
                            setShowCustDrop(false);
                          }}
                          style={{
                            width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none',
                            background: 'transparent', color: theme.textPrimary, fontSize: '12px',
                            cursor: 'pointer', borderBottom: `1px solid ${theme.border}`,
                          }}
                        >
                          <div style={{ fontWeight: 700 }}>{c.company_name}</div>
                          <div style={{ fontSize: '10px', color: theme.textMuted }}>{c.entity_id} · NS #{c.netsuite_id}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              onClick={pushToNetSuite}
              disabled={pushing || !selectedCustNsId}
              style={{
                width: '100%', padding: '12px', borderRadius: '10px',
                background: pushing ? theme.subtleBg : (!selectedCustNsId ? theme.subtleBg : 'rgba(167,139,250,0.15)'),
                border: `1px solid ${!selectedCustNsId ? theme.border : 'rgba(167,139,250,0.3)'}`,
                color: !selectedCustNsId ? theme.textMuted : '#a78bfa',
                fontWeight: 800, fontSize: '13px', cursor: !selectedCustNsId ? 'default' : 'pointer',
                opacity: pushing ? 0.5 : 1,
              }}
            >
              {pushing ? 'Pushing to NetSuite...' : 'Push to NetSuite as Estimate'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ============ New Quote Creator ============
function NewQuote({ onCreated, editQuote }: { onCreated: () => void; editQuote?: Quote | null }) {
  const { user } = useAuth();
  const [step, setStep] = useState(1);

  // Step 1: Customer + Vehicle
  const [customerName, setCustomerName] = useState('');
  const [templates, setTemplates] = useState<VehicleTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<VehicleTemplate | null>(null);
  const [templateSearch, setTemplateSearch] = useState('');

  // Step 2: Proof Upload
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofPreview, setProofPreview] = useState<string | null>(null);
  const [proofLibrary, setProofLibrary] = useState<{ url: string; path: string; customer: string; vehicle: string; quoteNum: string }[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [templateOnly, setTemplateOnly] = useState(false); // Full wrap — no proof needed

  // Step 3: AI Analysis
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<AIAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState('');
  const [templatePreviewUrl, setTemplatePreviewUrl] = useState<string | null>(null);
  const [proofPreviewForReview, setProofPreviewForReview] = useState<string | null>(null);

  // Step 4: Pricing
  const [materialRate, setMaterialRate] = useState(2.50);
  const [laborRate, setLaborRate] = useState(4.00);
  const [marginPct, setMarginPct] = useState(20);

  // Element-based quoting
  const [wastePct, setWastePct] = useState(15);
  const [vehicleQty, setVehicleQty] = useState(1);
  const [nestingResult, setNestingResult] = useState<RollNestingResult | null>(null);
  const [elementCrops, setElementCrops] = useState<Record<string, string>>({});
  const [includedElements, setIncludedElements] = useState<Set<string>>(new Set());
  const [hoveredElement, setHoveredElement] = useState<string | null>(null);
  const [selectedBboxIdx, setSelectedBboxIdx] = useState<number | null>(null);

  // Bounding box drag/resize state (Step 4)
  const [bboxDragging, setBboxDragging] = useState<{ idx: number; mode: 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'; startX: number; startY: number; origBox: { x: number; y: number; w: number; h: number } } | null>(null);

  // Touch state for bbox interactions
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [touchDragging, setTouchDragging] = useState(false);
  const pinchStartDist = useRef<number | null>(null);
  const pinchStartSpread = useRef<{ dx: number; dy: number } | null>(null);
  const pinchStartBox = useRef<{ w: number; h: number; x: number; y: number } | null>(null);
  const pinchIdx = useRef<number | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const touchStartTime = useRef<number>(0);
  const touchMovedEnough = useRef(false);

  // Calibration regions — maps panel edges on proof image to known dimensions
  const [calibrationRegions, setCalibrationRegions] = useState<{
    panel_name: string;
    width_in: number;
    height_in: number;
    img_x_pct: number;
    img_y_pct: number;
    img_w_pct: number;
    img_h_pct: number;
    in_per_pct_x: number; // inches per 1% of image width
    in_per_pct_y: number; // inches per 1% of image height
  }[]>([]);

  // Draw new manual element state
  const [drawingNewElement, setDrawingNewElement] = useState(false);
  const [newElementStart, setNewElementStart] = useState<{ x: number; y: number } | null>(null);
  const [newElementEnd, setNewElementEnd] = useState<{ x: number; y: number } | null>(null);

  // Calibration mode — user draws a box on a known panel to set the scale
  const [calibrationMode, setCalibrationMode] = useState(false);
  const [pendingCalibrationBox, setPendingCalibrationBox] = useState<{ xPct: number; yPct: number; wPct: number; hPct: number } | null>(null);

  // Zoom level for the proof image during calibration / element drawing
  const [proofZoom, setProofZoom] = useState(1);

  // Click-to-enlarge lightbox for the small template/proof reference thumbnails
  const [enlargedRef, setEnlargedRef] = useState<{ src: string; label: string } | null>(null);

  // Drag-and-drop state for nesting diagram
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const nestingSvgRef = useRef<SVGSVGElement>(null);

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadTemplates();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, []);

  useEffect(() => {
    if (step !== 4) return;
    if (templatePreviewUrl) return;
    if (!selectedTemplate) return;
    const imgPath = selectedTemplate.template_image_path || selectedTemplate.original_file_path;
    if (!imgPath) return;
    const { data } = storage.from('vehicle-templates').getPublicUrl(imgPath);
    const publicUrl = data.publicUrl;
    if (imgPath.toLowerCase().endsWith('.pdf')) {
      (async () => {
        try {
          const resp = await fetch(publicUrl);
          const blob = await resp.blob();
          const file = new File([blob], 'template.pdf', { type: 'application/pdf' });
          const { base64, mediaType } = await pdfToImage(file, 1200, 0.9);
          setTemplatePreviewUrl(`data:${mediaType};base64,${base64}`);
        } catch (err) {
          console.error('Failed to render template PDF on calibrate:', err);
        }
      })();
    } else {
      setTemplatePreviewUrl(publicUrl);
    }
  }, [step, templatePreviewUrl, selectedTemplate]);

  useEffect(() => {
    const proofSrc = proofPreviewForReview || proofPreview;
    if (!proofSrc) return;
    const elements = analysis?.graphic_elements;
    if (!elements?.length) return;
    const missing = elements.filter(el =>
      el.crop_w_pct != null && el.crop_h_pct != null &&
      el.crop_x_pct != null && el.crop_y_pct != null &&
      el.crop_w_pct > 0 && el.crop_h_pct > 0 &&
      !elementCrops[el.element_name]
    );
    if (missing.length === 0) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      if (!W || !H) return;
      const next: Record<string, string> = {};
      for (const el of missing) {
        const sx = (el.crop_x_pct! / 100) * W;
        const sy = (el.crop_y_pct! / 100) * H;
        const sw = (el.crop_w_pct! / 100) * W;
        const sh = (el.crop_h_pct! / 100) * H;
        if (sw < 2 || sh < 2) continue;
        const canvas = document.createElement('canvas');
        const maxDim = 400;
        const scale = Math.min(1, maxDim / Math.max(sw, sh));
        canvas.width = Math.max(1, Math.round(sw * scale));
        canvas.height = Math.max(1, Math.round(sh * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        try {
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
          next[el.element_name] = canvas.toDataURL('image/jpeg', 0.85);
        } catch (err) {
          console.error('Failed to backfill crop for', el.element_name, err);
        }
      }
      if (Object.keys(next).length > 0) {
        setElementCrops(prev => ({ ...next, ...prev }));
      }
    };
    img.onerror = (err) => console.error('Backfill: proof image failed to load', err);
    img.src = proofSrc;
  }, [analysis, proofPreviewForReview, proofPreview, elementCrops]);

  async function loadTemplates() {
    const { data } = await supabase
      .from('vehicle_templates')
      .select('*')
      .order('make, model, year');
    setTemplates((data as VehicleTemplate[]) || []);

    // If editing, select the matching template
    if (editQuote?.template_id && data) {
      const match = (data as VehicleTemplate[]).find(t => t.id === editQuote.template_id);
      if (match) setSelectedTemplate(match);
    }
  }

  // Load proof library from saved quotes
  async function loadProofLibrary() {
    setLoadingLibrary(true);
    const { data } = await supabase
      .from('quotes')
      .select('quote_number, customer_name, vehicle_description, proof_image_path')
      .not('proof_image_path', 'is', null)
      .order('created_at', { ascending: false });

    if (data) {
      const proofs = data
        .filter((q: any) => q.proof_image_path)
        .map((q: any) => {
          const { data: urlData } = storage.from('quote-proofs').getPublicUrl(q.proof_image_path);
          return {
            url: urlData.publicUrl,
            path: q.proof_image_path,
            customer: q.customer_name || '',
            vehicle: q.vehicle_description || '',
            quoteNum: q.quote_number || '',
          };
        });
      setProofLibrary(proofs);
    }
    setLoadingLibrary(false);
  }

  // Select a proof from the library
  async function selectLibraryProof(proof: typeof proofLibrary[0]) {
    // Fetch the image and create a File object so it works with existing analysis flow
    try {
      const response = await fetch(proof.url);
      const blob = await response.blob();
      const ext = proof.path.split('.').pop() || 'png';
      const file = new File([blob], `library-proof.${ext}`, { type: blob.type });
      setProofFile(file);
      setProofPreview(proof.url);
    } catch {
      alert('Could not load proof image');
    }
  }

  // Hydrate state when editing an existing quote
  useEffect(() => {
    if (!editQuote) return;

    // Step 1: Customer
    setCustomerName(editQuote.customer_name || '');

    // Step 3: AI Analysis result
    if (editQuote.ai_analysis) {
      setAnalysis(editQuote.ai_analysis);
      // When loading existing quote, include all elements (user already selected them)
      if (editQuote.ai_analysis.graphic_elements?.length) {
        setIncludedElements(new Set(editQuote.ai_analysis.graphic_elements.map((e: GraphicElement) => e.element_name)));
      }
    }

    // Step 4: Pricing
    setMaterialRate(editQuote.material_cost_per_sqft || 2.50);
    setLaborRate(editQuote.labor_cost_per_sqft || 4.00);
    setMarginPct(editQuote.markup_percentage || 20);

    // Nesting result and vehicle quantity
    if (editQuote.nesting_result) {
      setNestingResult(editQuote.nesting_result);
    }
    if ((editQuote as any).vehicle_qty) {
      setVehicleQty((editQuote as any).vehicle_qty);
    }

    // Proof image from storage
    if (editQuote.proof_image_path) {
      const { data } = storage.from('quote-proofs').getPublicUrl(editQuote.proof_image_path);
      setProofPreview(data.publicUrl);
      setProofPreviewForReview(data.publicUrl);
    }

    // Jump to step 5 (review/price) so they can see everything and navigate back
    setStep(5);
  }, [editQuote]);

  // Toggle element inclusion
  function toggleElement(elementName: string) {
    setIncludedElements(prev => {
      const next = new Set(prev);
      if (next.has(elementName)) {
        next.delete(elementName);
      } else {
        next.add(elementName);
      }
      return next;
    });
  }

  // Get only the included elements
  function getIncludedElements(elements: GraphicElement[]): GraphicElement[] {
    return elements.filter(el => includedElements.has(el.element_name));
  }

  // Finalize a manually drawn new element box
  function finalizeNewElement(imgEl: HTMLImageElement, sx: number, sy: number, sw: number, sh: number) {
    if (sw < 5 || sh < 5) return;
    const rect = imgEl.getBoundingClientRect();
    const xPct = (sx / rect.width) * 100;
    const yPct = (sy / rect.height) * 100;
    const wPct = (sw / rect.width) * 100;
    const hPct = (sh / rect.height) * 100;

    // In calibration mode, store as pending calibration box for panel selection
    if (calibrationMode) {
      setPendingCalibrationBox({ xPct, yPct, wPct, hPct });
      return;
    }

    if (!analysis) return;
    const dims = boxPctToInches(wPct, hPct, xPct, yPct);
    const nextNum = (analysis.graphic_elements?.length || 0) + 1;
    const newEl: GraphicElement = {
      element_name: `Element ${nextNum}`,
      element_type: 'custom',
      width_in: dims?.width_in || 0,
      height_in: dims?.height_in || 0,
      description: '',
      crop_x_pct: xPct,
      crop_y_pct: yPct,
      crop_w_pct: wPct,
      crop_h_pct: hPct,
    };
    const updatedElements = [...(analysis.graphic_elements || []), newEl];
    setAnalysis({ ...analysis, graphic_elements: updatedElements });
    setIncludedElements(prev => new Set(prev).add(newEl.element_name));
    setSelectedBboxIdx(updatedElements.length - 1);
    cropFromProof(newEl.element_name, imgEl, sx, sy, sw, sh);
  }

  // Place a default-position box on the image for an AI-detected element
  function placeElement(idx: number) {
    if (!analysis?.graphic_elements) return;
    const el = analysis.graphic_elements[idx];

    // Try to find the calibration region for this element's panel
    const panelName = (el.panel || '').toLowerCase();
    const region = calibrationRegions.find(r =>
      r.panel_name.toLowerCase() === panelName ||
      panelName.includes(r.panel_name.toLowerCase()) ||
      r.panel_name.toLowerCase().includes(panelName)
    );

    let wPct: number, hPct: number, xPct: number, yPct: number;

    if (region && el.width_in && el.height_in) {
      // Use calibration to convert estimated inches to image percentage
      wPct = Math.min(el.width_in / region.in_per_pct_x, region.img_w_pct * 0.9);
      hPct = Math.min(el.height_in / region.in_per_pct_y, region.img_h_pct * 0.9);
      // Center within the calibration region
      xPct = region.img_x_pct + (region.img_w_pct - wPct) / 2;
      yPct = region.img_y_pct + (region.img_h_pct - hPct) / 2;
    } else {
      // Default: reasonable box centered in image
      wPct = 20;
      hPct = 15;
      xPct = 40;
      yPct = 42;
    }

    // Stagger slightly so multiple placed boxes don't stack exactly
    const placedCount = analysis.graphic_elements.filter(
      (e, i) => i < idx && e.crop_x_pct !== undefined
    ).length;
    xPct = Math.max(0, Math.min(100 - wPct, xPct + (placedCount % 3) * 3));
    yPct = Math.max(0, Math.min(100 - hPct, yPct + Math.floor(placedCount / 3) * 3));

    el.crop_x_pct = xPct;
    el.crop_y_pct = yPct;
    el.crop_w_pct = wPct;
    el.crop_h_pct = hPct;

    setAnalysis({ ...analysis });
    setIncludedElements(prev => new Set(prev).add(el.element_name));
    setSelectedBboxIdx(idx);
  }

  // Remove a placed box from an element (undo placement)
  function removeElementBox(idx: number) {
    if (!analysis?.graphic_elements) return;
    const el = analysis.graphic_elements[idx];

    el.crop_x_pct = undefined;
    el.crop_y_pct = undefined;
    el.crop_w_pct = undefined;
    el.crop_h_pct = undefined;

    setAnalysis({ ...analysis });
    setIncludedElements(prev => {
      const next = new Set(prev);
      next.delete(el.element_name);
      return next;
    });
    if (selectedBboxIdx === idx) setSelectedBboxIdx(null);
  }

  // Enter the draw step — prepare proof image and initialize empty analysis
  async function enterDrawStep() {
    if (!selectedTemplate) return;

    // Prepare proof image for display (handles PDF rendering + compression)
    if (proofFile && !proofPreviewForReview) {
      try {
        const compressed = await compressImage(proofFile, 2048, 0.8);
        setProofPreviewForReview(`data:${compressed.mediaType};base64,${compressed.base64}`);
      } catch {
        // proofPreview fallback will be used
      }
    }

    // Load template image for calibration reference
    if (!templatePreviewUrl) {
      const imgPath = selectedTemplate.template_image_path || selectedTemplate.original_file_path;
      if (imgPath) {
        const { data } = storage.from('vehicle-templates').getPublicUrl(imgPath);
        const publicUrl = data.publicUrl;

        // If the template file is a PDF, render its first page to an image
        if (imgPath.toLowerCase().endsWith('.pdf')) {
          try {
            const resp = await fetch(publicUrl);
            const blob = await resp.blob();
            const file = new File([blob], 'template.pdf', { type: 'application/pdf' });
            const { base64, mediaType } = await pdfToImage(file, 1200, 0.9);
            setTemplatePreviewUrl(`data:${mediaType};base64,${base64}`);
          } catch (err) {
            console.error('Failed to render template PDF:', err);
            // Fallback: won't show, but that's OK
          }
        } else {
          setTemplatePreviewUrl(publicUrl);
        }
      }
    }

    // Initialize empty analysis if none exists
    if (!analysis || !analysis.graphic_elements) {
      setAnalysis({
        graphic_elements: [],
        total_vinyl_sqft: 0,
        total_vehicle_sqft: selectedTemplate.panel_data?.reduce((sum, p) => sum + (p.area_sqft || 0), 0) || 0,
        overall_coverage_pct: 0,
        confidence: 'manual',
        notes: 'Manual element measurement',
      });
    }

    setCalibrationMode(calibrationRegions.length === 0);
    setPendingCalibrationBox(null);
    setDrawingNewElement(true);
    setTemplateOnly(false);
    setStep(4);
  }

  // Finalize calibration — user selected which panel their drawn box represents
  function finalizeCalibration(panelIdx: number) {
    if (!pendingCalibrationBox || !selectedTemplate?.panel_data?.[panelIdx]) return;
    const panel = selectedTemplate.panel_data[panelIdx];
    const box = pendingCalibrationBox;

    const region = {
      panel_name: panel.name,
      width_in: panel.width_in,
      height_in: panel.height_in,
      img_x_pct: box.xPct,
      img_y_pct: box.yPct,
      img_w_pct: box.wPct,
      img_h_pct: box.hPct,
      in_per_pct_x: panel.width_in / box.wPct,
      in_per_pct_y: panel.height_in / box.hPct,
    };

    setCalibrationRegions([region]);
    setPendingCalibrationBox(null);
    setCalibrationMode(false);
  }

  // Calculate real-world inches from a bounding box's position/size on the proof image.
  // Uses calibration regions (panel edges mapped to known dimensions) for accuracy.
  // Falls back to overall vehicle dimensions if no calibration is available.
  function boxPctToInches(
    widthPct: number, heightPct: number,
    boxXPct?: number, boxYPct?: number
  ): { width_in: number; height_in: number } | null {
    // Try calibration regions first — find which region this box overlaps most
    if (calibrationRegions.length > 0 && boxXPct !== undefined && boxYPct !== undefined) {
      const boxCenterX = boxXPct + widthPct / 2;
      const boxCenterY = boxYPct + heightPct / 2;

      // Find the calibration region whose center is closest to the box center
      let bestRegion = calibrationRegions[0];
      let bestDist = Infinity;
      for (const region of calibrationRegions) {
        const regionCenterX = region.img_x_pct + region.img_w_pct / 2;
        const regionCenterY = region.img_y_pct + region.img_h_pct / 2;
        const dist = Math.hypot(boxCenterX - regionCenterX, boxCenterY - regionCenterY);
        if (dist < bestDist) {
          bestDist = dist;
          bestRegion = region;
        }
      }

      return {
        width_in: Math.round(widthPct * bestRegion.in_per_pct_x * 10) / 10,
        height_in: Math.round(heightPct * bestRegion.in_per_pct_y * 10) / 10,
      };
    }

    // Fallback: use overall vehicle dimensions
    if (!selectedTemplate) return null;
    const vehicleW = selectedTemplate.overall_length_in;
    const vehicleH = selectedTemplate.overall_height_in;
    if (!vehicleW || !vehicleH) return null;
    return {
      width_in: Math.round(vehicleW * (widthPct / 100) * 10) / 10,
      height_in: Math.round(vehicleH * (heightPct / 100) * 10) / 10,
    };
  }

  // Bounding box drag/resize handlers
  function handleBboxMouseDown(e: React.MouseEvent, idx: number, mode: 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw') {
    e.stopPropagation();
    e.preventDefault();
    const el = analysis?.graphic_elements?.[idx];
    if (!el) return;
    setBboxDragging({
      idx,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      origBox: {
        x: el.crop_x_pct || 0,
        y: el.crop_y_pct || 0,
        w: el.crop_w_pct || 0,
        h: el.crop_h_pct || 0,
      },
    });
  }

  function handleBboxMouseMove(e: React.MouseEvent) {
    if (!bboxDragging || !analysis?.graphic_elements || !proofImgRef.current) return;
    const imgRect = proofImgRef.current.getBoundingClientRect();
    // Convert pixel delta to percentage of image
    const dxPct = ((e.clientX - bboxDragging.startX) / imgRect.width) * 100;
    const dyPct = ((e.clientY - bboxDragging.startY) / imgRect.height) * 100;
    const { mode, origBox, idx } = bboxDragging;

    let newX = origBox.x;
    let newY = origBox.y;
    let newW = origBox.w;
    let newH = origBox.h;

    if (mode === 'move') {
      newX = Math.max(0, Math.min(100 - origBox.w, origBox.x + dxPct));
      newY = Math.max(0, Math.min(100 - origBox.h, origBox.y + dyPct));
    } else {
      // Resize from edges/corners
      if (mode.includes('w')) {
        const maxDx = origBox.w - 2; // minimum 2% width
        const clampedDx = Math.min(dxPct, maxDx);
        newX = Math.max(0, origBox.x + clampedDx);
        newW = origBox.w - (newX - origBox.x);
      }
      if (mode.includes('e')) {
        newW = Math.max(2, Math.min(100 - origBox.x, origBox.w + dxPct));
      }
      if (mode.includes('n')) {
        const maxDy = origBox.h - 2;
        const clampedDy = Math.min(dyPct, maxDy);
        newY = Math.max(0, origBox.y + clampedDy);
        newH = origBox.h - (newY - origBox.y);
      }
      if (mode.includes('s')) {
        newH = Math.max(2, Math.min(100 - origBox.y, origBox.h + dyPct));
      }
    }

    // Update the element in-place (mutate analysis to avoid full re-render stutter)
    const el = analysis.graphic_elements[idx];
    el.crop_x_pct = newX;
    el.crop_y_pct = newY;
    el.crop_w_pct = newW;
    el.crop_h_pct = newH;
    // Force re-render
    setAnalysis({ ...analysis });
  }

  function handleBboxMouseUp() {
    if (!bboxDragging || !analysis?.graphic_elements) return;
    const { idx, mode, origBox } = bboxDragging;
    const el = analysis.graphic_elements[idx];

    // Recalculate physical dimensions from the box size (for both move and resize)
    {
      const fromTemplate = boxPctToInches(el.crop_w_pct || 0, el.crop_h_pct || 0, el.crop_x_pct || 0, el.crop_y_pct || 0);
      if (fromTemplate) {
        // Use template-scaled dimensions — the box IS the size
        el.width_in = fromTemplate.width_in;
        el.height_in = fromTemplate.height_in;
      } else {
        // Fallback: scale proportionally from AI guess (no template dims available)
        const wRatio = (el.crop_w_pct || 1) / (origBox.w || 1);
        const hRatio = (el.crop_h_pct || 1) / (origBox.h || 1);
        el.width_in = Math.round(el.width_in * wRatio * 10) / 10;
        el.height_in = Math.round(el.height_in * hRatio * 10) / 10;
      }
      setAnalysis({ ...analysis });
    }

    setBboxDragging(null);
  }

  // --- Touch handlers for bounding boxes ---
  function getTouchDist(t1: React.Touch, t2: React.Touch) {
    return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
  }

  function handleBboxTouchStart(e: React.TouchEvent, idx: number) {
    const el = analysis?.graphic_elements?.[idx];
    if (!el) return;

    if (e.touches.length === 2) {
      // Pinch start
      e.preventDefault();
      e.stopPropagation();
      pinchStartDist.current = getTouchDist(e.touches[0], e.touches[1]);
      pinchStartSpread.current = {
        dx: Math.abs(e.touches[0].clientX - e.touches[1].clientX) || 1,
        dy: Math.abs(e.touches[0].clientY - e.touches[1].clientY) || 1,
      };
      pinchStartBox.current = {
        w: el.crop_w_pct || 0, h: el.crop_h_pct || 0,
        x: el.crop_x_pct || 0, y: el.crop_y_pct || 0,
      };
      pinchIdx.current = idx;
      // Cancel any long press
      if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
      return;
    }

    if (e.touches.length === 1) {
      e.stopPropagation();
      const t = e.touches[0];
      touchStartPos.current = { x: t.clientX, y: t.clientY };
      touchStartTime.current = Date.now();
      touchMovedEnough.current = false;

      // Start long press timer for drag
      longPressTimer.current = setTimeout(() => {
        setTouchDragging(true);
        setBboxDragging({
          idx,
          mode: 'move',
          startX: t.clientX,
          startY: t.clientY,
          origBox: {
            x: el.crop_x_pct || 0, y: el.crop_y_pct || 0,
            w: el.crop_w_pct || 0, h: el.crop_h_pct || 0,
          },
        });
      }, 300);
    }
  }

  function handleBboxTouchMove(e: React.TouchEvent) {
    // Pinch resize
    if (e.touches.length === 2 && pinchStartSpread.current && pinchStartBox.current && pinchIdx.current !== null && analysis?.graphic_elements) {
      e.preventDefault();
      e.stopPropagation();
      const curDx = Math.abs(e.touches[0].clientX - e.touches[1].clientX) || 1;
      const curDy = Math.abs(e.touches[0].clientY - e.touches[1].clientY) || 1;
      const scaleX = curDx / pinchStartSpread.current.dx;
      const scaleY = curDy / pinchStartSpread.current.dy;
      const el = analysis.graphic_elements[pinchIdx.current];
      const orig = pinchStartBox.current;
      // Scale width and height independently based on finger spread direction
      const newW = Math.max(2, Math.min(100, orig.w * scaleX));
      const newH = Math.max(2, Math.min(100, orig.h * scaleY));
      const dw = newW - orig.w;
      const dh = newH - orig.h;
      el.crop_w_pct = newW;
      el.crop_h_pct = newH;
      el.crop_x_pct = Math.max(0, Math.min(100 - newW, orig.x - dw / 2));
      el.crop_y_pct = Math.max(0, Math.min(100 - newH, orig.y - dh / 2));
      setAnalysis({ ...analysis });
      return;
    }

    // Single finger — check if moved enough to cancel tap
    if (e.touches.length === 1 && touchStartPos.current) {
      const t = e.touches[0];
      const dx = t.clientX - touchStartPos.current.x;
      const dy = t.clientY - touchStartPos.current.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        touchMovedEnough.current = true;
      }
    }

    // Drag move
    if (bboxDragging && touchDragging && e.touches.length === 1 && proofImgRef.current) {
      e.preventDefault();
      e.stopPropagation();
      const t = e.touches[0];
      const imgRect = proofImgRef.current.getBoundingClientRect();
      const dxPct = ((t.clientX - bboxDragging.startX) / imgRect.width) * 100;
      const dyPct = ((t.clientY - bboxDragging.startY) / imgRect.height) * 100;
      const el = analysis?.graphic_elements?.[bboxDragging.idx];
      if (el) {
        el.crop_x_pct = Math.max(0, Math.min(100 - bboxDragging.origBox.w, bboxDragging.origBox.x + dxPct));
        el.crop_y_pct = Math.max(0, Math.min(100 - bboxDragging.origBox.h, bboxDragging.origBox.y + dyPct));
        setAnalysis({ ...analysis! });
      }
    }
  }

  function handleBboxTouchEnd(e: React.TouchEvent, idx: number) {
    // Clear long press timer
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }

    // Pinch end — recalculate physical dimensions from box size
    if (pinchIdx.current !== null && pinchStartBox.current && analysis?.graphic_elements) {
      const el = analysis.graphic_elements[pinchIdx.current];
      const orig = pinchStartBox.current;
      if (el.crop_w_pct && el.crop_h_pct) {
        const fromTemplate = boxPctToInches(el.crop_w_pct, el.crop_h_pct, el.crop_x_pct || 0, el.crop_y_pct || 0);
        if (fromTemplate) {
          el.width_in = fromTemplate.width_in;
          el.height_in = fromTemplate.height_in;
        } else {
          const wRatio = el.crop_w_pct / (orig.w || 1);
          const hRatio = el.crop_h_pct / (orig.h || 1);
          el.width_in = Math.round(el.width_in * wRatio * 10) / 10;
          el.height_in = Math.round(el.height_in * hRatio * 10) / 10;
        }
        setAnalysis({ ...analysis });
      }
      pinchStartDist.current = null;
      pinchStartSpread.current = null;
      pinchStartBox.current = null;
      pinchIdx.current = null;
      return;
    }

    // If was dragging, stop
    if (touchDragging) {
      setTouchDragging(false);
      setBboxDragging(null);
      return;
    }

    // Short tap without movement → select this box (show detail panel)
    const elapsed = Date.now() - touchStartTime.current;
    if (elapsed < 300 && !touchMovedEnough.current) {
      e.preventDefault();
      setSelectedBboxIdx(selectedBboxIdx === idx ? null : idx);
    }

    touchStartPos.current = null;
  }

  // Touch handlers for drawing on proof image
  function handleProofTouchStart(e: React.TouchEvent) {
    if (bboxDragging || touchDragging) return;
    // Deselect bbox when touching background
    setSelectedBboxIdx(null);
    if (!proofImgRef.current || e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    const rect = proofImgRef.current.getBoundingClientRect();
    const x = t.clientX - rect.left;
    const y = t.clientY - rect.top;
    setNewElementStart({ x, y });
    setNewElementEnd({ x, y });
    setIsDragging(true);
  }

  function handleProofTouchMove(e: React.TouchEvent) {
    if (!isDragging || !proofImgRef.current || e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    const rect = proofImgRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(t.clientX - rect.left, rect.width));
    const y = Math.max(0, Math.min(t.clientY - rect.top, rect.height));
    setNewElementEnd({ x, y });
  }

  function handleProofTouchEnd() {
    if (!isDragging || !proofImgRef.current) {
      setIsDragging(false);
      return;
    }
    setIsDragging(false);

    // Finalize drawing — creates element or calibration box
    if (newElementStart && newElementEnd) {
      const sx = Math.min(newElementStart.x, newElementEnd.x);
      const sy = Math.min(newElementStart.y, newElementEnd.y);
      const sw = Math.abs(newElementEnd.x - newElementStart.x);
      const sh = Math.abs(newElementEnd.y - newElementStart.y);
      finalizeNewElement(proofImgRef.current, sx, sy, sw, sh);
      setNewElementStart(null);
      setNewElementEnd(null);
    }
  }

  function recalculateNesting(elements: GraphicElement[], qty: number = 1) {
    // Filter to only included elements
    const included = elements.filter(el => includedElements.has(el.element_name));
    if (included.length === 0) {
      setNestingResult(null);
      return null;
    }
    // Duplicate elements for multi-vehicle nesting
    const multiplied: GraphicElement[] = [];
    for (let i = 0; i < qty; i++) {
      included.forEach(el => {
        multiplied.push({ ...el, element_name: qty > 1 ? `${el.element_name} (${i + 1})` : el.element_name });
      });
    }
    const withBleed = applyBleed(multiplied, 0);
    const result = nestElementsOnRoll(withBleed, 60);
    setNestingResult(result);
    return result;
  }

  // Convert screen coordinates to SVG viewBox coordinates
  function svgPointFromClient(clientX: number, clientY: number): { x: number; y: number } | null {
    const svg = nestingSvgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());
    return { x: svgP.x, y: svgP.y };
  }

  function svgPoint(e: React.MouseEvent<SVGSVGElement> | MouseEvent): { x: number; y: number } | null {
    return svgPointFromClient((e as any).clientX, (e as any).clientY);
  }

  function handleNestDragStart(idx: number, e: React.MouseEvent<SVGGElement>) {
    if (!nestingResult) return;
    e.preventDefault();
    const pt = svgPoint(e as any);
    if (!pt) return;
    const elem = nestingResult.nested_elements[idx];
    setDraggingIdx(idx);
    setDragOffset({ x: pt.x - elem.x_in, y: pt.y - elem.y_in });
  }

  function handleNestDragMove(e: React.MouseEvent<SVGSVGElement>) {
    if (draggingIdx === null) return;
    const pt = svgPoint(e);
    if (!pt) return;
    // Use functional update to always read the latest state
    setNestingResult(prev => {
      if (!prev) return prev;
      const elem = prev.nested_elements[draggingIdx];
      if (!elem) return prev;
      let newX = pt.x - dragOffset.x;
      let newY = pt.y - dragOffset.y;
      newX = Math.max(0, Math.min(newX, 60 - elem.total_width_in));
      newY = Math.max(0, newY);
      newX = Math.round(newX * 2) / 2;
      newY = Math.round(newY * 2) / 2;
      const updated = prev.nested_elements.map((el, i) =>
        i === draggingIdx ? { ...el, x_in: newX, y_in: newY } : el
      );
      return recalcFromPositions(updated, 60);
    });
  }

  function handleNestDragEnd() {
    setDraggingIdx(null);
  }

  // Check for overlaps between nested elements
  function getOverlaps(): Set<number> {
    if (!nestingResult) return new Set();
    const overlapping = new Set<number>();
    const els = nestingResult.nested_elements;
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i], b = els[j];
        if (a.x_in < b.x_in + b.total_width_in && a.x_in + a.total_width_in > b.x_in &&
            a.y_in < b.y_in + b.total_height_in && a.y_in + a.total_height_in > b.y_in) {
          overlapping.add(i);
          overlapping.add(j);
        }
      }
    }
    return overlapping;
  }

  // Rotate an element 90° in the nesting diagram (swap width and height)
  function handleNestRotate(idx: number) {
    setNestingResult(prev => {
      if (!prev) return prev;
      const elem = prev.nested_elements[idx];
      if (!elem) return prev;
      const rotated = {
        ...elem,
        total_width_in: elem.total_height_in,
        total_height_in: elem.total_width_in,
        rotated: !elem.rotated,
      };
      if (rotated.x_in + rotated.total_width_in > 60) {
        rotated.x_in = Math.max(0, 60 - rotated.total_width_in);
      }
      const updated = prev.nested_elements.map((el, i) =>
        i === idx ? rotated : el
      );
      return recalcFromPositions(updated, 60);
    });
  }

  // Duplicate an element (e.g. same graphic on both sides of vehicle)
  function duplicateElement(idx: number) {
    if (!analysis?.graphic_elements) return;
    const el = analysis.graphic_elements[idx];
    // Find a unique name for the copy
    const baseName = el.element_name.replace(/ \(copy.*\)$/, '');
    const existingNames = new Set(analysis.graphic_elements.map(e => e.element_name));
    let copyName = `${baseName} (copy)`;
    let copyNum = 2;
    while (existingNames.has(copyName)) {
      copyName = `${baseName} (copy ${copyNum})`;
      copyNum++;
    }
    const duplicate: GraphicElement = {
      ...el,
      element_name: copyName,
    };
    // Add to analysis
    const updatedElements = [...analysis.graphic_elements, duplicate];
    setAnalysis({ ...analysis, graphic_elements: updatedElements });
    // Auto-include if original is included
    if (includedElements.has(el.element_name)) {
      const next = new Set(includedElements);
      next.add(copyName);
      setIncludedElements(next);
      // Copy the crop image too if it exists
      if (elementCrops[el.element_name]) {
        setElementCrops(prev => ({ ...prev, [copyName]: prev[el.element_name] }));
      }
      // Recalculate nesting with the new element
      const included = updatedElements.filter(e => next.has(e.element_name));
      const multiplied: GraphicElement[] = [];
      for (let q = 0; q < vehicleQty; q++) {
        included.forEach(e => multiplied.push({ ...e, element_name: vehicleQty > 1 ? `${e.element_name} (${q + 1})` : e.element_name }));
      }
      const withBleed = applyBleed(multiplied, 0);
      setNestingResult(nestElementsOnRoll(withBleed, 60));
    } else {
      // Copy crop anyway
      if (elementCrops[el.element_name]) {
        setElementCrops(prev => ({ ...prev, [copyName]: prev[el.element_name] }));
      }
    }
  }

  // Remove a duplicated element
  function removeElement(idx: number) {
    if (!analysis?.graphic_elements) return;
    const el = analysis.graphic_elements[idx];
    const updatedElements = analysis.graphic_elements.filter((_, i) => i !== idx);
    setAnalysis({ ...analysis, graphic_elements: updatedElements });
    // Remove from included set and crops
    const next = new Set(includedElements);
    next.delete(el.element_name);
    setIncludedElements(next);
    setElementCrops(prev => {
      const updated = { ...prev };
      delete updated[el.element_name];
      return updated;
    });
    // Recalculate nesting
    const included = updatedElements.filter(e => next.has(e.element_name));
    if (included.length === 0) {
      setNestingResult(null);
    } else {
      const multiplied: GraphicElement[] = [];
      for (let q = 0; q < vehicleQty; q++) {
        included.forEach(e => multiplied.push({ ...e, element_name: vehicleQty > 1 ? `${e.element_name} (${q + 1})` : e.element_name }));
      }
      const withBleed = applyBleed(multiplied, 0);
      setNestingResult(nestElementsOnRoll(withBleed, 60));
    }
  }

  // Touch handlers for nesting diagram drag
  const nestTouchIdx = useRef<number | null>(null);
  const nestTouchOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  function handleNestTouchStart(idx: number, e: React.TouchEvent<SVGGElement>) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    const t = e.touches[0];
    const pt = svgPointFromClient(t.clientX, t.clientY);
    if (!pt) return;
    // Read current position from latest state via ref-style access
    setNestingResult(prev => {
      if (!prev) return prev;
      const elem = prev.nested_elements[idx];
      if (elem) {
        nestTouchIdx.current = idx;
        nestTouchOffset.current = { x: pt.x - elem.x_in, y: pt.y - elem.y_in };
      }
      return prev; // no change, just reading
    });
    setDraggingIdx(idx);
  }

  function handleNestTouchMove(e: React.TouchEvent<SVGSVGElement>) {
    if (nestTouchIdx.current === null || e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    const pt = svgPointFromClient(t.clientX, t.clientY);
    if (!pt) return;
    const idx = nestTouchIdx.current;
    const offset = nestTouchOffset.current;
    setNestingResult(prev => {
      if (!prev) return prev;
      const elem = prev.nested_elements[idx];
      if (!elem) return prev;
      let newX = pt.x - offset.x;
      let newY = pt.y - offset.y;
      newX = Math.max(0, Math.min(newX, 60 - elem.total_width_in));
      newY = Math.max(0, newY);
      newX = Math.round(newX * 2) / 2;
      newY = Math.round(newY * 2) / 2;
      const updated = prev.nested_elements.map((el, i) =>
        i === idx ? { ...el, x_in: newX, y_in: newY } : el
      );
      return recalcFromPositions(updated, 60);
    });
  }

  function handleNestTouchEnd() {
    nestTouchIdx.current = null;
    setDraggingIdx(null);
  }

  // Crop a region from the proof image given pixel coordinates on the displayed image
  function cropFromProof(elementName: string, imgEl: HTMLImageElement, sx: number, sy: number, sw: number, sh: number) {
    if (sw < 2 || sh < 2) return;
    // Scale selection coords from displayed size to natural image size
    const scaleX = imgEl.naturalWidth / imgEl.clientWidth;
    const scaleY = imgEl.naturalHeight / imgEl.clientHeight;
    const nx = sx * scaleX;
    const ny = sy * scaleY;
    const nw = sw * scaleX;
    const nh = sh * scaleY;

    const canvas = document.createElement('canvas');
    const maxDim = 400;
    const scale = Math.min(1, maxDim / Math.max(nw, nh));
    canvas.width = Math.round(nw * scale);
    canvas.height = Math.round(nh * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(imgEl, nx, ny, nw, nh, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    setElementCrops(prev => ({ ...prev, [elementName]: dataUrl }));
    // Cropping automatically includes the element
    setIncludedElements(prev => new Set(prev).add(elementName));
  }

  // State for the crop tool
  const [croppingElement, setCroppingElement] = useState<string | null>(null);
  const [cropStart, setCropStart] = useState<{ x: number; y: number } | null>(null);
  const [cropEnd, setCropEnd] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const proofImgRef = useRef<HTMLImageElement>(null);

  // Handle proof file selection
  function handleProofSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setProofFile(file);

    // Create preview for images; for PDFs we'll show the filename
    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      setProofPreview(url);
    } else {
      setProofPreview(null);
    }
  }

  // Run AI analysis
  async function runAnalysis() {
    if (!selectedTemplate || !proofFile) return;

    setAnalyzing(true);
    setAnalysisError('');

    try {
      const hasDimensions = selectedTemplate.panel_data && selectedTemplate.panel_data.length > 0;

      // Only fetch template image if no dimension data (legacy fallback)
      let templateBase64 = '';
      let templateMediaType = 'image/png';

      if (!hasDimensions && selectedTemplate.template_image_path) {
        try {
          const { data } = storage.from('vehicle-templates')
            .getPublicUrl(selectedTemplate.template_image_path);

          setTemplatePreviewUrl(data.publicUrl);

          const imgResponse = await fetch(data.publicUrl);
          if (!imgResponse.ok) throw new Error(`Failed to fetch template image: ${imgResponse.status}`);
          const imgBlob = await imgResponse.blob();
          templateBase64 = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string).split(',')[1]);
            reader.readAsDataURL(imgBlob);
          });
          templateMediaType = imgBlob.type || 'image/png';
        } catch (fetchErr: any) {
          console.error('Template image fetch error:', fetchErr);
          throw new Error('No panel dimensions and could not load template image. Run the extract-dimensions script first.');
        }
      } else if (!hasDimensions) {
        throw new Error('This vehicle has no panel dimensions. Run: node scripts/extract-dimensions.mjs');
      }

      // Compress proof file
      const proofCompressed = await compressImage(proofFile, 2048, 0.8);
      const proofBase64 = proofCompressed.base64;
      const proofMediaType = proofCompressed.mediaType;

      setProofPreviewForReview(`data:${proofMediaType};base64,${proofBase64}`);

      // Call API — only send template image if no dimensions
      const response = await fetch('/api/analyze-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateImageBase64: hasDimensions ? undefined : templateBase64,
          proofImageBase64: proofBase64,
          templateMediaType: hasDimensions ? undefined : templateMediaType,
          proofMediaType,
          vehicleDimensions: hasDimensions ? {
            make: selectedTemplate.make,
            model: selectedTemplate.model,
            year: selectedTemplate.year,
            overall_length_in: selectedTemplate.overall_length_in,
            overall_height_in: selectedTemplate.overall_height_in,
            wheelbase_in: selectedTemplate.wheelbase_in,
            panels: selectedTemplate.panel_data || [],
          } : undefined,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Server error: ${response.status}`);
      }

      const result = await response.json();

      // Store calibration regions for accurate dimension calculations
      if (result.analysis.calibration_regions?.length) {
        setCalibrationRegions(result.analysis.calibration_regions);
      }

      setAnalysis(result.analysis);

      // Run nesting if analysis has graphic elements
      if (result.analysis.graphic_elements?.length) {
        // Start with all elements excluded — user tags what's in the kit
        setIncludedElements(new Set());
        setNestingResult(null);
        // Go to tag elements step so user can crop thumbnails & select elements
        setStep(4);
      } else {
        // Panel-based analysis, skip tagging
        setStep(5);
      }
    } catch (err: any) {
      setAnalysisError(err.message || 'Analysis failed. Please try again.');
    } finally {
      setAnalyzing(false);
    }
  }

  // Run template-only AI analysis (no proof — full wrap panel detection)
  async function runTemplateOnlyAnalysis() {
    if (!selectedTemplate) return;

    setAnalyzing(true);
    setAnalysisError('');
    setTemplateOnly(true);

    try {
      const hasDimensions = selectedTemplate.panel_data && selectedTemplate.panel_data.length > 0;

      if (hasDimensions) {
        // Build analysis directly from panel dimensions — no AI needed
        const panels = selectedTemplate.panel_data;
        const totalSqft = panels.reduce((sum, p) => sum + (p.area_sqft || 0), 0);

        const graphicElements: GraphicElement[] = panels.map((p, i) => ({
          element_name: p.name,
          element_type: 'full_panel',
          width_in: p.width_in,
          height_in: p.height_in,
          description: `${p.name} — ${p.width_in}" × ${p.height_in}" (${p.area_sqft.toFixed(1)} sq ft)`,
          crop_x_pct: 0,
          crop_y_pct: (i / panels.length) * 100,
          crop_w_pct: 100,
          crop_h_pct: (1 / panels.length) * 100,
        }));

        const analysisResult: AIAnalysisResult = {
          graphic_elements: graphicElements,
          total_vinyl_sqft: totalSqft,
          total_vehicle_sqft: totalSqft,
          overall_coverage_pct: 100,
          confidence: 'high',
          notes: `Full wrap estimate from ${panels.length} panel dimensions for ${selectedTemplate.make} ${selectedTemplate.model}.`,
          analysis_version: 'individual_elements',
        };

        // If template has an image, use it for the review UI
        if (selectedTemplate.template_image_path) {
          const { data } = storage.from('vehicle-templates')
            .getPublicUrl(selectedTemplate.template_image_path);
          setTemplatePreviewUrl(data.publicUrl);
          setProofPreviewForReview(data.publicUrl);
        }

        setAnalysis(analysisResult);
        // All panels INCLUDED for full wrap
        setIncludedElements(new Set(graphicElements.map(e => e.element_name)));
        setNestingResult(null);
        setStep(4);
      } else {
        // No panel dimensions — fall back to AI vision on template image
        if (!selectedTemplate.template_image_path) {
          throw new Error('This vehicle has no panel dimensions and no template image. Run the extract-dimensions script or upload a template PNG first.');
        }

        const { data } = storage.from('vehicle-templates')
          .getPublicUrl(selectedTemplate.template_image_path);

        setTemplatePreviewUrl(data.publicUrl);

        const imgResponse = await fetch(data.publicUrl);
        if (!imgResponse.ok) throw new Error(`Failed to fetch template image: ${imgResponse.status}`);

        const imgBlob = await imgResponse.blob();
        const templateBase64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(',')[1]);
          reader.readAsDataURL(imgBlob);
        });
        const templateMediaType = imgBlob.type || 'image/png';

        // Use the template image as the "proof" image for the tagging UI
        setProofPreviewForReview(data.publicUrl);

        // Call template-only analysis API
        const response = await fetch('/api/analyze-template', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templateImageBase64: templateBase64, templateMediaType }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || `Server error: ${response.status}`);
        }

        const result = await response.json();
        setAnalysis(result.analysis);

        if (result.analysis.graphic_elements?.length) {
          // Start with all panels INCLUDED (since this is a full wrap)
          setIncludedElements(new Set(result.analysis.graphic_elements.map((e: GraphicElement) => e.element_name)));
          setNestingResult(null);
          setStep(4); // Go to tag/adjust panels
        } else {
          setStep(5); // Go straight to pricing
        }
      }
    } catch (err: any) {
      setAnalysisError(err.message || 'Template analysis failed.');
    } finally {
      setAnalyzing(false);
    }
  }

  // Save quote (insert new or update existing)
  async function saveQuote() {
    if (!analysis || !user) return;
    setSaving(true);

    try {
      // Use nesting result for vinyl area if available, plus waste factor
      const baseVinylSqft = nestingResult?.roll_area_sqft || analysis.total_vinyl_sqft || 0;
      const vinylSqft = baseVinylSqft * (1 + wastePct / 100);

      const materialTotal = vinylSqft * materialRate;
      const laborTotal = baseVinylSqft * laborRate;
      const subtotal = materialTotal + laborTotal;
      // Profit margin applies to material only
      const marginFraction = marginPct / 100;
      const materialWithMargin = marginFraction >= 1 ? materialTotal : materialTotal / (1 - marginFraction);
      const totalPrice = materialWithMargin + laborTotal;

      const isEditing = !!editQuote;
      const quoteNum = isEditing
        ? editQuote.quote_number
        : (() => {
            const now = new Date();
            return `QUO-${now.getFullYear().toString().slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${Date.now().toString().slice(-4)}`;
          })();

      // Upload proof file to storage (only if a new file was selected)
      let proofPath = isEditing ? (editQuote.proof_image_path || '') : '';
      if (proofFile) {
        const fileName = `${quoteNum}-proof-${Date.now()}.${proofFile.name.split('.').pop()}`;
        const { error: uploadError } = await storage.from('quote-proofs')
          .upload(fileName, proofFile);
        if (!uploadError) proofPath = fileName;
      }

      const isElementBased = !!(analysis.graphic_elements?.length);

      const quotePayload = {
        quote_number: quoteNum,
        customer_name: customerName,
        vehicle_description: selectedTemplate
          ? `${selectedTemplate.year || ''} ${selectedTemplate.make} ${selectedTemplate.model} ${selectedTemplate.variant || ''}`.trim()
          : (editQuote?.vehicle_description || ''),
        template_id: selectedTemplate?.id || null,
        proof_image_path: proofPath || null,
        status: isEditing ? editQuote.status : 'draft' as const,
        ai_analysis: analysis,
        analysis_version: isElementBased ? 'individual_elements' : 'panel_coverage',
        total_vinyl_sqft: vinylSqft,
        coverage_percentage: analysis.overall_coverage_pct,
        material_cost_per_sqft: materialRate,
        labor_cost_per_sqft: laborRate,
        material_total: materialTotal,
        labor_total: laborTotal,
        subtotal: subtotal,
        markup_percentage: marginPct,
        total_price: totalPrice,
        nesting_result: nestingResult || null,
        vehicle_qty: vehicleQty,
        notes: analysis.notes,
        updated_at: new Date().toISOString(),
      };

      let quoteId: string;

      if (isEditing) {
        // Update existing quote
        const { error: updateError } = await supabase
          .from('quotes')
          .update(quotePayload)
          .eq('id', editQuote.id);
        if (updateError) throw updateError;
        quoteId = editQuote.id;

        // Delete old elements/panels before re-inserting
        await supabase.from('quote_elements').delete().eq('quote_id', quoteId);
        await supabase.from('quote_panels').delete().eq('quote_id', quoteId);
      } else {
        // Insert new quote
        const { data: quoteData, error: quoteError } = await supabase
          .from('quotes')
          .insert({ ...quotePayload, created_by: user.id })
          .select()
          .single();
        if (quoteError) throw quoteError;
        quoteId = quoteData.id;
      }

      // Insert elements OR panels based on analysis type
      if (isElementBased && analysis.graphic_elements) {
        const elementInserts = analysis.graphic_elements.map((el, i) => {
          const nested = nestingResult?.nested_elements[i];
          return {
            quote_id: quoteId,
            element_name: el.element_name,
            element_type: el.element_type,
            width_in: el.width_in,
            height_in: el.height_in,
            description: el.description,
            bleed_in: 0,
            nested_x_in: nested?.x_in ?? null,
            nested_y_in: nested?.y_in ?? null,
            sort_order: i,
          };
        });
        await supabase.from('quote_elements').insert(elementInserts);
      } else if (analysis.panels) {
        const panelInserts = analysis.panels.map((p, i) => ({
          quote_id: quoteId,
          panel_name: p.panel_name,
          panel_area_sqft: p.panel_area_sqft,
          vinyl_coverage_pct: p.vinyl_coverage_pct,
          vinyl_sqft: p.vinyl_sqft,
          vinyl_type: p.vinyl_type,
          notes: p.description,
          sort_order: i,
        }));
        await supabase.from('quote_panels').insert(panelInserts);
      }

      onCreated();
    } catch (err: any) {
      alert('Error saving quote: ' + (err.message || 'Unknown error'));
    } finally {
      setSaving(false);
    }
  }

  // Calculated totals for step 5
  // Identify elements that were panelized (split into pieces for the 60" roll)
  const nestedNames = new Set(nestingResult?.nested_elements.map(el => el.element.element_name) || []);
  const panelizedElements = (analysis?.graphic_elements || [])
    .filter(el => includedElements.has(el.element_name) &&
      !nestedNames.has(el.element_name) &&
      nestingResult?.nested_elements.some(ne => ne.element.element_name.startsWith(el.element_name + '-'))
    );

  const baseVinylSqft = nestingResult?.roll_area_sqft || analysis?.total_vinyl_sqft || 0;
  const vinylSqft = baseVinylSqft * (1 + wastePct / 100);
  const materialTotal = vinylSqft * materialRate;
  const laborTotal = baseVinylSqft * laborRate; // labor based on actual area, not waste
  const subtotal = materialTotal + laborTotal;
  // Profit margin applies to material only — labor rate is set directly
  const marginFraction = marginPct / 100;
  const materialWithMargin = marginFraction >= 1 ? materialTotal : materialTotal / (1 - marginFraction);
  const marginAmount = materialWithMargin - materialTotal;
  const totalPrice = materialWithMargin + laborTotal;

  const filteredTemplates = templates.filter(t =>
    `${t.make} ${t.model} ${t.year} ${t.variant}`.toLowerCase().includes(templateSearch.toLowerCase())
  );

  return (
    <div>
      {/* Progress Steps */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '20px' }}>
        {[1, 2, 3, 4, 5].map(s => (
          <div key={s} style={{
            flex: 1, height: '4px', borderRadius: '2px',
            background: s <= step ? theme.orange : theme.progressTrack,
            transition: 'background 0.3s',
          }} />
        ))}
      </div>

      {/* Step 1: Customer & Vehicle Selection */}
      {step === 1 && (
        <div>
          <div style={{ fontSize: '16px', fontWeight: 800, color: theme.textPrimary, marginBottom: '16px' }}>
            Step 1: Customer & Vehicle
          </div>

          {/* Customer Name */}
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 700, color: theme.textSecondary, marginBottom: '6px' }}>Customer Name</label>
            <input
              value={customerName}
              onChange={e => setCustomerName(e.target.value)}
              placeholder="Enter customer name..."
              style={{
                width: '100%', padding: '12px', borderRadius: '10px', border: `1px solid ${theme.border}`,
                background: theme.inputBg, color: theme.textPrimary, fontSize: '14px', outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Template Selection */}
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 700, color: theme.textSecondary, marginBottom: '6px' }}>Vehicle Template</label>
            <input
              value={templateSearch}
              onChange={e => setTemplateSearch(e.target.value)}
              placeholder="Search templates... (e.g. Transit, Sprinter)"
              style={{
                width: '100%', padding: '12px', borderRadius: '10px', border: `1px solid ${theme.border}`,
                background: theme.inputBg, color: theme.textPrimary, fontSize: '14px', outline: 'none',
                marginBottom: '8px', boxSizing: 'border-box',
              }}
            />

            <div style={{ maxHeight: '300px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {filteredTemplates.length === 0 && (
                <div style={{ padding: '20px', textAlign: 'center', color: theme.textMuted, fontSize: '13px' }}>
                  {templates.length === 0 ? 'No templates uploaded yet. Add templates in the Templates tab.' : 'No matching templates.'}
                </div>
              )}
              {filteredTemplates.map(t => (
                <button
                  key={t.id}
                  onClick={() => setSelectedTemplate(t)}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', borderRadius: '12px',
                    border: selectedTemplate?.id === t.id ? `2px solid ${theme.orange}` : `1px solid ${theme.border}`,
                    background: selectedTemplate?.id === t.id ? theme.orangeSoft : theme.card,
                    cursor: 'pointer', textAlign: 'left', width: '100%',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '15px', fontWeight: 700, color: theme.textPrimary }}>{t.name}</div>
                    <div style={{ fontSize: '13px', color: theme.textMuted }}>
                      {t.year} {t.make} {t.model} {t.variant || ''}
                    </div>
                    {t.panel_data && t.panel_data.length > 0 && (
                      <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '4px' }}>
                        {t.panel_data.length} panels · {t.overall_length_in ? `${t.overall_length_in}" L` : ''}{t.wheelbase_in ? ` · ${t.wheelbase_in}" WB` : ''}
                        {' · '}
                        {t.panel_data.reduce((s, p) => s + (p.area_sqft || 0), 0).toFixed(0)} sq ft total
                      </div>
                    )}
                    {(!t.panel_data || t.panel_data.length === 0) && (
                      <div style={{ fontSize: '11px', color: '#fbbf24', marginTop: '4px' }}>
                        No dimensions yet — run extract-dimensions script
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={() => setStep(2)}
            disabled={!customerName.trim() || !selectedTemplate}
            style={{
              width: '100%', padding: '14px', borderRadius: '12px', border: 'none',
              background: (!customerName.trim() || !selectedTemplate) ? theme.border : theme.navy,
              color: (!customerName.trim() || !selectedTemplate) ? theme.textMuted : '#fff',
              fontSize: '15px', fontWeight: 700, cursor: 'pointer',
            }}
          >
            Next: Upload Proof →
          </button>
        </div>
      )}

      {/* Step 2: Proof Upload */}
      {step === 2 && (
        <div>
          <div style={{ fontSize: '16px', fontWeight: 800, color: theme.textPrimary, marginBottom: '4px' }}>
            Step 2: Upload Proof
          </div>
          <div style={{ fontSize: '13px', color: theme.textSecondary, marginBottom: '16px' }}>
            Upload a new proof or choose from a previous quote
          </div>

          {/* Upload Area */}
          <label style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: '32px 20px', borderRadius: '12px', border: `2px dashed ${proofFile ? theme.success : theme.border}`,
            background: proofFile ? theme.successBg : theme.inputBg, cursor: 'pointer', marginBottom: '16px',
          }}>
            <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={handleProofSelect} style={{ display: 'none' }} />
            {proofFile ? (
              <>
                {proofPreview ? (
                  <img src={proofPreview} alt="Proof" style={{ maxWidth: '100%', maxHeight: '200px', borderRadius: '8px', marginBottom: '8px' }} />
                ) : (
                  <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textMuted, marginBottom: '8px' }}>PDF</div>
                )}
                <div style={{ fontSize: '14px', fontWeight: 700, color: theme.success }}>✓ {proofFile.name}</div>
                <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '4px' }}>Tap to change file</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textMuted, marginBottom: '8px' }}>Upload</div>
                <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>Tap to upload new proof</div>
                <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '4px' }}>PDF, PNG, or JPG</div>
              </>
            )}
          </label>

          {/* Proof Library */}
          {proofLibrary.length === 0 && !loadingLibrary && (
            <button
              onClick={loadProofLibrary}
              style={{
                width: '100%', padding: '12px', borderRadius: '10px', border: `1px solid ${theme.border}`,
                background: theme.card, color: theme.textSecondary, fontSize: '13px', fontWeight: 600,
                cursor: 'pointer', marginBottom: '16px',
              }}
            >
              Browse previous proofs
            </button>
          )}
          {loadingLibrary && (
            <div style={{ textAlign: 'center', padding: '12px', color: theme.textMuted, fontSize: '13px', marginBottom: '16px' }}>
              Loading proof library...
            </div>
          )}
          {proofLibrary.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textSecondary, marginBottom: '8px' }}>
                Previous Proofs
              </div>
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '8px',
                maxHeight: '280px', overflowY: 'auto', padding: '2px',
              }}>
                {proofLibrary.map((proof, i) => (
                  <button
                    key={i}
                    onClick={() => selectLibraryProof(proof)}
                    style={{
                      background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '10px',
                      padding: '6px', cursor: 'pointer', textAlign: 'left', overflow: 'hidden',
                      transition: 'border-color 0.15s',
                    }}
                    onMouseOver={(e) => (e.currentTarget.style.borderColor = theme.orange)}
                    onMouseOut={(e) => (e.currentTarget.style.borderColor = theme.border)}
                  >
                    <img
                      src={proof.url}
                      alt={proof.quoteNum}
                      style={{ width: '100%', height: '90px', objectFit: 'cover', borderRadius: '6px', marginBottom: '4px' }}
                    />
                    <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {proof.customer || proof.quoteNum}
                    </div>
                    <div style={{ fontSize: '10px', color: theme.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {proof.vehicle || proof.quoteNum}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Divider */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '12px', margin: '16px 0',
          }}>
            <div style={{ flex: 1, height: '1px', background: theme.border }} />
            <span style={{ fontSize: '12px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>or</span>
            <div style={{ flex: 1, height: '1px', background: theme.border }} />
          </div>

          {/* Full Wrap — No Proof */}
          <button
            onClick={() => { setTemplateOnly(true); runTemplateOnlyAnalysis(); }}
            style={{
              width: '100%', padding: '16px', borderRadius: '12px',
              border: `2px solid ${theme.orange}`, background: theme.orange + '10',
              color: theme.orange, fontSize: '15px', fontWeight: 800, cursor: 'pointer',
              marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            }}
          >
            Full Wrap — Skip Proof
          </button>
          <div style={{ fontSize: '11px', color: theme.textMuted, textAlign: 'center', marginBottom: '16px' }}>
            Uses template panel dimensions for a full wrap estimate.
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setStep(1)}
              style={{
                flex: 1, padding: '14px', borderRadius: '12px', border: `1px solid ${theme.border}`,
                background: 'transparent', color: theme.textSecondary, fontSize: '15px', fontWeight: 700, cursor: 'pointer',
              }}
            >
              ← Back
            </button>
            <button
              onClick={() => enterDrawStep()}
              disabled={!proofFile && !proofPreview}
              style={{
                flex: 2, padding: '14px', borderRadius: '12px', border: 'none',
                background: (!proofFile && !proofPreview) ? theme.border : theme.navy,
                color: (!proofFile && !proofPreview) ? theme.textMuted : '#fff',
                fontSize: '15px', fontWeight: 700, cursor: 'pointer',
              }}
            >
              Next: Draw Elements →
            </button>
          </div>
        </div>
      )}

      {/* Step 3: AI Analysis */}
      {step === 3 && (
        <div>
          <div style={{ fontSize: '16px', fontWeight: 800, color: theme.textPrimary, marginBottom: '4px' }}>
            Step 3: AI Analysis
          </div>
          <div style={{ fontSize: '13px', color: theme.textSecondary, marginBottom: '16px' }}>
            {templateOnly
              ? `AI will detect wrappable panels on the ${selectedTemplate?.name} template`
              : `AI will compare the proof design against the ${selectedTemplate?.name} template to estimate vinyl coverage`}
          </div>

          {/* Summary of what we're analyzing */}
          <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '8px' }}>
              <span style={{ color: theme.textSecondary }}>Customer:</span>
              <span style={{ color: theme.textPrimary, fontWeight: 700 }}>{customerName}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '8px' }}>
              <span style={{ color: theme.textSecondary }}>Vehicle:</span>
              <span style={{ color: theme.textPrimary, fontWeight: 700 }}>{selectedTemplate?.name}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={{ color: theme.textSecondary }}>Mode:</span>
              <span style={{ color: templateOnly ? theme.orange : theme.textPrimary, fontWeight: 700 }}>
                {templateOnly ? 'Full Wrap (No Proof)' : proofFile?.name || (editQuote?.proof_image_path ? 'Existing proof' : 'None')}
              </span>
            </div>
          </div>

          {analysisError && (
            <div style={{ background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, borderRadius: '10px', padding: '12px', marginBottom: '16px', fontSize: '13px', color: theme.error }}>
              {analysisError}
            </div>
          )}

          {analyzing ? (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <div style={{
                width: '48px', height: '48px', border: '4px solid var(--border)',
                borderTopColor: 'var(--orange)', borderRadius: '50%', margin: '0 auto',
                animation: 'spin 1s linear infinite',
              }} />
              <div style={{ color: theme.textPrimary, marginTop: '16px', fontSize: '15px', fontWeight: 700 }}>
                {templateOnly ? 'AI is detecting panels...' : 'AI is analyzing your proof...'}
              </div>
              <div style={{ color: theme.textMuted, marginTop: '6px', fontSize: '13px' }}>
                {templateOnly
                  ? 'Identifying wrappable panels from template dimensions. This may take 15-30 seconds.'
                  : 'Comparing proof against template dimensions to estimate vinyl coverage. This may take 15-30 seconds.'}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setStep(2)}
                style={{
                  flex: 1, padding: '14px', borderRadius: '12px', border: `1px solid ${theme.border}`,
                  background: 'transparent', color: theme.textSecondary, fontSize: '15px', fontWeight: 700, cursor: 'pointer',
                }}
              >
                ← Back
              </button>
              <button
                onClick={templateOnly ? runTemplateOnlyAnalysis : runAnalysis}
                disabled={templateOnly ? !selectedTemplate : (!proofFile || !selectedTemplate)}
                style={{
                  flex: 2, padding: '14px', borderRadius: '12px', border: 'none',
                  background: (templateOnly ? !selectedTemplate : (!proofFile || !selectedTemplate)) ? theme.border : theme.orange,
                  color: (templateOnly ? !selectedTemplate : (!proofFile || !selectedTemplate)) ? theme.textMuted : '#fff',
                  fontSize: '15px', fontWeight: 700, cursor: (templateOnly ? !selectedTemplate : (!proofFile || !selectedTemplate)) ? 'not-allowed' : 'pointer',
                }}
              >
                {templateOnly ? 'Detect Panels' : 'Run AI Analysis'}
              </button>
              {/* When editing with existing analysis, allow skipping re-analysis */}
              {editQuote && analysis && (
                <button
                  onClick={() => setStep(analysis.graphic_elements?.length ? 4 : 5)}
                  style={{
                    flex: 2, padding: '14px', borderRadius: '12px', border: 'none',
                    background: theme.navy, color: '#fff',
                    fontSize: '15px', fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  Continue →
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Step 4: Calibrate & Draw Elements — fullscreen measurement tool */}
      {step === 4 && analysis && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 200,
          background: theme.bg || '#0e1621',
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Header bar */}
          <div style={{
            padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: theme.card, borderBottom: `1px solid ${theme.border}`, flexShrink: 0,
          }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 800, color: theme.textPrimary }}>
                {calibrationMode ? 'Calibrate' : templateOnly ? 'Adjust Panels' : 'Draw Elements'}
              </div>
              <div style={{ fontSize: '11px', color: theme.textMuted }}>
                {calibrationMode
                  ? 'Draw a box around a known panel to set the scale'
                  : `${includedElements.size} element${includedElements.size !== 1 ? 's' : ''} drawn`
                    + (calibrationRegions.length > 0 ? ` · Calibrated` : '')}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '4px',
                border: `1px solid ${theme.border}`, borderRadius: '8px', padding: '2px',
                marginRight: '4px',
              }}>
                <button
                  onClick={() => setProofZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))}
                  disabled={proofZoom <= 0.5}
                  title="Zoom out"
                  style={{
                    width: '28px', height: '28px', borderRadius: '6px', border: 'none',
                    background: 'transparent', color: theme.textSecondary,
                    fontSize: '16px', fontWeight: 700,
                    cursor: proofZoom <= 0.5 ? 'not-allowed' : 'pointer',
                    opacity: proofZoom <= 0.5 ? 0.4 : 1,
                  }}
                >
                  −
                </button>
                <button
                  onClick={() => setProofZoom(1)}
                  title="Fit to width"
                  style={{
                    minWidth: '52px', height: '28px', padding: '0 8px',
                    borderRadius: '6px', border: 'none', background: 'transparent',
                    color: theme.textSecondary, fontSize: '11px', fontWeight: 700,
                    cursor: 'pointer', fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {Math.round(proofZoom * 100)}%
                </button>
                <button
                  onClick={() => setProofZoom(z => Math.min(4, +(z + 0.25).toFixed(2)))}
                  disabled={proofZoom >= 4}
                  title="Zoom in"
                  style={{
                    width: '28px', height: '28px', borderRadius: '6px', border: 'none',
                    background: 'transparent', color: theme.textSecondary,
                    fontSize: '16px', fontWeight: 700,
                    cursor: proofZoom >= 4 ? 'not-allowed' : 'pointer',
                    opacity: proofZoom >= 4 ? 0.4 : 1,
                  }}
                >
                  +
                </button>
              </div>
              <button
                onClick={() => { setCalibrationMode(false); setPendingCalibrationBox(null); setDrawingNewElement(false); setStep(2); }}
                style={{
                  padding: '8px 14px', borderRadius: '8px', border: `1px solid ${theme.border}`,
                  background: 'transparent', color: theme.textSecondary, fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                }}
              >
                ← Back
              </button>
              <button
                onClick={() => {
                  // Recalculate nesting with only included elements before moving to review
                  if (analysis.graphic_elements) {
                    recalculateNesting(analysis.graphic_elements, vehicleQty);
                  }
                  setStep(5);
                }}
                disabled={includedElements.size === 0}
                style={{
                  padding: '8px 14px', borderRadius: '8px', border: 'none',
                  background: includedElements.size === 0 ? theme.border : theme.orange,
                  color: includedElements.size === 0 ? theme.textMuted : '#fff',
                  fontSize: '12px', fontWeight: 700, cursor: includedElements.size === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                {includedElements.size > 0
                  ? `Continue (${includedElements.size} included) →`
                  : 'Select elements to continue'}
              </button>
            </div>
          </div>

          {/* Proof image — fills remaining space */}
          <div
            style={{
              flex: 1, overflow: 'auto', position: 'relative', userSelect: 'none',
              cursor: bboxDragging ? (bboxDragging.mode === 'move' ? 'grabbing' : 'nwse-resize') : 'crosshair',
              touchAction: (bboxDragging || touchDragging) ? 'none' : 'auto',
            }}
            onMouseDown={(e) => {
              if (bboxDragging) return;
              // Deselect bbox when clicking background
              setSelectedBboxIdx(null);
              // Always in drawing mode — start a new box (element or calibration)
              if (proofImgRef.current) {
                const rect = proofImgRef.current.getBoundingClientRect();
                setNewElementStart({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                setNewElementEnd({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                setIsDragging(true);
                return;
              }
            }}
            onMouseMove={(e) => {
              // Bbox drag/resize takes priority
              if (bboxDragging) {
                handleBboxMouseMove(e);
                return;
              }
              if (!isDragging || !proofImgRef.current) return;
              const rect = proofImgRef.current.getBoundingClientRect();
              const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
              const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
              setNewElementEnd({ x, y });
            }}
            onMouseUp={() => {
              // Bbox drag/resize
              if (bboxDragging) {
                handleBboxMouseUp();
                return;
              }
              // Finalize drawing — creates element or calibration box
              if (newElementStart && newElementEnd && proofImgRef.current) {
                setIsDragging(false);
                const sx = Math.min(newElementStart.x, newElementEnd.x);
                const sy = Math.min(newElementStart.y, newElementEnd.y);
                const sw = Math.abs(newElementEnd.x - newElementStart.x);
                const sh = Math.abs(newElementEnd.y - newElementStart.y);
                finalizeNewElement(proofImgRef.current, sx, sy, sw, sh);
                setNewElementStart(null);
                setNewElementEnd(null);
                return;
              }
              setIsDragging(false);
            }}
            onMouseLeave={() => {
              if (bboxDragging) {
                handleBboxMouseUp();
                return;
              }
              if (isDragging) {
                setIsDragging(false);
                setCropStart(null);
                setCropEnd(null);
              }
            }}
            onTouchStart={handleProofTouchStart}
            onTouchMove={(e) => {
              // Bbox touch events bubble up here for global move tracking
              handleBboxTouchMove(e);
              handleProofTouchMove(e);
            }}
            onTouchEnd={(e) => {
              handleProofTouchEnd();
            }}
          >
            {/* Inner wrapper sized exactly to the image so % bounding boxes align */}
            <div style={{ position: 'relative', display: 'inline-block', width: `${proofZoom * 100}%`, overflow: 'visible' }}>
              <img
                ref={proofImgRef}
                src={proofPreviewForReview || proofPreview || ''}
                alt={templateOnly ? 'Template' : 'Proof'}
                style={{ width: '100%', display: 'block', pointerEvents: 'none' }}
                draggable={false}
              />
              {/* Calibration status badge */}
              {calibrationRegions.length > 0 && (
                <div style={{
                  position: 'absolute', top: 6, right: 6, zIndex: 25,
                  background: 'rgba(16,185,129,0.85)', color: '#fff',
                  fontSize: '10px', fontWeight: 700, padding: '2px 8px',
                  borderRadius: '4px', pointerEvents: 'none',
                }}>
                  Calibrated · {calibrationRegions.length} panel{calibrationRegions.length !== 1 ? 's' : ''}
                </div>
              )}
              {/* Calibration region outlines — shows where panels were detected */}
              {calibrationRegions.map((region, i) => (
                <div
                  key={`cal-${i}`}
                  style={{
                    position: 'absolute',
                    left: `${region.img_x_pct}%`,
                    top: `${region.img_y_pct}%`,
                    width: `${region.img_w_pct}%`,
                    height: `${region.img_h_pct}%`,
                    border: '1px dashed rgba(255,255,255,0.3)',
                    pointerEvents: 'none',
                    zIndex: 0,
                  }}
                >
                  <div style={{
                    position: 'absolute', top: '-14px', left: '2px',
                    fontSize: '9px', color: 'rgba(255,255,255,0.5)',
                    whiteSpace: 'nowrap', pointerEvents: 'none',
                  }}>
                    {region.panel_name} ({region.width_in}&quot;×{region.height_in}&quot;)
                  </div>
                </div>
              ))}
              {/* AI-detected bounding boxes overlay — clean minimal UI */}
              {analysis.graphic_elements!.map((el, i) => {
                if (!el.crop_x_pct && el.crop_x_pct !== 0) return null;
                const isIncluded = includedElements.has(el.element_name);
                const isSelected = selectedBboxIdx === i;
                const isDraggingThis = bboxDragging?.idx === i;
                const showHandles = isSelected || isDraggingThis;
                const boxColors = [
                  '#FF6B35', '#4ECDC4', '#FFE66D', '#95E1D3', '#F38181',
                  '#AA96DA', '#A8D8EA', '#FCBAD3', '#C9CBA3', '#E8A87C',
                ];
                const color = boxColors[i % boxColors.length];
                // Resize handle helper
                // Corner-only resize handles — positioned inside box edges
                const handle = (pos: 'ne' | 'nw' | 'se' | 'sw') => {
                  const dot = 6; // matches ~2px border weight visually
                  const offset = -3; // center dot on corner
                  const cursors: Record<string, string> = { ne: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize', sw: 'nesw-resize' };
                  const posStyles: Record<string, React.CSSProperties> = {
                    nw: { top: offset, left: offset },
                    ne: { top: offset, right: offset },
                    sw: { bottom: offset, left: offset },
                    se: { bottom: offset, right: offset },
                  };
                  return (
                    <div
                      key={pos}
                      onMouseDown={(e) => handleBboxMouseDown(e, i, pos)}
                      style={{
                        position: 'absolute',
                        width: dot, height: dot,
                        background: color,
                        borderRadius: '50%',
                        cursor: cursors[pos],
                        zIndex: 15,
                        display: showHandles ? 'block' : 'none',
                        touchAction: 'none',
                        ...posStyles[pos],
                      }}
                    >
                      {/* Invisible expanded hit area for easier grabbing */}
                      <div style={{
                        position: 'absolute',
                        top: -8, left: -8, right: -8, bottom: -8,
                        borderRadius: '50%',
                      }} />
                    </div>
                  );
                };
                return (
                  <div
                    key={`bbox-${i}`}
                    onMouseEnter={() => setHoveredElement(el.element_name)}
                    onMouseLeave={() => { if (!bboxDragging) setHoveredElement(null); }}
                    onTouchStart={(e) => handleBboxTouchStart(e, i)}
                    onTouchEnd={(e) => handleBboxTouchEnd(e, i)}
                    onClick={(e) => { e.stopPropagation(); setSelectedBboxIdx(isSelected ? null : i); }}
                    style={{
                      position: 'absolute',
                      left: `${el.crop_x_pct}%`,
                      top: `${el.crop_y_pct}%`,
                      width: `${el.crop_w_pct}%`,
                      height: `${el.crop_h_pct}%`,
                      border: `2px solid ${isSelected ? '#fff' : color}`,
                      boxShadow: isSelected ? `0 0 0 2px ${color}, 0 0 12px ${color}80` : 'none',
                      background: isSelected ? `${color}25` : isIncluded ? `${color}10` : 'transparent',
                      opacity: isIncluded || isSelected ? 1 : 0.35,
                      pointerEvents: isDragging ? 'none' : 'auto',
                      zIndex: isDraggingThis ? 20 : isSelected ? 15 : 1,
                      borderRadius: '3px',
                      touchAction: 'none',
                      transition: 'box-shadow 0.15s, opacity 0.15s',
                      overflow: 'visible',
                    }}
                  >
                    {/* Drag body */}
                    <div
                      onMouseDown={(e) => handleBboxMouseDown(e, i, 'move')}
                      style={{
                        position: 'absolute', inset: '0',
                        cursor: 'grab',
                        touchAction: 'none',
                      }}
                    />
                    {/* Resize handles — corners only, shown when selected */}
                    {handle('nw')}{handle('ne')}
                    {handle('sw')}{handle('se')}
                    {/* Tiny number badge in corner */}
                    <div style={{
                      position: 'absolute',
                      top: '-8px', left: '-8px',
                      width: '16px', height: '16px',
                      borderRadius: '50%',
                      background: isIncluded ? color : 'rgba(100,100,100,0.7)',
                      color: '#fff',
                      fontSize: '9px',
                      fontWeight: 800,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      pointerEvents: 'none',
                      lineHeight: 1,
                      border: isSelected ? '2px solid #fff' : 'none',
                    }}>
                      {isIncluded ? '✓' : i + 1}
                    </div>
                    {/* Dimension label — shown when selected */}
                    {isSelected && (
                      <div style={{
                        position: 'absolute', bottom: '-18px', left: '50%', transform: 'translateX(-50%)',
                        fontSize: '10px', fontWeight: 800, color: '#fff',
                        background: 'rgba(0,0,0,0.75)', padding: '1px 6px', borderRadius: '4px',
                        pointerEvents: 'none', whiteSpace: 'nowrap', zIndex: 22,
                      }}>
                        {el.width_in}"×{el.height_in}"
                      </div>
                    )}
                  </div>
                );
              })}
              {/* Pending calibration box — shown after drawing, waiting for panel selection */}
              {pendingCalibrationBox && (
                <div style={{
                  position: 'absolute',
                  left: `${pendingCalibrationBox.xPct}%`,
                  top: `${pendingCalibrationBox.yPct}%`,
                  width: `${pendingCalibrationBox.wPct}%`,
                  height: `${pendingCalibrationBox.hPct}%`,
                  border: '2px dashed #fbbf24',
                  background: 'rgba(251,191,36,0.1)',
                  pointerEvents: 'none',
                  zIndex: 20, borderRadius: '3px',
                }}>
                  <div style={{
                    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                    fontSize: '11px', fontWeight: 800, color: '#fbbf24',
                    background: 'rgba(0,0,0,0.75)', padding: '3px 8px', borderRadius: '4px',
                    pointerEvents: 'none', whiteSpace: 'nowrap',
                  }}>
                    Select panel below
                  </div>
                </div>
              )}

              {/* Drawing rectangle — yellow for calibration, green for element */}
              {isDragging && newElementStart && newElementEnd && (() => {
                const sx = Math.min(newElementStart.x, newElementEnd.x);
                const sy = Math.min(newElementStart.y, newElementEnd.y);
                const sw = Math.abs(newElementEnd.x - newElementStart.x);
                const sh = Math.abs(newElementEnd.y - newElementStart.y);
                const isCal = calibrationMode;
                // Show live dimensions as you draw (only in element mode with calibration)
                const imgEl = proofImgRef.current;
                const imgRect = imgEl?.getBoundingClientRect();
                const wPct = imgRect ? (sw / imgRect.width) * 100 : 0;
                const hPct = imgRect ? (sh / imgRect.height) * 100 : 0;
                const xPct = imgRect ? (sx / imgRect.width) * 100 : 0;
                const yPct = imgRect ? (sy / imgRect.height) * 100 : 0;
                const dims = !isCal ? boxPctToInches(wPct, hPct, xPct, yPct) : null;
                return (
                  <>
                    <div style={{
                      position: 'absolute', left: sx, top: sy, width: sw, height: sh,
                      border: `2px dashed ${isCal ? '#fbbf24' : '#10b981'}`,
                      background: isCal ? 'rgba(251,191,36,0.1)' : 'rgba(16, 185, 129, 0.15)',
                      pointerEvents: 'none', borderRadius: '2px', zIndex: 20,
                    }} />
                    {isCal && sw > 30 && sh > 20 && (
                      <div style={{
                        position: 'absolute', left: sx + 4, top: sy + 4,
                        fontSize: '11px', fontWeight: 800, color: '#fbbf24',
                        background: 'rgba(0,0,0,0.7)', padding: '2px 6px', borderRadius: '4px',
                        pointerEvents: 'none', zIndex: 21, whiteSpace: 'nowrap',
                      }}>
                        Calibration panel
                      </div>
                    )}
                    {dims && sw > 30 && sh > 20 && (
                      <div style={{
                        position: 'absolute', left: sx + 4, top: sy + 4,
                        fontSize: '11px', fontWeight: 800, color: '#10b981',
                        background: 'rgba(0,0,0,0.7)', padding: '2px 6px', borderRadius: '4px',
                        pointerEvents: 'none', zIndex: 21, whiteSpace: 'nowrap',
                      }}>
                        {dims.width_in}" × {dims.height_in}"
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>

          {/* Bottom panel — three states: calibration, element detail, or element list */}
          {calibrationMode ? (
            /* ── CALIBRATION PANEL ── */
            <div style={{
              flexShrink: 0, maxHeight: '50vh', overflow: 'auto',
              background: theme.card, borderTop: '3px solid #fbbf24',
              padding: '12px 16px',
            }}>
              {pendingCalibrationBox ? (
                /* Panel picker — user drew a box, now select which panel */
                <>
                  <div style={{ fontSize: '13px', fontWeight: 800, color: '#fbbf24', marginBottom: '8px' }}>
                    Which panel did you draw?
                  </div>

                  {/* Show cropped preview of what the user drew */}
                  {proofImgRef.current && (() => {
                    const img = proofImgRef.current!;
                    const scaleX = img.naturalWidth / img.clientWidth;
                    const scaleY = img.naturalHeight / img.clientHeight;
                    const sx = (pendingCalibrationBox.xPct / 100) * img.clientWidth * scaleX;
                    const sy = (pendingCalibrationBox.yPct / 100) * img.clientHeight * scaleY;
                    const sw = (pendingCalibrationBox.wPct / 100) * img.clientWidth * scaleX;
                    const sh = (pendingCalibrationBox.hPct / 100) * img.clientHeight * scaleY;
                    // Render crop to a canvas data URL
                    const canvas = document.createElement('canvas');
                    const maxDim = 300;
                    const scale = Math.min(1, maxDim / Math.max(sw, sh));
                    canvas.width = Math.round(sw * scale);
                    canvas.height = Math.round(sh * scale);
                    const ctx = canvas.getContext('2d');
                    if (ctx) {
                      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
                      const cropUrl = canvas.toDataURL('image/jpeg', 0.85);
                      return (
                        <div style={{ marginBottom: '10px', borderRadius: '8px', overflow: 'hidden', border: '2px solid #fbbf24' }}>
                          <img src={cropUrl} alt="Your drawn area" style={{ width: '100%', display: 'block', maxHeight: '100px', objectFit: 'contain', background: '#000' }} />
                          <div style={{ fontSize: '10px', color: theme.textMuted, padding: '4px 8px', background: theme.inputBg, textAlign: 'center' }}>
                            Your drawn area — select the matching panel below
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })()}

                  <div style={{ fontSize: '11px', color: theme.warning, marginBottom: '8px', fontStyle: 'italic' }}>
                    Note: Panel dimensions include bleed. Match the full panel edge-to-edge.
                  </div>
                  {selectedTemplate?.panel_data?.map((panel, i) => (
                    <button
                      key={i}
                      onClick={() => finalizeCalibration(i)}
                      style={{
                        width: '100%', padding: '12px 14px', borderRadius: '10px', marginBottom: '6px',
                        border: `1px solid ${theme.border}`, background: theme.inputBg,
                        cursor: 'pointer', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      }}
                    >
                      <span style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{panel.name}</span>
                      <span style={{ fontSize: '12px', color: theme.textMuted }}>{panel.width_in}" × {panel.height_in}"</span>
                    </button>
                  ))}
                  <button
                    onClick={() => setPendingCalibrationBox(null)}
                    style={{
                      width: '100%', padding: '10px', borderRadius: '10px', marginTop: '4px',
                      border: `1px solid ${theme.border}`, background: 'transparent',
                      color: theme.textMuted, fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    Cancel — draw again
                  </button>
                </>
              ) : (
                /* Instructions — draw a calibration box */
                <>
                  <div style={{ fontSize: '14px', fontWeight: 800, color: theme.textPrimary, marginBottom: '6px' }}>
                    Set the Scale
                  </div>
                  <div style={{ fontSize: '13px', color: theme.textSecondary, marginBottom: '10px' }}>
                    On the proof image above, draw a box around one full vehicle panel (e.g. trace the driver side from bumper to bumper, bottom of body to roofline). Then select which panel it is from the list below.
                  </div>

                  {/* Reference image — vehicle template, full width so it's actually readable */}
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        Template (reference for panel names)
                      </div>
                      {templatePreviewUrl && (
                        <button
                          onClick={() => setEnlargedRef({ src: templatePreviewUrl, label: 'Template' })}
                          style={{
                            fontSize: '10px', fontWeight: 700, color: theme.navy,
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            textTransform: 'uppercase', letterSpacing: '0.5px', padding: 0,
                          }}
                        >
                          ⤢ Enlarge
                        </button>
                      )}
                    </div>
                    {templatePreviewUrl ? (
                      <img
                        src={templatePreviewUrl}
                        alt="Vehicle template"
                        title="Click to enlarge"
                        onClick={() => setEnlargedRef({ src: templatePreviewUrl, label: 'Template' })}
                        style={{
                          width: '100%', height: 'auto', display: 'block',
                          borderRadius: '6px', border: `1px solid ${theme.border}`,
                          background: '#fff', cursor: 'zoom-in',
                        }}
                      />
                    ) : (
                      <label style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                        width: '100%', height: '120px', borderRadius: '6px',
                        border: `2px dashed ${theme.border}`, background: theme.inputBg,
                        cursor: 'pointer', fontSize: '12px', color: theme.textMuted, textAlign: 'center',
                      }}>
                        <input
                          type="file"
                          accept=".png,.jpg,.jpeg"
                          style={{ display: 'none' }}
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file || !selectedTemplate) return;
                            try {
                              const slug = `${selectedTemplate.make}-${selectedTemplate.model}-${selectedTemplate.year || 'any'}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
                              const ext = file.name.split('.').pop() || 'png';
                              const path = `previews/${slug}.${ext}`;
                              await storage.from('vehicle-templates').upload(path, file, { upsert: true });
                              await supabase.from('vehicle_templates').update({ template_image_path: path }).eq('id', selectedTemplate.id);
                              const { data } = storage.from('vehicle-templates').getPublicUrl(path);
                              setTemplatePreviewUrl(data.publicUrl);
                            } catch (err) {
                              console.error('Failed to upload template image:', err);
                            }
                          }}
                        />
                        <span style={{ fontWeight: 700 }}>+ Upload template image</span>
                        <span style={{ fontSize: '10px', marginTop: '2px' }}>helps you identify which panel you drew</span>
                      </label>
                    )}
                  </div>

                  <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Available Panels
                  </div>
                  {selectedTemplate?.panel_data?.map((panel, i) => (
                    <div key={i} style={{
                      padding: '8px 12px', borderRadius: '8px', marginBottom: '4px',
                      background: theme.inputBg, border: `1px solid ${theme.border}`,
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: theme.textPrimary }}>{panel.name}</span>
                      <span style={{ fontSize: '12px', color: theme.textMuted }}>{panel.width_in}" × {panel.height_in}" ({panel.area_sqft.toFixed(1)} ft²)</span>
                    </div>
                  ))}
                  <button
                    onClick={() => setCalibrationMode(false)}
                    style={{
                      width: '100%', padding: '10px', borderRadius: '10px', marginTop: '10px',
                      border: `1px solid ${theme.border}`, background: 'transparent',
                      color: theme.textMuted, fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    Skip calibration (dimensions will use vehicle overall size)
                  </button>
                </>
              )}
            </div>
          ) : selectedBboxIdx !== null && analysis.graphic_elements?.[selectedBboxIdx] ? (() => {
            /* ── ELEMENT DETAIL PANEL ── */
            const sel = analysis.graphic_elements![selectedBboxIdx];
            const boxColors = [
              '#FF6B35', '#4ECDC4', '#FFE66D', '#95E1D3', '#F38181',
              '#AA96DA', '#A8D8EA', '#FCBAD3', '#C9CBA3', '#E8A87C',
            ];
            const color = boxColors[selectedBboxIdx % boxColors.length];
            return (
              <div style={{
                flexShrink: 0, background: theme.card, borderTop: `3px solid ${color}`,
                padding: '10px 16px', display: 'flex', gap: '10px', alignItems: 'center',
              }}>
                {/* Number badge */}
                <div style={{
                  width: '40px', height: '40px', borderRadius: '8px', flexShrink: 0,
                  background: theme.inputBg, border: `2px solid ${color}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '15px', fontWeight: 800, color,
                }}>{selectedBboxIdx + 1}</div>
                {/* Editable name + dimensions */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <input
                    value={sel.element_name}
                    onChange={(e) => {
                      const oldName = sel.element_name;
                      const newName = e.target.value;
                      sel.element_name = newName;
                      setAnalysis({ ...analysis });
                      setIncludedElements(prev => {
                        const next = new Set(prev);
                        if (next.has(oldName)) { next.delete(oldName); next.add(newName); }
                        return next;
                      });
                    }}
                    style={{
                      fontSize: '13px', fontWeight: 700, color: theme.textPrimary, width: '100%',
                      background: theme.inputBg, border: `1px solid ${theme.border}`, borderRadius: '6px',
                      padding: '3px 6px',
                    }}
                    placeholder="Element name"
                  />
                  <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '2px' }}>
                    {sel.width_in}" × {sel.height_in}" — {((sel.width_in * sel.height_in) / 144).toFixed(2)} sq ft
                  </div>
                </div>
                {/* Delete */}
                <button
                  onClick={() => {
                    const elements = analysis.graphic_elements!.filter((_, i) => i !== selectedBboxIdx);
                    setIncludedElements(prev => { const next = new Set(prev); next.delete(sel.element_name); return next; });
                    setAnalysis({ ...analysis, graphic_elements: elements });
                    setSelectedBboxIdx(null);
                  }}
                  style={{
                    padding: '6px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                    border: `1px solid rgba(239,68,68,0.3)`, background: 'rgba(239,68,68,0.1)',
                    color: '#ef4444', cursor: 'pointer', flexShrink: 0,
                  }}
                >
                  Delete
                </button>
                {/* Close */}
                <button
                  onClick={() => setSelectedBboxIdx(null)}
                  style={{
                    width: '28px', height: '28px', borderRadius: '50%', border: `1px solid ${theme.border}`,
                    background: 'transparent', color: theme.textMuted, fontSize: '14px',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}
                >✕</button>
              </div>
            );
          })() : (
            /* ── ELEMENT LIST PANEL ── */
            <div style={{
              flexShrink: 0, maxHeight: '40vh', overflow: 'auto',
              background: theme.card, borderTop: `1px solid ${theme.border}`,
              padding: '10px 16px',
            }}>
              {/* Calibration status */}
              {calibrationRegions.length > 0 && (
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '6px 10px', borderRadius: '8px', marginBottom: '10px',
                  background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)',
                }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: '#10b981' }}>
                    Scale: {calibrationRegions[0].panel_name} ({calibrationRegions[0].width_in}" × {calibrationRegions[0].height_in}")
                  </span>
                  <button
                    onClick={() => { setCalibrationMode(true); setPendingCalibrationBox(null); }}
                    style={{
                      fontSize: '11px', fontWeight: 700, color: theme.textMuted, background: 'transparent',
                      border: 'none', cursor: 'pointer', textDecoration: 'underline',
                    }}
                  >
                    Recalibrate
                  </button>
                </div>
              )}

              {/* Instructions or element list */}
              {(analysis.graphic_elements?.length || 0) === 0 ? (
                <div style={{ textAlign: 'center', padding: '16px', color: theme.textSecondary, fontSize: '13px' }}>
                  {calibrationRegions.length === 0
                    ? 'Calibrate first, then draw boxes around each graphic element'
                    : 'Draw boxes around each graphic element on the proof image'}
                </div>
              ) : (
                <>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Elements ({analysis.graphic_elements!.length})
                    {' · '}
                    {(analysis.graphic_elements!.reduce((sum, el) => sum + (el.width_in * el.height_in) / 144, 0)).toFixed(1)} sq ft total
                  </div>
                  {analysis.graphic_elements!.map((el, i) => {
                    const boxColors = [
                      '#FF6B35', '#4ECDC4', '#FFE66D', '#95E1D3', '#F38181',
                      '#AA96DA', '#A8D8EA', '#FCBAD3', '#C9CBA3', '#E8A87C',
                    ];
                    const color = boxColors[i % boxColors.length];
                    const sqft = ((el.width_in * el.height_in) / 144).toFixed(2);
                    return (
                      <div
                        key={i}
                        onClick={() => setSelectedBboxIdx(i)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '10px',
                          padding: '8px 12px', borderRadius: '10px',
                          background: `${color}10`, border: `1px solid ${color}40`,
                          marginBottom: '6px', cursor: 'pointer',
                        }}
                      >
                        <div style={{
                          width: '24px', height: '24px', borderRadius: '6px', flexShrink: 0,
                          background: color, color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '11px', fontWeight: 800,
                        }}>{i + 1}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {el.element_name}
                          </div>
                        </div>
                        <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textSecondary, flexShrink: 0 }}>
                          {el.width_in}" × {el.height_in}"
                        </div>
                        <div style={{ fontSize: '11px', color: theme.textMuted, flexShrink: 0 }}>
                          {sqft} ft²
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* Lightbox — full-resolution view of template / proof reference thumbnails */}
          {enlargedRef && (
            <div
              onClick={() => setEnlargedRef(null)}
              style={{
                position: 'fixed', inset: 0, zIndex: 400,
                background: 'rgba(0,0,0,0.92)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                padding: '40px', cursor: 'zoom-out',
              }}
            >
              <div style={{
                position: 'absolute', top: 16, left: 20,
                fontSize: '13px', fontWeight: 700, color: '#fff',
                textTransform: 'uppercase', letterSpacing: '0.5px',
              }}>
                {enlargedRef.label}
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); setEnlargedRef(null); }}
                style={{
                  position: 'absolute', top: 12, right: 16,
                  width: '36px', height: '36px', borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(0,0,0,0.4)',
                  color: '#fff', fontSize: '20px', fontWeight: 700, cursor: 'pointer',
                }}
                aria-label="Close"
              >
                ×
              </button>
              <img
                src={enlargedRef.src}
                alt={enlargedRef.label}
                onClick={(e) => e.stopPropagation()}
                style={{
                  maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
                  background: enlargedRef.label === 'Proof' ? '#000' : '#fff',
                  borderRadius: '8px', cursor: 'default',
                }}
              />
              <div style={{
                position: 'absolute', bottom: 16, left: 0, right: 0, textAlign: 'center',
                fontSize: '11px', color: 'rgba(255,255,255,0.6)',
              }}>
                Click outside the image to close
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 5: Results & Pricing */}
      {step === 5 && analysis && (
        <div>
          <div style={{ fontSize: '16px', fontWeight: 800, color: theme.textPrimary, marginBottom: '4px' }}>
            Step 5: Review & Price
          </div>
          <div style={{ fontSize: '13px', color: theme.textSecondary, marginBottom: '16px' }}>
            AI analysis complete. Review the coverage breakdown and set your pricing.
          </div>

          {/* AI Confidence */}
          <div style={{
            background: analysis.confidence === 'high' ? theme.successBg : theme.warningBg,
            border: `1px solid ${analysis.confidence === 'high' ? theme.successBorder : theme.warningBorder}`,
            borderRadius: '10px', padding: '10px 14px', marginBottom: '12px', fontSize: '13px',
            color: analysis.confidence === 'high' ? theme.success : theme.warning,
            fontWeight: 600,
          }}>
            AI Confidence: {analysis.confidence?.toUpperCase()}{nestingResult ? ` • ${nestingResult.roll_area_sqft?.toFixed(1)} sq ft roll material` : ` • ${analysis.total_vinyl_sqft?.toFixed(1)} sq ft vinyl`}
          </div>

          {/* Image Comparison */}
          <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, marginBottom: '10px' }}>What AI Analyzed</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <div>
                <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginBottom: '4px', textTransform: 'uppercase' }}>Template</div>
                {templatePreviewUrl ? (
                  <img src={templatePreviewUrl} alt="Template" style={{ width: '100%', borderRadius: '8px', background: '#fff', border: `1px solid ${theme.border}` }} />
                ) : (
                  <div style={{ padding: '20px', textAlign: 'center', background: theme.inputBg, borderRadius: '8px', fontSize: '12px', color: theme.textMuted }}>No preview</div>
                )}
              </div>
              <div>
                <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginBottom: '4px', textTransform: 'uppercase' }}>Proof Design</div>
                {proofPreviewForReview ? (
                  <img src={proofPreviewForReview} alt="Proof" style={{ width: '100%', borderRadius: '8px', border: `1px solid ${theme.border}` }} />
                ) : proofPreview ? (
                  <img src={proofPreview} alt="Proof" style={{ width: '100%', borderRadius: '8px', border: `1px solid ${theme.border}` }} />
                ) : (
                  <div style={{ padding: '20px', textAlign: 'center', background: theme.inputBg, borderRadius: '8px', fontSize: '12px', color: theme.textMuted }}>{proofFile?.name || 'No preview'}</div>
                )}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: nestingResult ? '1fr 1fr' : '1fr 1fr 1fr', gap: '6px', marginTop: '10px' }}>
              <div style={{ textAlign: 'center', padding: '8px', background: theme.subtleBg, borderRadius: '8px' }}>
                <div style={{ fontSize: '16px', fontWeight: 800, color: theme.textPrimary }}>{analysis.total_vehicle_sqft?.toFixed(0)}</div>
                <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>VEHICLE ft²</div>
              </div>
              {nestingResult ? (
                <div style={{ textAlign: 'center', padding: '8px', background: theme.subtleBg, borderRadius: '8px' }}>
                  <div style={{ fontSize: '16px', fontWeight: 800, color: theme.orange }}>{nestingResult.roll_area_sqft?.toFixed(1)}</div>
                  <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>ROLL ft²</div>
                </div>
              ) : (
                <>
                  <div style={{ textAlign: 'center', padding: '8px', background: theme.subtleBg, borderRadius: '8px' }}>
                    <div style={{ fontSize: '16px', fontWeight: 800, color: theme.orange }}>{analysis.total_vinyl_sqft?.toFixed(1)}</div>
                    <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>VINYL ft²</div>
                  </div>
                  <div style={{ textAlign: 'center', padding: '8px', background: theme.subtleBg, borderRadius: '8px' }}>
                    <div style={{ fontSize: '16px', fontWeight: 800, color: theme.textPrimary }}>{analysis.overall_coverage_pct?.toFixed(0)}%</div>
                    <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>COVERAGE</div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Roll Material Summary */}
          {nestingResult ? (
            <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
              <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, marginBottom: '10px' }}>Roll Material Summary</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                <div style={{ textAlign: 'center', padding: '8px', background: theme.subtleBg, borderRadius: '8px' }}>
                  <div style={{ fontSize: '14px', fontWeight: 800, color: theme.textPrimary }}>60"</div>
                  <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>WIDTH</div>
                </div>
                <div style={{ textAlign: 'center', padding: '8px', background: theme.subtleBg, borderRadius: '8px' }}>
                  <div style={{ fontSize: '14px', fontWeight: 800, color: theme.textPrimary }}>{nestingResult.roll_length_in?.toFixed(1)}"</div>
                  <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>LENGTH</div>
                </div>
                <div style={{ textAlign: 'center', padding: '8px', background: theme.subtleBg, borderRadius: '8px' }}>
                  <div style={{ fontSize: '14px', fontWeight: 800, color: theme.orange }}>{nestingResult.roll_area_sqft?.toFixed(1)} sq ft</div>
                  <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>AREA</div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
              <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, marginBottom: '10px' }}>Material Summary</div>
              <div style={{ textAlign: 'center', padding: '8px', background: theme.subtleBg, borderRadius: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 800, color: theme.orange }}>{analysis.total_vinyl_sqft?.toFixed(1)} sq ft</div>
                <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>VINYL AREA</div>
              </div>
            </div>
          )}

          {/* Vehicle Quantity */}
          {analysis.graphic_elements && analysis.graphic_elements.length > 0 && (
            <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 700, color: theme.textPrimary, marginBottom: '8px' }}>Number of Vehicles</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="number"
                  step="1"
                  min="1"
                  value={vehicleQty}
                  onChange={(e) => {
                    const newQty = Math.max(1, parseInt(e.target.value) || 1);
                    setVehicleQty(newQty);
                    if (analysis.graphic_elements) {
                      recalculateNesting(analysis.graphic_elements, newQty);
                    }
                  }}
                  style={{
                    flex: 1, padding: '10px', borderRadius: '8px', border: `1px solid ${theme.border}`,
                    background: theme.inputBg, color: theme.textPrimary, fontSize: '14px', fontWeight: 700,
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ fontSize: '12px', color: theme.textMuted }}>vehicles</div>
              </div>
              {vehicleQty > 1 && (
                <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '6px' }}>
                  Nesting {vehicleQty} sets of graphics on one roll for optimal material usage
                </div>
              )}
            </div>
          )}

          {/* Nesting Visualization — Drag & Drop (for element-based) */}
          {nestingResult && analysis.graphic_elements && (() => {
            const overlaps = getOverlaps();
            const hasOverlaps = overlaps.size > 0;
            // Add some padding below lowest element for drop room
            const viewH = Math.max(nestingResult.roll_length_in + 10, 40);
            const labelMargin = 7; // left margin for inch labels
            return (
              <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>Nesting Layout</div>
                  <div style={{ fontSize: '11px', color: theme.textMuted }}>Numbers match Element list · panel splits suffixed a/b · drag to move, double-click to rotate</div>
                </div>
                {hasOverlaps && (
                  <div style={{
                    padding: '6px 10px', borderRadius: '6px', marginBottom: '8px',
                    background: theme.warningBg, border: `1px solid ${theme.warningBorder}`,
                    fontSize: '12px', color: theme.warning, fontWeight: 600,
                  }}>
                    ⚠ Some elements overlap — drag them apart
                  </div>
                )}
                <div style={{ width: '100%', background: theme.inputBg, borderRadius: '8px', padding: '10px', marginBottom: '8px' }}>
                  <svg
                    ref={nestingSvgRef}
                    viewBox={`-${labelMargin} 0 ${60 + labelMargin} ${viewH}`}
                    style={{
                      width: '100%', height: 'auto', background: '#fff', borderRadius: '6px',
                      border: `1px solid ${theme.border}`, cursor: draggingIdx !== null ? 'grabbing' : 'default',
                      userSelect: 'none', touchAction: 'none',
                    }}
                    preserveAspectRatio="xMidYMid meet"
                    onMouseMove={handleNestDragMove}
                    onMouseUp={handleNestDragEnd}
                    onMouseLeave={handleNestDragEnd}
                    onTouchMove={handleNestTouchMove}
                    onTouchEnd={handleNestTouchEnd}
                    onTouchCancel={handleNestTouchEnd}
                  >
                    {/* Inch markers on left Y axis */}
                    {Array.from({ length: Math.ceil(viewH / 10) + 1 }, (_, i) => {
                      const y = i * 10;
                      if (y > viewH) return null;
                      return (
                        <g key={`ym${i}`}>
                          <line x1={-1} y1={y} x2={0} y2={y} stroke="#999" strokeWidth="0.2" />
                          <text
                            x={-1.5}
                            y={y + 0.5}
                            textAnchor="end"
                            fontSize="2"
                            fill="#999"
                            dominantBaseline="middle"
                          >
                            {y}"
                          </text>
                        </g>
                      );
                    })}
                    {/* Grid lines every 10" */}
                    {Array.from({ length: Math.ceil(viewH / 10) }, (_, i) => (
                      <line key={`gy${i}`} x1="0" y1={i * 10} x2="60" y2={i * 10} stroke="#eee" strokeWidth="0.15" />
                    ))}
                    {Array.from({ length: 6 }, (_, i) => (
                      <line key={`gx${i}`} x1={i * 10} y1="0" x2={i * 10} y2={viewH} stroke="#eee" strokeWidth="0.15" />
                    ))}

                    {/* Roll cut line */}
                    <line x1="0" y1={nestingResult.roll_length_in} x2="60" y2={nestingResult.roll_length_in} stroke={theme.orange} strokeWidth="0.3" strokeDasharray="1,1" />

                    {/* Roll outline */}
                    <rect x="0" y="0" width="60" height={viewH} fill="none" stroke={theme.border} strokeWidth="0.5" />

                    {/* Nested elements — draggable */}
                    {nestingResult.nested_elements.map((elem, idx) => {
                      const colors = [theme.orange, theme.navy, theme.success, theme.warning];
                      const color = overlaps.has(idx) ? '#ef4444' : colors[idx % colors.length];
                      const cropSrc = elementCrops[elem.element.element_name];
                      const isDragging = draggingIdx === idx;
                      return (
                        <g
                          key={idx}
                          style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
                          onMouseDown={(e) => handleNestDragStart(idx, e)}
                          onTouchStart={(e) => handleNestTouchStart(idx, e)}
                          onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); handleNestRotate(idx); }}
                        >
                          {/* Background fill */}
                          <rect
                            x={elem.x_in}
                            y={elem.y_in}
                            width={elem.total_width_in}
                            height={elem.total_height_in}
                            fill={color}
                            fillOpacity={isDragging ? 0.15 : 0.08}
                            stroke={color}
                            strokeWidth={isDragging ? 0.5 : 0.3}
                            strokeDasharray={overlaps.has(idx) ? '1,0.5' : 'none'}
                          />
                          {/* Cropped image — rotate 90° when element is rotated */}
                          {cropSrc && (() => {
                            const cx = elem.x_in + elem.total_width_in / 2;
                            const cy = elem.y_in + elem.total_height_in / 2;
                            // When rotated, draw image at swapped (original) dims then rotate around center
                            if (elem.rotated) {
                              return (
                                <image
                                  href={cropSrc}
                                  x={cx - elem.total_height_in / 2}
                                  y={cy - elem.total_width_in / 2}
                                  width={elem.total_height_in}
                                  height={elem.total_width_in}
                                  preserveAspectRatio="xMidYMid meet"
                                  opacity={isDragging ? 0.6 : 0.85}
                                  transform={`rotate(90, ${cx}, ${cy})`}
                                  style={{ pointerEvents: 'none' }}
                                />
                              );
                            }
                            return (
                              <image
                                href={cropSrc}
                                x={elem.x_in}
                                y={elem.y_in}
                                width={elem.total_width_in}
                                height={elem.total_height_in}
                                preserveAspectRatio="xMidYMid meet"
                                opacity={isDragging ? 0.6 : 0.85}
                                style={{ pointerEvents: 'none' }}
                              />
                            );
                          })()}
                          {/* Label by source element so layout matches the element list; panel splits get a/b/c. */}
                          {(() => {
                            const name = elem.element.element_name;
                            const panelMatch = name.match(/-(\d+)$/);
                            const baseName = panelMatch ? name.slice(0, -panelMatch[0].length) : name;
                            const numMatch = baseName.match(/(\d+)\s*$/);
                            const baseLabel = numMatch ? numMatch[1] : baseName;
                            const suffix = panelMatch
                              ? String.fromCharCode(96 + Math.min(26, parseInt(panelMatch[1], 10)))
                              : '';
                            const label = `${baseLabel}${suffix}`;
                            return (
                              <text
                                x={elem.x_in + elem.total_width_in / 2}
                                y={elem.y_in + elem.total_height_in / 2}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fontSize="1.8"
                                fill="#fff"
                                fontWeight="800"
                                stroke={color}
                                strokeWidth="0.15"
                                paintOrder="stroke"
                                style={{ pointerEvents: 'none' }}
                              >
                                {label}
                              </text>
                            );
                          })()}
                        </g>
                      );
                    })}
                  </svg>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '11px', color: theme.textMuted }}>
                    Roll: 60" × {nestingResult.roll_length_in?.toFixed(1)}" = {nestingResult.roll_area_sqft?.toFixed(1)} sq ft
                    {nestingResult.efficiency_pct > 0 && ` • ${nestingResult.efficiency_pct}% efficiency`}
                  </div>
                  <button
                    onClick={() => { if (analysis.graphic_elements) recalculateNesting(analysis.graphic_elements, vehicleQty); }}
                    style={{
                      padding: '4px 10px', borderRadius: '6px', border: `1px solid ${theme.border}`,
                      background: 'transparent', color: theme.textSecondary, fontSize: '11px', fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Reset Layout
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Panelized elements info */}
          {panelizedElements.length > 0 && (
            <div style={{
              background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)',
              borderRadius: '10px', padding: '12px 14px', marginBottom: '12px',
            }}>
              <div style={{ fontSize: '13px', fontWeight: 700, color: '#60a5fa', marginBottom: '6px' }}>
                {panelizedElements.length} element{panelizedElements.length > 1 ? 's' : ''} split into panels
              </div>
              <div style={{ fontSize: '12px', color: theme.textSecondary, marginBottom: '6px' }}>
                These elements exceeded 60" in both dimensions and were split into panels for the roll.
              </div>
              {panelizedElements.map((el, i) => {
                const numPanels = nestingResult?.nested_elements.filter(ne => ne.element.element_name.startsWith(el.element_name + '-')).length || 0;
                return (
                  <div key={i} style={{ fontSize: '12px', color: theme.textPrimary, padding: '2px 0' }}>
                    • {el.element_name} ({el.width_in}" × {el.height_in}") → {numPanels} panels
                  </div>
                );
              })}
            </div>
          )}

          {/* Elements List (for element-based) — with include/exclude toggles */}
          {analysis.graphic_elements && analysis.graphic_elements.length > 0 ? (
            <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>Graphic Elements</div>
                <div style={{ fontSize: '11px', color: theme.textMuted, fontWeight: 600 }}>
                  {includedElements.size} of {analysis.graphic_elements.length} in kit
                  {panelizedElements.length > 0 && (
                    <span style={{ color: '#60a5fa', marginLeft: '6px' }}>
                      ({panelizedElements.length} panelized)
                    </span>
                  )}
                </div>
              </div>
              {analysis.graphic_elements.map((el, i) => {
                const isIncluded = includedElements.has(el.element_name);
                return (
                  <div key={i} style={{
                    padding: '10px 0',
                    borderBottom: i < (analysis.graphic_elements?.length ?? 0) - 1 ? `1px solid ${theme.border}` : 'none',
                    opacity: isIncluded ? 1 : 0.45,
                    transition: 'opacity 0.15s',
                  }}>
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                      {/* Include/exclude toggle */}
                      <button
                        onClick={() => {
                          // Toggle and immediately recalculate with the new set
                          const next = new Set(includedElements);
                          if (next.has(el.element_name)) {
                            next.delete(el.element_name);
                          } else {
                            next.add(el.element_name);
                          }
                          setIncludedElements(next);
                          // Recalculate with updated set inline
                          const included = analysis.graphic_elements!.filter(e => next.has(e.element_name));
                          if (included.length === 0) {
                            setNestingResult(null);
                          } else {
                            const multiplied: GraphicElement[] = [];
                            for (let q = 0; q < vehicleQty; q++) {
                              included.forEach(e => multiplied.push({ ...e, element_name: vehicleQty > 1 ? `${e.element_name} (${q + 1})` : e.element_name }));
                            }
                            const withBleed = applyBleed(multiplied, 0);
                            setNestingResult(nestElementsOnRoll(withBleed, 60));
                          }
                        }}
                        style={{
                          width: '32px', height: '32px', borderRadius: '8px', flexShrink: 0,
                          border: `2px solid ${isIncluded ? theme.success : theme.border}`,
                          background: isIncluded ? theme.successBg : 'transparent',
                          color: isIncluded ? theme.success : theme.textMuted,
                          fontSize: '16px', fontWeight: 700, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          marginTop: '4px',
                        }}
                        title={isIncluded ? 'Click to exclude from kit' : 'Click to include in kit'}
                      >
                        {isIncluded ? '✓' : ''}
                      </button>
                      {/* Cropped thumbnail from proof */}
                      {elementCrops[el.element_name] ? (
                        <div style={{
                          width: '80px', height: '80px', flexShrink: 0, borderRadius: '6px',
                          border: `1px solid ${theme.border}`, background: theme.inputBg,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                        }}>
                          <img
                            src={elementCrops[el.element_name]}
                            alt={el.element_name}
                            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                          />
                        </div>
                      ) : (
                        <div style={{
                          width: '80px', height: '80px', borderRadius: '6px', flexShrink: 0,
                          background: theme.inputBg, border: `1px solid ${theme.border}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '10px', color: theme.textMuted, textAlign: 'center', padding: '4px',
                        }}>
                          No crop
                        </div>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div>
                            <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>
                              {el.element_name}
                              {!isIncluded && <span style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 400, marginLeft: '6px' }}>excluded</span>}
                            </div>
                            <div style={{ fontSize: '11px', background: theme.subtleBg, color: theme.textMuted, fontWeight: 600, marginTop: '2px', padding: '2px 6px', borderRadius: '4px', display: 'inline-block' }}>
                              {el.element_type}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textPrimary }}>{el.width_in.toFixed(1)}" × {el.height_in.toFixed(1)}"</div>
                            <div style={{ fontSize: '11px', color: theme.textMuted }}>{(el.width_in * el.height_in).toFixed(1)} sq in</div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                          <button
                            onClick={() => duplicateElement(i)}
                            style={{
                              padding: '4px 10px', borderRadius: '6px', border: `1px solid ${theme.border}`,
                              background: 'transparent', color: theme.textSecondary, fontSize: '11px', fontWeight: 600,
                              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                            }}
                            title="Duplicate this element (e.g. same graphic on both sides)"
                          >
                            ⧉ Duplicate
                          </button>
                          {el.element_name.includes('(copy') && (
                            <button
                              onClick={() => removeElement(i)}
                              style={{
                                padding: '4px 10px', borderRadius: '6px', border: `1px solid ${theme.border}`,
                                background: 'transparent', color: '#ef4444', fontSize: '11px', fontWeight: 600,
                                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                              }}
                              title="Remove this duplicate"
                            >
                              ✕ Remove
                            </button>
                          )}
                        </div>
                        {el.description && (
                          <div style={{ marginTop: '8px', padding: '8px 10px', background: theme.subtleBg, borderRadius: '8px', fontSize: '12px', color: theme.textSecondary, lineHeight: 1.5, borderLeft: `3px solid ${theme.orange}` }}>
                            {el.description}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
              <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, marginBottom: '10px' }}>Panel-by-Panel Breakdown</div>
              {analysis.panels?.map((p, i) => (
                <div key={i} style={{ padding: '10px 0', borderBottom: i < (analysis.panels?.length ?? 0) - 1 ? `1px solid ${theme.border}` : 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{p.panel_name}</div>
                      <div style={{ fontSize: '11px', color: theme.orange, fontWeight: 600, marginTop: '2px' }}>{p.vinyl_type}</div>
                    </div>
                    <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <div style={{ fontSize: '16px', fontWeight: 800, color: theme.orange }}>{p.vinyl_sqft?.toFixed(1)} ft²</div>
                      <div style={{ fontSize: '11px', color: theme.textMuted }}>{p.vinyl_coverage_pct}% of {p.panel_area_sqft?.toFixed(1)} ft²</div>
                    </div>
                  </div>
                  {/* Coverage bar */}
                  <div style={{ marginTop: '6px', height: '6px', borderRadius: '3px', background: theme.progressTrack }}>
                    <div style={{ height: '100%', width: `${Math.min(p.vinyl_coverage_pct, 100)}%`, background: theme.orange, borderRadius: '3px' }} />
                  </div>
                  {/* AI's reasoning for this panel */}
                  {p.description && (
                    <div style={{ marginTop: '8px', padding: '8px 10px', background: theme.subtleBg, borderRadius: '8px', fontSize: '12px', color: theme.textSecondary, lineHeight: 1.5, borderLeft: `3px solid ${theme.orange}` }}>
                      {p.description}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* AI Notes */}
          {analysis.notes && (
            <div style={{ background: theme.subtleBg, borderRadius: '10px', padding: '12px', marginBottom: '12px', fontSize: '12px', color: theme.textSecondary, lineHeight: 1.5, borderLeft: `3px solid ${theme.navy}` }}>
              <strong>AI Notes:</strong> {analysis.notes}
            </div>
          )}

          {/* Material Pricing */}
          <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, marginBottom: '12px' }}>Material</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginBottom: '4px' }}>Rate $/ft²</label>
                <input
                  type="number"
                  step="0.25"
                  value={materialRate}
                  onChange={e => setMaterialRate(parseFloat(e.target.value) || 0)}
                  style={{
                    width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${theme.border}`,
                    background: theme.inputBg, color: theme.textPrimary, fontSize: '14px', fontWeight: 700,
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginBottom: '4px' }}>Waste %</label>
                <input
                  type="number"
                  step="5"
                  value={wastePct}
                  onChange={e => setWastePct(parseFloat(e.target.value) || 0)}
                  style={{
                    width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${theme.border}`,
                    background: theme.inputBg, color: theme.textPrimary, fontSize: '14px', fontWeight: 700,
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </div>
            <div style={{ background: theme.subtleBg, borderRadius: '8px', padding: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '2px 0', color: theme.textMuted }}>
                <span>Base area</span>
                <span>{baseVinylSqft.toFixed(1)} ft²</span>
              </div>
              {wastePct > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '2px 0', color: theme.textMuted }}>
                  <span>+ {wastePct}% waste</span>
                  <span>{(vinylSqft - baseVinylSqft).toFixed(1)} ft²</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '2px 0', color: theme.textMuted }}>
                <span>Total material × {fmtCurrency(materialRate)}/ft²</span>
                <span>{vinylSqft.toFixed(1)} ft²</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', fontWeight: 700, padding: '6px 0 0', marginTop: '4px', borderTop: `1px solid ${theme.border}` }}>
                <span style={{ color: theme.textPrimary }}>Material Cost</span>
                <span style={{ color: theme.orange }}>{fmtCurrency(materialTotal)}</span>
              </div>
            </div>
          </div>

          {/* Install Labor Pricing */}
          <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, marginBottom: '12px' }}>Install Labor</div>
            <div style={{ marginBottom: '12px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginBottom: '4px' }}>Rate $/ft²</label>
              <input
                type="number"
                step="0.25"
                value={laborRate}
                onChange={e => setLaborRate(parseFloat(e.target.value) || 0)}
                style={{
                  width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${theme.border}`,
                  background: theme.inputBg, color: theme.textPrimary, fontSize: '14px', fontWeight: 700,
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ background: theme.subtleBg, borderRadius: '8px', padding: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '2px 0', color: theme.textMuted }}>
                <span>Install area × {fmtCurrency(laborRate)}/ft²</span>
                <span>{baseVinylSqft.toFixed(1)} ft²</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', fontWeight: 700, padding: '6px 0 0', marginTop: '4px', borderTop: `1px solid ${theme.border}` }}>
                <span style={{ color: theme.textPrimary }}>Labor Cost</span>
                <span style={{ color: theme.orange }}>{fmtCurrency(laborTotal)}</span>
              </div>
            </div>
          </div>

          {/* Quote Total */}
          <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>Quote Total</div>
              <div>
                <label style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginRight: '6px' }}>Profit Margin %</label>
                <input
                  type="number"
                  step="5"
                  value={marginPct}
                  onChange={e => setMarginPct(parseFloat(e.target.value) || 0)}
                  style={{
                    width: '70px', padding: '6px 8px', borderRadius: '6px', border: `1px solid ${theme.border}`,
                    background: theme.inputBg, color: theme.textPrimary, fontSize: '13px', fontWeight: 700,
                    boxSizing: 'border-box', textAlign: 'center',
                  }}
                />
              </div>
            </div>
            <div style={{ background: theme.subtleBg, borderRadius: '8px', padding: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '3px 0' }}>
                <span style={{ color: theme.textSecondary }}>Material Cost</span>
                <span style={{ color: theme.textPrimary, fontWeight: 600 }}>{fmtCurrency(materialTotal)}</span>
              </div>
              {marginPct > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '3px 0' }}>
                  <span style={{ color: theme.textSecondary }}>Material Margin ({marginPct}%)</span>
                  <span style={{ color: theme.textPrimary, fontWeight: 600 }}>{fmtCurrency(marginAmount)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '3px 0', fontWeight: 600 }}>
                <span style={{ color: theme.textSecondary }}>Material Sell</span>
                <span style={{ color: theme.textPrimary }}>{fmtCurrency(materialWithMargin)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '3px 0', borderTop: `1px solid ${theme.border}`, marginTop: '4px', paddingTop: '6px' }}>
                <span style={{ color: theme.textSecondary }}>Install Labor</span>
                <span style={{ color: theme.textPrimary, fontWeight: 600 }}>{fmtCurrency(laborTotal)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '18px', fontWeight: 800, padding: '8px 0 0', borderTop: `2px solid ${theme.border}`, marginTop: '6px' }}>
                <span style={{ color: theme.textPrimary }}>Total{vehicleQty > 1 ? ` (${vehicleQty} vehicles)` : ''}</span>
                <span style={{ color: theme.orange }}>{fmtCurrency(totalPrice)}</span>
              </div>
              {vehicleQty > 1 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '4px 0 0' }}>
                  <span style={{ color: theme.textMuted }}>Per Vehicle</span>
                  <span style={{ color: theme.textSecondary, fontWeight: 700 }}>{fmtCurrency(totalPrice / vehicleQty)}</span>
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setStep(analysis.graphic_elements?.length ? 4 : 3)}
              style={{
                flex: 1, padding: '14px', borderRadius: '12px', border: `1px solid ${theme.border}`,
                background: 'transparent', color: theme.textSecondary, fontSize: '15px', fontWeight: 700, cursor: 'pointer',
              }}
            >
              ← Back
            </button>
            <button
              onClick={saveQuote}
              disabled={saving}
              style={{
                flex: 2, padding: '14px', borderRadius: '12px', border: 'none',
                background: saving ? theme.border : theme.success,
                color: '#fff', fontSize: '15px', fontWeight: 700, cursor: 'pointer',
              }}
            >
              {saving ? 'Saving...' : `${editQuote ? 'Update' : 'Save'} Quote (${fmtCurrency(totalPrice)})`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============ Template Manager ============
function TemplatesManager() {
  const { user } = useAuth();
  const [templates, setTemplates] = useState<VehicleTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);

  // Upload form
  const [name, setName] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [variant, setVariant] = useState('');
  const [lengthIn, setLengthIn] = useState('');
  const [heightIn, setHeightIn] = useState('');
  const [wheelbaseIn, setWheelbaseIn] = useState('');
  const [epsFile, setEpsFile] = useState<File | null>(null);
  const [pngFile, setPngFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    loadTemplates();
  }, []);

  async function loadTemplates() {
    setLoading(true);
    const { data } = await supabase
      .from('vehicle_templates')
      .select('*')
      .order('make, model, year');
    setTemplates((data as VehicleTemplate[]) || []);
    setLoading(false);
  }

  async function handleUpload() {
    if (!name || !make || !model || !user) return;
    setUploading(true);

    try {
      let templateImagePath = '';
      let originalFilePath = '';
      const slug = `${make}-${model}-${year}-${Date.now()}`.toLowerCase().replace(/\s+/g, '-');

      // Upload original EPS
      if (epsFile) {
        const epsName = `${slug}.eps`;
        const { error } = await storage.from('vehicle-templates').upload(`originals/${epsName}`, epsFile);
        if (!error) originalFilePath = `originals/${epsName}`;
      }

      // Upload PNG preview (user can provide a pre-converted PNG, or we handle it)
      if (pngFile) {
        const pngName = `${slug}.png`;
        const { error } = await storage.from('vehicle-templates').upload(`previews/${pngName}`, pngFile);
        if (!error) templateImagePath = `previews/${pngName}`;
      }

      // Insert template record
      const { error: insertError } = await supabase.from('vehicle_templates').insert({
        name,
        make,
        model,
        year: year || null,
        variant: variant || null,
        overall_length_in: lengthIn ? parseFloat(lengthIn) : null,
        overall_height_in: heightIn ? parseFloat(heightIn) : null,
        wheelbase_in: wheelbaseIn ? parseFloat(wheelbaseIn) : null,
        template_image_path: templateImagePath || null,
        original_file_path: originalFilePath || null,
        created_by: user.id,
      });

      if (insertError) throw insertError;

      // Reset form
      setName(''); setMake(''); setModel(''); setYear(''); setVariant('');
      setLengthIn(''); setHeightIn(''); setWheelbaseIn('');
      setEpsFile(null); setPngFile(null);
      setShowUpload(false);
      loadTemplates();
    } catch (err: any) {
      alert('Upload error: ' + (err.message || 'Unknown error'));
    } finally {
      setUploading(false);
    }
  }

  async function deleteTemplate(id: string) {
    if (!confirm('Delete this template?')) return;
    await supabase.from('vehicle_templates').delete().eq('id', id);
    loadTemplates();
  }

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <button
        onClick={() => setShowUpload(!showUpload)}
        style={{
          width: '100%', padding: '12px', borderRadius: '12px', border: `2px dashed ${theme.border}`,
          background: showUpload ? theme.orangeSoft : 'transparent', color: showUpload ? theme.orange : theme.textSecondary,
          fontSize: '14px', fontWeight: 700, cursor: 'pointer', marginBottom: '16px',
        }}
      >
        {showUpload ? '✕ Cancel Upload' : '+ Add Vehicle Template'}
      </button>

      {/* Upload Form */}
      {showUpload && (
        <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, marginBottom: '12px' }}>New Template</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Template Name (e.g. Transit 148 HR)" style={inputStyle} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <input value={make} onChange={e => setMake(e.target.value)} placeholder="Make (e.g. Ford)" style={inputStyle} />
              <input value={model} onChange={e => setModel(e.target.value)} placeholder="Model (e.g. Transit)" style={inputStyle} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <input value={year} onChange={e => setYear(e.target.value)} placeholder="Year (e.g. 2025)" style={inputStyle} />
              <input value={variant} onChange={e => setVariant(e.target.value)} placeholder="Variant (e.g. 148 HR)" style={inputStyle} />
            </div>

            <div style={{ fontSize: '12px', fontWeight: 700, color: theme.textMuted, marginTop: '4px' }}>Dimensions (inches) — optional, AI can read from template</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
              <input value={lengthIn} onChange={e => setLengthIn(e.target.value)} placeholder="Length" type="number" style={inputStyle} />
              <input value={heightIn} onChange={e => setHeightIn(e.target.value)} placeholder="Height" type="number" style={inputStyle} />
              <input value={wheelbaseIn} onChange={e => setWheelbaseIn(e.target.value)} placeholder="Wheelbase" type="number" style={inputStyle} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <label style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '16px 8px',
                borderRadius: '10px', border: `2px dashed ${epsFile ? theme.success : theme.border}`,
                background: epsFile ? theme.successBg : theme.inputBg, cursor: 'pointer', fontSize: '12px',
              }}>
                <input type="file" accept=".eps" onChange={e => setEpsFile(e.target.files?.[0] || null)} style={{ display: 'none' }} />
                <span style={{ fontSize: '14px', fontWeight: 700 }}>{epsFile ? '✓' : 'EPS'}</span>
                <span style={{ fontWeight: 700, color: epsFile ? theme.success : theme.textSecondary, marginTop: '4px' }}>
                  {epsFile ? epsFile.name.slice(0, 20) : 'EPS File'}
                </span>
              </label>

              <label style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '16px 8px',
                borderRadius: '10px', border: `2px dashed ${pngFile ? theme.success : theme.border}`,
                background: pngFile ? theme.successBg : theme.inputBg, cursor: 'pointer', fontSize: '12px',
              }}>
                <input type="file" accept=".png,.jpg,.jpeg" onChange={e => setPngFile(e.target.files?.[0] || null)} style={{ display: 'none' }} />
                <span style={{ fontSize: '14px', fontWeight: 700 }}>{pngFile ? '✓' : 'IMG'}</span>
                <span style={{ fontWeight: 700, color: pngFile ? theme.success : theme.textSecondary, marginTop: '4px' }}>
                  {pngFile ? pngFile.name.slice(0, 20) : 'PNG Preview'}
                </span>
              </label>
            </div>

            <div style={{ fontSize: '11px', color: theme.textMuted, lineHeight: 1.4 }}>
              Upload the original EPS and a PNG preview. If you don&apos;t have a PNG, you can export one from Illustrator or use a converter.
            </div>

            <button
              onClick={handleUpload}
              disabled={!name || !make || !model || uploading}
              style={{
                padding: '12px', borderRadius: '10px', border: 'none',
                background: (!name || !make || !model || uploading) ? theme.border : theme.success,
                color: '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer',
              }}
            >
              {uploading ? 'Uploading...' : '✓ Save Template'}
            </button>
          </div>
        </div>
      )}

      {/* Templates List */}
      {templates.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: theme.textSecondary }}>
          <div style={{ fontSize: '15px', fontWeight: 600 }}>No templates yet</div>
          <div style={{ fontSize: '13px', marginTop: '4px' }}>Upload your 1:20 scale vehicle templates to get started</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {templates.map(t => (
            <div key={t.id} style={{
              background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px',
              overflow: 'hidden',
            }}>
              <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                {t.template_image_path ? (
                  <img
                    src={storage.from('vehicle-templates').getPublicUrl(t.template_image_path).data.publicUrl}
                    alt={t.name}
                    style={{ width: '300px', height: '180px', objectFit: 'contain', borderRadius: '8px', background: '#fff', flexShrink: 0 }}
                  />
                ) : (
                  <div style={{ width: '300px', height: '180px', borderRadius: '8px', background: theme.inputBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 700, color: theme.textMuted, flexShrink: 0 }}>No Preview</div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{t.name}</div>
                  <div style={{ fontSize: '12px', color: theme.textMuted }}>{t.year} {t.make} {t.model}</div>
                  {t.overall_length_in && (
                    <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '2px' }}>
                      {t.overall_length_in}&quot; L × {t.wheelbase_in}&quot; WB
                    </div>
                  )}
                  <button
                    onClick={() => {
                      if (window.confirm(`Delete template "${t.name}"? This cannot be undone.`)) deleteTemplate(t.id);
                    }}
                    style={{
                      marginTop: '8px', padding: '6px 14px', borderRadius: '8px',
                      background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
                      color: '#f87171', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    Delete Template
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ Shared Components ============
function LoadingSpinner() {
  return (
    <div style={{ textAlign: 'center', padding: '40px' }}>
      <div style={{
        width: '36px', height: '36px', border: '3px solid var(--border)',
        borderTopColor: 'var(--orange)', borderRadius: '50%', margin: '0 auto',
        animation: 'spin 1s linear infinite',
      }} />
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: '8px',
  border: '1px solid var(--border)', background: 'var(--input-bg)',
  color: 'var(--text-primary)', fontSize: '14px', outline: 'none',
  boxSizing: 'border-box' as const,
};
