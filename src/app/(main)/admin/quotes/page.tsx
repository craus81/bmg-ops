'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import type { VehicleTemplate, Quote, QuotePanel, QuoteElement, AIAnalysisResult, GraphicElement, RollNestingResult } from '@/lib/types';
import { applyBleed, nestElementsOnRoll } from '@/lib/nesting-algorithm';

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
  const { user, isAdmin } = useAuth();
  const [tab, setTab] = useState<'quotes' | 'templates' | 'new'>('quotes');

  if (!isAdmin) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px', color: theme.textSecondary }}>
        <div style={{ fontSize: '48px', marginBottom: '12px' }}>🔒</div>
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
          📐 Estimating
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

      {tab === 'quotes' && <QuotesList />}
      {tab === 'new' && <NewQuote onCreated={() => setTab('quotes')} />}
      {tab === 'templates' && <TemplatesManager />}
    </div>
  );
}

// ============ Quotes List ============
function QuotesList() {
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
    return <QuoteDetail quote={viewQuote} onBack={() => { setViewQuote(null); loadQuotes(); }} />;
  }

  if (quotes.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 20px', color: theme.textSecondary }}>
        <div style={{ fontSize: '48px', marginBottom: '12px' }}>📐</div>
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
              <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '2px' }}>{q.vehicle_description}</div>
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
function QuoteDetail({ quote, onBack }: { quote: Quote; onBack: () => void }) {
  const [panels, setPanels] = useState<QuotePanel[]>([]);
  const [elements, setElements] = useState<QuoteElement[]>([]);
  const [loading, setLoading] = useState(true);
  const [proofUrl, setProofUrl] = useState<string | null>(null);

  useEffect(() => {
    loadPanels();
    if (quote.proof_image_path) {
      const { data } = supabase.storage.from('quote-proofs').getPublicUrl(quote.proof_image_path);
      setProofUrl(data.publicUrl);
    }
  }, [quote]);

  async function loadPanels() {
    // Load elements if this is an element-based quote
    if (quote.analysis_version === 'individual_elements') {
      const { data } = await supabase
        .from('quote_elements')
        .select('*')
        .eq('quote_id', quote.id)
        .order('sort_order');
      setElements((data as QuoteElement[]) || []);
    } else {
      // Load panels for panel-based quotes
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

  return (
    <div>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: theme.orange, fontSize: '14px', fontWeight: 700, cursor: 'pointer', marginBottom: '12px', padding: 0 }}>
        ← Back to Quotes
      </button>

      {/* Header */}
      <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: theme.textPrimary }}>{quote.quote_number}</div>
            <div style={{ fontSize: '14px', color: theme.textSecondary, marginTop: '2px' }}>{quote.customer_name}</div>
            <div style={{ fontSize: '13px', color: theme.textMuted }}>{quote.vehicle_description}</div>
          </div>
          <div style={{ fontSize: '24px', fontWeight: 800, color: theme.orange }}>{fmtCurrency(quote.total_price)}</div>
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
          { label: 'Vinyl Area', value: `${quote.total_vinyl_sqft?.toFixed(1)} sq ft` },
          { label: 'Coverage', value: `${quote.coverage_percentage?.toFixed(0)}%` },
          { label: 'Material', value: fmtCurrency(quote.material_total) },
          { label: 'Labor', value: fmtCurrency(quote.labor_total) },
          { label: 'Subtotal', value: fmtCurrency(quote.subtotal) },
          { label: 'Markup', value: `${quote.markup_percentage}%` },
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
                  Positioned at: {el.nested_x_in.toFixed(1)}", {el.nested_y_in.toFixed(1)}" (with {el.bleed_in?.toFixed(3)}" bleed)
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
    </div>
  );
}

// ============ New Quote Creator ============
function NewQuote({ onCreated }: { onCreated: () => void }) {
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

  // Step 3: AI Analysis
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<AIAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState('');
  const [templatePreviewUrl, setTemplatePreviewUrl] = useState<string | null>(null);
  const [proofPreviewForReview, setProofPreviewForReview] = useState<string | null>(null);

  // Step 4: Pricing
  const [materialRate, setMaterialRate] = useState(2.50);
  const [laborRate, setLaborRate] = useState(4.00);
  const [markupPct, setMarkupPct] = useState(20);

  // Element-based quoting
  const [bleedSize, setBleedSize] = useState(0.5);
  const [nestingResult, setNestingResult] = useState<RollNestingResult | null>(null);

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadTemplates();
  }, []);

  async function loadTemplates() {
    const { data } = await supabase
      .from('vehicle_templates')
      .select('*')
      .order('make, model, year');
    setTemplates((data as VehicleTemplate[]) || []);
  }

  function recalculateNesting(elements: GraphicElement[], bleed: number) {
    const withBleed = applyBleed(elements, bleed);
    const result = nestElementsOnRoll(withBleed, 60);
    setNestingResult(result);
    return result;
  }

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
      // Get template image from storage
      let templateBase64 = '';
      let templateMediaType = 'image/png';

      if (selectedTemplate.template_image_path) {
        try {
          const { data } = supabase.storage
            .from('vehicle-templates')
            .getPublicUrl(selectedTemplate.template_image_path);

          // Save URL for Step 4 display
          setTemplatePreviewUrl(data.publicUrl);

          const imgResponse = await fetch(data.publicUrl);
          if (!imgResponse.ok) {
            throw new Error(`Failed to fetch template image: ${imgResponse.status}`);
          }
          const imgBlob = await imgResponse.blob();
          templateBase64 = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string).split(',')[1]);
            reader.readAsDataURL(imgBlob);
          });
          templateMediaType = imgBlob.type || 'image/png';
        } catch (fetchErr: any) {
          console.error('Template image fetch error:', fetchErr);
          throw new Error('Could not load template image from storage. Make sure the template has a PNG preview uploaded.');
        }
      } else {
        throw new Error('Selected template has no image. Please upload a PNG preview for this template in the Templates tab first.');
      }

      // Compress proof file (resize large user uploads to max 2048px wide)
      const proofCompressed = await compressImage(proofFile, 2048, 0.8);
      const proofBase64 = proofCompressed.base64;
      const proofMediaType = proofCompressed.mediaType;

      // Save proof preview for Step 4 display
      setProofPreviewForReview(`data:${proofMediaType};base64,${proofBase64}`);

      // Call our API route
      const response = await fetch('/api/analyze-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateImageBase64: templateBase64,
          proofImageBase64: proofBase64,
          templateMediaType,
          proofMediaType,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Server error: ${response.status}`);
      }

      const result = await response.json();

      setAnalysis(result.analysis);

      // Run nesting if analysis has graphic elements
      if (result.analysis.graphic_elements?.length) {
        recalculateNesting(result.analysis.graphic_elements, bleedSize);
      }

      setStep(4);
    } catch (err: any) {
      setAnalysisError(err.message || 'Analysis failed. Please try again.');
    } finally {
      setAnalyzing(false);
    }
  }

  // Save quote
  async function saveQuote() {
    if (!analysis || !user) return;
    setSaving(true);

    try {
      // Use nesting result for vinyl area if available
      const vinylSqft = nestingResult?.roll_area_sqft || analysis.total_vinyl_sqft || 0;

      const materialTotal = vinylSqft * materialRate;
      const laborTotal = vinylSqft * laborRate;
      const subtotal = materialTotal + laborTotal;
      const markupAmount = subtotal * (markupPct / 100);
      const totalPrice = subtotal + markupAmount;

      // Generate quote number from timestamp
      const now = new Date();
      const quoteNum = `QUO-${now.getFullYear().toString().slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${Date.now().toString().slice(-4)}`;

      // Upload proof file to storage
      let proofPath = '';
      if (proofFile) {
        const fileName = `${quoteNum}-proof-${Date.now()}.${proofFile.name.split('.').pop()}`;
        const { error: uploadError } = await supabase.storage
          .from('quote-proofs')
          .upload(fileName, proofFile);
        if (!uploadError) proofPath = fileName;
      }

      const isElementBased = !!(analysis.graphic_elements?.length);

      // Insert quote
      const { data: quoteData, error: quoteError } = await supabase
        .from('quotes')
        .insert({
          quote_number: quoteNum,
          customer_name: customerName,
          vehicle_description: selectedTemplate
            ? `${selectedTemplate.year || ''} ${selectedTemplate.make} ${selectedTemplate.model} ${selectedTemplate.variant || ''}`.trim()
            : '',
          template_id: selectedTemplate?.id || null,
          proof_image_path: proofPath || null,
          status: 'draft',
          ai_analysis: analysis,
          analysis_version: isElementBased ? 'individual_elements' : 'panel_coverage',
          total_vinyl_sqft: vinylSqft,
          coverage_percentage: analysis.overall_coverage_pct,
          material_cost_per_sqft: materialRate,
          labor_cost_per_sqft: laborRate,
          material_total: materialTotal,
          labor_total: laborTotal,
          subtotal: subtotal,
          markup_percentage: markupPct,
          total_price: totalPrice,
          nesting_result: nestingResult || null,
          notes: analysis.notes,
          created_by: user.id,
        })
        .select()
        .single();

      if (quoteError) throw quoteError;

      // Insert elements OR panels based on analysis type
      if (isElementBased && analysis.graphic_elements && quoteData) {
        const elementInserts = analysis.graphic_elements.map((el, i) => {
          const nested = nestingResult?.nested_elements[i];
          return {
            quote_id: quoteData.id,
            element_name: el.element_name,
            element_type: el.element_type,
            width_in: el.width_in,
            height_in: el.height_in,
            description: el.description,
            bleed_in: bleedSize,
            nested_x_in: nested?.x_in ?? null,
            nested_y_in: nested?.y_in ?? null,
            sort_order: i,
          };
        });
        await supabase.from('quote_elements').insert(elementInserts);
      } else if (analysis.panels && quoteData) {
        const panelInserts = analysis.panels.map((p, i) => ({
          quote_id: quoteData.id,
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

  // Calculated totals for step 4
  const vinylSqft = nestingResult?.roll_area_sqft || analysis?.total_vinyl_sqft || 0;
  const materialTotal = vinylSqft * materialRate;
  const laborTotal = vinylSqft * laborRate;
  const subtotal = materialTotal + laborTotal;
  const markupAmount = subtotal * (markupPct / 100);
  const totalPrice = subtotal + markupAmount;

  const filteredTemplates = templates.filter(t =>
    `${t.make} ${t.model} ${t.year} ${t.variant}`.toLowerCase().includes(templateSearch.toLowerCase())
  );

  return (
    <div>
      {/* Progress Steps */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '20px' }}>
        {[1, 2, 3, 4].map(s => (
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
                    display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '10px',
                    border: selectedTemplate?.id === t.id ? `2px solid ${theme.orange}` : `1px solid ${theme.border}`,
                    background: selectedTemplate?.id === t.id ? theme.orangeSoft : theme.card,
                    cursor: 'pointer', textAlign: 'left', width: '100%',
                  }}
                >
                  {t.template_image_path && (
                    <img
                      src={supabase.storage.from('vehicle-templates').getPublicUrl(t.template_image_path).data.publicUrl}
                      alt={t.name}
                      style={{ width: '80px', height: '50px', objectFit: 'contain', borderRadius: '6px', background: '#fff' }}
                    />
                  )}
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{t.name}</div>
                    <div style={{ fontSize: '12px', color: theme.textMuted }}>
                      {t.year} {t.make} {t.model} {t.variant || ''}
                    </div>
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
            Upload the proof/design file showing the proposed vinyl graphics for the {selectedTemplate?.name}
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
                  <div style={{ fontSize: '36px', marginBottom: '8px' }}>📄</div>
                )}
                <div style={{ fontSize: '14px', fontWeight: 700, color: theme.success }}>✓ {proofFile.name}</div>
                <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '4px' }}>Tap to change file</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: '36px', marginBottom: '8px' }}>📤</div>
                <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>Tap to upload proof</div>
                <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '4px' }}>PDF, PNG, or JPG</div>
              </>
            )}
          </label>

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
              onClick={() => setStep(3)}
              disabled={!proofFile}
              style={{
                flex: 2, padding: '14px', borderRadius: '12px', border: 'none',
                background: !proofFile ? theme.border : theme.navy,
                color: !proofFile ? theme.textMuted : '#fff',
                fontSize: '15px', fontWeight: 700, cursor: 'pointer',
              }}
            >
              Next: Analyze →
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
            AI will compare the proof design against the {selectedTemplate?.name} template to estimate vinyl coverage
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
              <span style={{ color: theme.textSecondary }}>Proof:</span>
              <span style={{ color: theme.textPrimary, fontWeight: 700 }}>{proofFile?.name}</span>
            </div>
          </div>

          {analysisError && (
            <div style={{ background: theme.errorBg, border: `1px solid ${theme.errorBorder}`, borderRadius: '10px', padding: '12px', marginBottom: '16px', fontSize: '13px', color: theme.error }}>
              ⚠️ {analysisError}
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
                🤖 AI is analyzing your proof...
              </div>
              <div style={{ color: theme.textMuted, marginTop: '6px', fontSize: '13px' }}>
                Comparing proof against template dimensions to estimate vinyl coverage. This may take 15-30 seconds.
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
                onClick={runAnalysis}
                style={{
                  flex: 2, padding: '14px', borderRadius: '12px', border: 'none',
                  background: theme.orange, color: '#fff',
                  fontSize: '15px', fontWeight: 700, cursor: 'pointer',
                }}
              >
                🤖 Run AI Analysis
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step 4: Results & Pricing */}
      {step === 4 && analysis && (
        <div>
          <div style={{ fontSize: '16px', fontWeight: 800, color: theme.textPrimary, marginBottom: '4px' }}>
            Step 4: Review & Price
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
            AI Confidence: {analysis.confidence?.toUpperCase()} • {analysis.total_vinyl_sqft?.toFixed(1)} sq ft total vinyl
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginTop: '10px' }}>
              <div style={{ textAlign: 'center', padding: '8px', background: theme.subtleBg, borderRadius: '8px' }}>
                <div style={{ fontSize: '16px', fontWeight: 800, color: theme.textPrimary }}>{analysis.total_vehicle_sqft?.toFixed(0)}</div>
                <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>TOTAL ft²</div>
              </div>
              <div style={{ textAlign: 'center', padding: '8px', background: theme.subtleBg, borderRadius: '8px' }}>
                <div style={{ fontSize: '16px', fontWeight: 800, color: theme.orange }}>{analysis.total_vinyl_sqft?.toFixed(1)}</div>
                <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>VINYL ft²</div>
              </div>
              <div style={{ textAlign: 'center', padding: '8px', background: theme.subtleBg, borderRadius: '8px' }}>
                <div style={{ fontSize: '16px', fontWeight: 800, color: theme.textPrimary }}>{analysis.overall_coverage_pct?.toFixed(0)}%</div>
                <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>COVERAGE</div>
              </div>
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

          {/* Bleed Control (for element-based) */}
          {analysis.graphic_elements && analysis.graphic_elements.length > 0 && (
            <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 700, color: theme.textPrimary, marginBottom: '8px' }}>Bleed Per Side</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="number"
                  step="0.125"
                  min="0"
                  max="2"
                  value={bleedSize}
                  onChange={(e) => {
                    const newBleed = parseFloat(e.target.value) || 0;
                    setBleedSize(newBleed);
                    if (analysis.graphic_elements) {
                      recalculateNesting(analysis.graphic_elements, newBleed);
                    }
                  }}
                  style={{
                    flex: 1, padding: '10px', borderRadius: '8px', border: `1px solid ${theme.border}`,
                    background: theme.inputBg, color: theme.textPrimary, fontSize: '14px', fontWeight: 700,
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ fontSize: '12px', color: theme.textMuted }}>in</div>
              </div>
            </div>
          )}

          {/* Nesting Visualization (for element-based) */}
          {nestingResult && analysis.graphic_elements && (
            <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
              <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, marginBottom: '10px' }}>Nesting Layout</div>
              <div style={{ width: '100%', background: theme.inputBg, borderRadius: '8px', padding: '10px', marginBottom: '8px' }}>
                <svg
                  viewBox={`0 0 60 ${nestingResult.roll_length_in}`}
                  style={{ width: '100%', height: 'auto', background: '#fff', borderRadius: '6px', border: `1px solid ${theme.border}` }}
                  preserveAspectRatio="xMidYMid meet"
                >
                  {/* Roll outline */}
                  <rect x="0" y="0" width="60" height={nestingResult.roll_length_in} fill="none" stroke={theme.border} strokeWidth="0.5" />

                  {/* Nested elements */}
                  {nestingResult.nested_elements.map((elem, idx) => {
                    const colors = [theme.orange, theme.navy, theme.success, theme.warning];
                    const color = colors[idx % colors.length];
                    const elementData = analysis.graphic_elements![idx];
                    return (
                      <g key={idx}>
                        <rect
                          x={elem.x_in}
                          y={elem.y_in}
                          width={elementData.width_in}
                          height={elementData.height_in}
                          fill={color}
                          fillOpacity="0.2"
                          stroke={color}
                          strokeWidth="0.3"
                        />
                        <text
                          x={elem.x_in + elementData.width_in / 2}
                          y={elem.y_in + elementData.height_in / 2}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fontSize="1.5"
                          fill={color}
                          fontWeight="700"
                        >
                          {idx + 1}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
              <div style={{ fontSize: '11px', color: theme.textMuted, textAlign: 'center' }}>
                Roll: 60" × {nestingResult.roll_length_in?.toFixed(1)}" = {nestingResult.roll_area_sqft?.toFixed(1)} sq ft
              </div>
            </div>
          )}

          {/* Elements List (for element-based) */}
          {analysis.graphic_elements && analysis.graphic_elements.length > 0 ? (
            <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
              <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, marginBottom: '10px' }}>Graphic Elements</div>
              {analysis.graphic_elements.map((el, i) => (
                <div key={i} style={{ padding: '10px 0', borderBottom: i < analysis.graphic_elements.length - 1 ? `1px solid ${theme.border}` : 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{el.element_name}</div>
                      <div style={{ fontSize: '11px', background: theme.subtleBg, color: theme.textMuted, fontWeight: 600, marginTop: '2px', padding: '2px 6px', borderRadius: '4px', display: 'inline-block' }}>
                        {el.element_type}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: theme.textPrimary }}>{el.width_in.toFixed(1)}" × {el.height_in.toFixed(1)}"</div>
                      <div style={{ fontSize: '11px', color: theme.textMuted }}>{(el.width_in * el.height_in).toFixed(1)} sq in</div>
                    </div>
                  </div>
                  {el.description && (
                    <div style={{ marginTop: '8px', padding: '8px 10px', background: theme.subtleBg, borderRadius: '8px', fontSize: '12px', color: theme.textSecondary, lineHeight: 1.5, borderLeft: `3px solid ${theme.orange}` }}>
                      {el.description}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
              <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, marginBottom: '10px' }}>Panel-by-Panel Breakdown</div>
              {analysis.panels?.map((p, i) => (
                <div key={i} style={{ padding: '10px 0', borderBottom: i < analysis.panels.length - 1 ? `1px solid ${theme.border}` : 'none' }}>
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
                      🤖 {p.description}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* AI Notes */}
          {analysis.notes && (
            <div style={{ background: theme.subtleBg, borderRadius: '10px', padding: '12px', marginBottom: '12px', fontSize: '12px', color: theme.textSecondary, lineHeight: 1.5, borderLeft: `3px solid ${theme.navy}` }}>
              📝 <strong>AI Notes:</strong> {analysis.notes}
            </div>
          )}

          {/* Pricing Controls */}
          <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '14px', marginBottom: '12px' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary, marginBottom: '12px' }}>Pricing</div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginBottom: '4px' }}>Material $/ft²</label>
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
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginBottom: '4px' }}>Labor $/ft²</label>
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
              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: theme.textMuted, marginBottom: '4px' }}>Markup %</label>
                <input
                  type="number"
                  step="5"
                  value={markupPct}
                  onChange={e => setMarkupPct(parseFloat(e.target.value) || 0)}
                  style={{
                    width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${theme.border}`,
                    background: theme.inputBg, color: theme.textPrimary, fontSize: '14px', fontWeight: 700,
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </div>

            {/* Price summary */}
            <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: '12px' }}>
              {[
                {
                  label: nestingResult
                    ? `Material (Roll: 60" × ${nestingResult.roll_length_in?.toFixed(1)}" = ${vinylSqft.toFixed(1)} sq ft × ${fmtCurrency(materialRate)})`
                    : `Material (${vinylSqft.toFixed(1)} ft² × ${fmtCurrency(materialRate)})`,
                  value: fmtCurrency(materialTotal)
                },
                { label: `Labor (${vinylSqft.toFixed(1)} ft² × ${fmtCurrency(laborRate)})`, value: fmtCurrency(laborTotal) },
                { label: 'Subtotal', value: fmtCurrency(subtotal) },
                { label: `Markup (${markupPct}%)`, value: fmtCurrency(markupAmount) },
              ].map(row => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '4px 0' }}>
                  <span style={{ color: theme.textSecondary }}>{row.label}</span>
                  <span style={{ color: theme.textPrimary, fontWeight: 600 }}>{row.value}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '18px', fontWeight: 800, padding: '10px 0 0', borderTop: `2px solid ${theme.border}`, marginTop: '8px' }}>
                <span style={{ color: theme.textPrimary }}>Total</span>
                <span style={{ color: theme.orange }}>{fmtCurrency(totalPrice)}</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setStep(3)}
              style={{
                flex: 1, padding: '14px', borderRadius: '12px', border: `1px solid ${theme.border}`,
                background: 'transparent', color: theme.textSecondary, fontSize: '15px', fontWeight: 700, cursor: 'pointer',
              }}
            >
              ← Re-analyze
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
              {saving ? 'Saving...' : `💾 Save Quote (${fmtCurrency(totalPrice)})`}
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
        const { error } = await supabase.storage.from('vehicle-templates').upload(`originals/${epsName}`, epsFile);
        if (!error) originalFilePath = `originals/${epsName}`;
      }

      // Upload PNG preview (user can provide a pre-converted PNG, or we handle it)
      if (pngFile) {
        const pngName = `${slug}.png`;
        const { error } = await supabase.storage.from('vehicle-templates').upload(`previews/${pngName}`, pngFile);
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
                <span style={{ fontSize: '24px' }}>{epsFile ? '✓' : '📎'}</span>
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
                <span style={{ fontSize: '24px' }}>{pngFile ? '✓' : '🖼️'}</span>
                <span style={{ fontWeight: 700, color: pngFile ? theme.success : theme.textSecondary, marginTop: '4px' }}>
                  {pngFile ? pngFile.name.slice(0, 20) : 'PNG Preview'}
                </span>
              </label>
            </div>

            <div style={{ fontSize: '11px', color: theme.textMuted, lineHeight: 1.4 }}>
              💡 Upload the original EPS and a PNG preview. If you don&apos;t have a PNG, you can export one from Illustrator or use a converter.
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
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>🚐</div>
          <div style={{ fontSize: '15px', fontWeight: 600 }}>No templates yet</div>
          <div style={{ fontSize: '13px', marginTop: '4px' }}>Upload your 1:20 scale vehicle templates to get started</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {templates.map(t => (
            <div key={t.id} style={{
              background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px',
              padding: '12px', display: 'flex', alignItems: 'center', gap: '12px',
            }}>
              {t.template_image_path ? (
                <img
                  src={supabase.storage.from('vehicle-templates').getPublicUrl(t.template_image_path).data.publicUrl}
                  alt={t.name}
                  style={{ width: '100px', height: '60px', objectFit: 'contain', borderRadius: '8px', background: '#fff', flexShrink: 0 }}
                />
              ) : (
                <div style={{ width: '100px', height: '60px', borderRadius: '8px', background: theme.inputBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', flexShrink: 0 }}>🚐</div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{t.name}</div>
                <div style={{ fontSize: '12px', color: theme.textMuted }}>{t.year} {t.make} {t.model}</div>
                {t.overall_length_in && (
                  <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '2px' }}>
                    {t.overall_length_in}&quot; L × {t.wheelbase_in}&quot; WB
                  </div>
                )}
              </div>
              <button
                onClick={() => deleteTemplate(t.id)}
                style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', padding: '4px', color: theme.textMuted }}
              >🗑️</button>
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
