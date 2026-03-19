'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import SwipeToDelete from '@/components/SwipeToDelete';
import { parseMasterackPO, type ParsedPO, type ParsedPOLine } from '@/lib/parsePO';
import type { PurchaseOrder, POLineItem, CatalogItem } from '@/lib/types';

interface ImportLine extends ParsedPOLine {
  catalog_match: CatalogItem | null;
  use_catalog_price: boolean;
  final_price: number;
  include: boolean;
  // Fields for creating new catalog entry if unmatched
  new_end_customer: string;
  new_vehicle_type: string;
  new_graphic_package: string;
}

export default function POsPage() {
  const router = useRouter();
  const { isAdmin, user } = useAuth();
  const supabase = createClient();

  const [pos, setPos] = useState<(PurchaseOrder & { line_items: POLineItem[] })[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [expandedPo, setExpandedPo] = useState<string | null>(null);
  const [editPoId, setEditPoId] = useState<string | null>(null);
  const [editPoForm, setEditPoForm] = useState({ po_number: '', customer: '', status: '' as string });
  const [editLineId, setEditLineId] = useState<string | null>(null);
  const [editLineForm, setEditLineForm] = useState({ quantity: '', unit_price: '' });
  const [form, setForm] = useState({ po_number: '', customer: 'Masterack' });
  const [lineItems, setLineItems] = useState<{ catalog_id: string; part_number: string; quantity: number; unit_price: number }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // PDF Import state
  const [parsedPO, setParsedPO] = useState<ParsedPO | null>(null);
  const [importLines, setImportLines] = useState<ImportLine[]>([]);
  const [parseError, setParseError] = useState('');
  const [importing, setImporting] = useState(false);

  // Gmail Import state
  const [showEmailImport, setShowEmailImport] = useState(false);
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailEmails, setEmailEmails] = useState<any[]>([]);
  const [emailError, setEmailError] = useState('');
  const [emailNeedsAuth, setEmailNeedsAuth] = useState(false);
  const [importingEmailId, setImportingEmailId] = useState<string | null>(null);
  const [emailImportResults, setEmailImportResults] = useState<Record<string, any>>({});

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    const load = async () => {
      const { data: poData } = await supabase
        .from('purchase_orders')
        .select('*, po_line_items(*)')
        .order('created_at', { ascending: false });

      const mapped = (poData || []).map((po: any) => ({
        ...po,
        line_items: po.po_line_items || [],
      }));
      setPos(mapped);

      const { data: catData } = await supabase.from('catalog').select('*').order('part_number');
      setCatalog((catData as CatalogItem[]) || []);
      setLoading(false);
    };
    load();
  }, [isAdmin]);

  // PDF Upload handler
  const handlePDFUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError('');
    setParsedPO(null);
    setImportLines([]);

    try {
      const parsed = await parseMasterackPO(file);
      if (!parsed.po_number) {
        setParseError('Could not find PO number in PDF');
        return;
      }
      if (parsed.lines.length === 0) {
        setParseError('No line items found in PDF');
        return;
      }

      // Check for duplicate PO
      const existing = pos.find((p) => p.po_number === parsed.po_number);
      if (existing) {
        setParseError(`PO #${parsed.po_number} already exists`);
        return;
      }

      // Match lines to catalog
      const lines: ImportLine[] = parsed.lines.map((line) => {
        const match = catalog.find((c) =>
          c.part_number.toUpperCase() === line.part_number.toUpperCase()
        );
        const poPrice = line.unit_price;
        const catPrice = match?.price || 0;
        return {
          ...line,
          catalog_match: match || null,
          use_catalog_price: catPrice > 0,
          final_price: catPrice > 0 ? catPrice : poPrice,
          include: true,
          new_end_customer: '',
          new_vehicle_type: '',
          new_graphic_package: line.description || '',
        };
      });

      setParsedPO(parsed);
      setImportLines(lines);
    } catch (err: any) {
      setParseError('Error parsing PDF: ' + (err.message || 'Unknown error'));
    }

    if (fileRef.current) fileRef.current.value = '';
  };

  const toggleLineInclude = (idx: number) => {
    setImportLines((prev) => prev.map((l, i) => i === idx ? { ...l, include: !l.include } : l));
  };

  const togglePriceSource = (idx: number) => {
    setImportLines((prev) => prev.map((l, i) => {
      if (i !== idx) return l;
      const useCatalog = !l.use_catalog_price;
      return {
        ...l,
        use_catalog_price: useCatalog,
        final_price: useCatalog ? (l.catalog_match?.price || l.unit_price) : l.unit_price,
      };
    }));
  };

  const updateFinalPrice = (idx: number, price: string) => {
    setImportLines((prev) => prev.map((l, i) => i === idx ? { ...l, final_price: parseFloat(price) || 0 } : l));
  };

  const handleImportPO = async () => {
    if (!parsedPO || !user) return;
    const linesToImport = importLines.filter((l) => l.include);
    if (linesToImport.length === 0) return;

    setImporting(true);

    // Create PO
    const { data: po, error } = await supabase
      .from('purchase_orders')
      .insert({ po_number: parsedPO.po_number, customer: 'Masterack', created_by: user.id })
      .select()
      .single();

    if (!po || error) {
      alert('Error creating PO: ' + error?.message);
      setImporting(false);
      return;
    }

    // Auto-create catalog entries for unmatched parts
    for (const l of linesToImport) {
      if (!l.catalog_match) {
        const { data: newCat } = await supabase
          .from('catalog')
          .insert({
            part_number: l.part_number,
            customer: 'Masterack',
            end_customer: l.new_end_customer || '',
            vehicle_type: l.new_vehicle_type || '',
            graphic_package: l.new_graphic_package || l.description || '',
            price: l.final_price,
            proof_pages: 1,
            active: true,
          })
          .select()
          .single();

        if (newCat) {
          l.catalog_match = newCat as CatalogItem;
          // Update local catalog list
          setCatalog((prev) => [...prev, newCat as CatalogItem]);
        }
      }
    }

    // Create line items
    const { data: items } = await supabase
      .from('po_line_items')
      .insert(linesToImport.map((l) => ({
        po_id: po.id,
        catalog_id: l.catalog_match?.id || null,
        part_number: l.part_number,
        quantity: l.quantity,
        unit_price: l.final_price,
      })))
      .select();

    setPos((prev) => [{ ...po, line_items: (items as POLineItem[]) || [] }, ...prev]);
    setParsedPO(null);
    setImportLines([]);
    setShowImport(false);
    setImporting(false);
  };

  const cancelImport = () => {
    setParsedPO(null);
    setImportLines([]);
    setParseError('');
    setShowImport(false);
  };

  const addLineItem = (catId: string) => {
    const item = catalog.find((c) => c.id === catId);
    if (!item) return;
    setLineItems((prev) => [...prev, { catalog_id: item.id, part_number: item.part_number, quantity: 1, unit_price: item.price }]);
  };

  const handleCreate = async () => {
    if (!form.po_number || !form.customer || lineItems.length === 0 || !user) return;
    const { data: po, error } = await supabase
      .from('purchase_orders')
      .insert({ po_number: form.po_number, customer: form.customer, created_by: user.id })
      .select()
      .single();

    if (!po || error) { alert('Error: ' + error?.message); return; }

    const { data: items } = await supabase
      .from('po_line_items')
      .insert(lineItems.map((li) => ({ po_id: po.id, ...li })))
      .select();

    setPos((prev) => [{ ...po, line_items: (items as POLineItem[]) || [] }, ...prev]);
    setForm({ po_number: '', customer: 'Masterack' });
    setLineItems([]);
    setShowCreate(false);
  };

  const handleDeletePO = async (poId: string) => {
    await supabase.from('po_line_items').delete().eq('po_id', poId);
    const { error } = await supabase.from('purchase_orders').delete().eq('id', poId);
    if (!error) {
      setPos((prev) => prev.filter((p) => p.id !== poId));
    }
  };

  const handleDeleteLineItem = async (lineId: string, poId: string) => {
    const { error } = await supabase.from('po_line_items').delete().eq('id', lineId);
    if (!error) {
      setPos((prev) =>
        prev.map((po) =>
          po.id === poId
            ? { ...po, line_items: po.line_items.filter((li) => li.id !== lineId) }
            : po
        )
      );
    }
  };

  const startEditPO = (po: PurchaseOrder & { line_items: POLineItem[] }) => {
    setEditPoId(po.id);
    setEditPoForm({ po_number: po.po_number, customer: po.customer, status: po.status });
  };

  const saveEditPO = async () => {
    if (!editPoId) return;
    const { error } = await supabase
      .from('purchase_orders')
      .update({ po_number: editPoForm.po_number, customer: editPoForm.customer, status: editPoForm.status })
      .eq('id', editPoId);

    if (!error) {
      setPos((prev) =>
        prev.map((po) =>
          po.id === editPoId
            ? { ...po, po_number: editPoForm.po_number, customer: editPoForm.customer, status: editPoForm.status as any }
            : po
        )
      );
      setEditPoId(null);
    }
  };

  const startEditLine = (li: POLineItem) => {
    setEditLineId(li.id);
    setEditLineForm({ quantity: li.quantity.toString(), unit_price: li.unit_price.toString() });
  };

  const saveEditLine = async (poId: string) => {
    if (!editLineId) return;
    const qty = parseInt(editLineForm.quantity) || 1;
    const price = parseFloat(editLineForm.unit_price) || 0;
    const { error } = await supabase
      .from('po_line_items')
      .update({ quantity: qty, unit_price: price })
      .eq('id', editLineId);

    if (!error) {
      setPos((prev) =>
        prev.map((po) =>
          po.id === poId
            ? { ...po, line_items: po.line_items.map((li) => li.id === editLineId ? { ...li, quantity: qty, unit_price: price } : li) }
            : po
        )
      );
      setEditLineId(null);
    }
  };

  const toggleExpand = (poId: string) => {
    setExpandedPo(expandedPo === poId ? null : poId);
    setEditPoId(null);
    setEditLineId(null);
  };

  // Gmail import functions
  const searchGmailPOs = async (days = 30) => {
    setEmailLoading(true);
    setEmailError('');
    setEmailNeedsAuth(false);
    try {
      const res = await fetch(`/api/gmail/search-pos?days=${days}`);
      const data = await res.json();
      if (data.needsAuth) {
        setEmailNeedsAuth(true);
        return;
      }
      if (data.error) {
        setEmailError(data.error);
        return;
      }
      setEmailEmails(data.emails || []);
    } catch (err: any) {
      setEmailError(err.message || 'Failed to search Gmail');
    }
    setEmailLoading(false);
  };

  const importEmailPO = async (messageId: string) => {
    setImportingEmailId(messageId);
    try {
      const res = await fetch('/api/gmail/import-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, autoCreate: true }),
      });
      const data = await res.json();
      setEmailImportResults(prev => ({ ...prev, [messageId]: data }));

      // Refresh PO list if imported
      if (data.status === 'imported') {
        const { data: poData } = await supabase
          .from('purchase_orders')
          .select('*, po_line_items(*)')
          .order('created_at', { ascending: false });
        const mapped = (poData || []).map((po: any) => ({ ...po, line_items: po.po_line_items || [] }));
        setPos(mapped);
      }
    } catch (err: any) {
      setEmailImportResults(prev => ({ ...prev, [messageId]: { status: 'error', error: err.message } }));
    }
    setImportingEmailId(null);
  };

  const importAllNewPOs = async () => {
    const newEmails = emailEmails.filter(e => !e.alreadyImported && !e.alreadyInSystem && e.pdfs.length > 0);
    for (const email of newEmails) {
      await importEmailPO(email.messageId);
      // Small delay between imports
      await new Promise(r => setTimeout(r, 500));
    }
  };

  const fmt = (n: number) => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: '#4a5f78' }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Purchase Orders ({pos.length})
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={() => { setShowEmailImport(!showEmailImport); setShowImport(false); setShowCreate(false); if (!showEmailImport) searchGmailPOs(); }}
            style={{ padding: '6px 12px', borderRadius: '8px', background: showEmailImport ? '#1e2d3d' : 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#4ade80', fontSize: '12px', fontWeight: 700 }}
          >
            {showEmailImport ? 'Cancel' : '📧 Email Import'}
          </button>
          <button
            onClick={() => { setShowImport(!showImport); setShowCreate(false); setShowEmailImport(false); setParsedPO(null); setImportLines([]); setParseError(''); }}
            style={{ padding: '6px 12px', borderRadius: '8px', background: showImport ? '#1e2d3d' : 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#60a5fa', fontSize: '12px', fontWeight: 700 }}
          >
            {showImport ? 'Cancel' : '📄 Import PDF'}
          </button>
          <button
            onClick={() => { setShowCreate(!showCreate); setShowImport(false); setShowEmailImport(false); }}
            style={{ padding: '6px 12px', borderRadius: '8px', background: '#3b82f6', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}
          >
            {showCreate ? 'Cancel' : '+ New PO'}
          </button>
        </div>
      </div>

      {/* Gmail Email Import Panel */}
      {showEmailImport && (
        <div style={{ background: '#141e2b', border: '1px solid rgba(34,197,94,0.25)', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#e8ecf1' }}>Import POs from Gmail</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <select
                onChange={(e) => searchGmailPOs(parseInt(e.target.value))}
                style={{ padding: '4px 8px', borderRadius: '6px', background: '#1e2d3d', border: '1px solid #2a3a4d', color: '#e8ecf1', fontSize: '11px' }}
              >
                <option value="7">Last 7 days</option>
                <option value="30" selected>Last 30 days</option>
                <option value="90">Last 90 days</option>
              </select>
              <button
                onClick={() => searchGmailPOs()}
                style={{ padding: '4px 10px', borderRadius: '6px', background: '#2a3a4d', border: 'none', color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
              >Refresh</button>
            </div>
          </div>

          {emailNeedsAuth && (
            <div style={{ textAlign: 'center', padding: '20px' }}>
              <div style={{ fontSize: '12px', color: '#f59e0b', marginBottom: '10px' }}>Gmail is not connected. Authorize access to search for PO emails.</div>
              <a
                href="/api/auth/google"
                style={{ display: 'inline-block', padding: '10px 20px', borderRadius: '8px', background: '#3b82f6', color: '#fff', fontSize: '13px', fontWeight: 700, textDecoration: 'none' }}
              >Connect Gmail</a>
            </div>
          )}

          {emailError && !emailNeedsAuth && (
            <div style={{ padding: '8px', borderRadius: '6px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', fontSize: '11px', color: '#ef4444', marginBottom: '8px' }}>{emailError}</div>
          )}

          {emailLoading && (
            <div style={{ textAlign: 'center', padding: '20px' }}>
              <div style={{ fontSize: '12px', color: '#4a5f78' }}>Searching Gmail for PO emails...</div>
            </div>
          )}

          {!emailLoading && !emailNeedsAuth && emailEmails.length > 0 && (
            <div>
              {/* Summary */}
              {(() => {
                const newCount = emailEmails.filter(e => !e.alreadyImported && !e.alreadyInSystem && e.pdfs.length > 0).length;
                return newCount > 0 ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', borderRadius: '8px', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', marginBottom: '8px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 700, color: '#4ade80' }}>{newCount} new PO{newCount !== 1 ? 's' : ''} ready to import</span>
                    <button
                      onClick={importAllNewPOs}
                      disabled={importingEmailId !== null}
                      style={{ padding: '5px 12px', borderRadius: '6px', background: '#22c55e', border: 'none', color: '#fff', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                    >Import All</button>
                  </div>
                ) : (
                  <div style={{ fontSize: '11px', color: '#4a5f78', marginBottom: '8px' }}>All PO emails have been imported or already exist.</div>
                );
              })()}

              {/* Email list */}
              <div style={{ maxHeight: '400px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {emailEmails.map((email) => {
                  const result = emailImportResults[email.messageId];
                  const isImporting = importingEmailId === email.messageId;
                  const isNew = !email.alreadyImported && !email.alreadyInSystem && email.pdfs.length > 0;
                  const imported = result?.status === 'imported';
                  const skippedOrExists = email.alreadyImported || email.alreadyInSystem || result?.status === 'skipped';
                  const failed = result?.status === 'error';

                  const borderColor = imported ? 'rgba(34,197,94,0.3)' : failed ? 'rgba(239,68,68,0.3)' : skippedOrExists ? '#1e2d3d' : 'rgba(59,130,246,0.2)';
                  const bgColor = imported ? 'rgba(34,197,94,0.05)' : failed ? 'rgba(239,68,68,0.05)' : '#0f1720';

                  return (
                    <div key={email.messageId} style={{ padding: '10px', borderRadius: '8px', border: `1px solid ${borderColor}`, background: bgColor }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '12px', fontWeight: 700, color: '#e8ecf1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {email.poNumber ? `PO #${email.poNumber}` : email.subject}
                          </div>
                          <div style={{ fontSize: '10px', color: '#4a5f78', marginTop: '2px' }}>
                            {email.customer} · {email.from} · {new Date(email.date).toLocaleDateString()}
                          </div>
                          {email.pdfs.length > 0 && (
                            <div style={{ fontSize: '10px', color: '#4a5f78', marginTop: '1px' }}>
                              📎 {email.pdfs.map((p: any) => p.filename).join(', ')}
                            </div>
                          )}
                        </div>
                        <div style={{ flexShrink: 0 }}>
                          {imported && (
                            <span style={{ fontSize: '10px', fontWeight: 700, color: '#4ade80', padding: '3px 8px', borderRadius: '4px', background: 'rgba(34,197,94,0.1)' }}>
                              ✓ Imported ({result.lineCount} lines)
                            </span>
                          )}
                          {skippedOrExists && !imported && (
                            <span style={{ fontSize: '10px', fontWeight: 600, color: '#4a5f78', padding: '3px 8px', borderRadius: '4px', background: '#1e2d3d' }}>
                              Already exists
                            </span>
                          )}
                          {failed && (
                            <span style={{ fontSize: '10px', fontWeight: 600, color: '#ef4444', padding: '3px 8px', borderRadius: '4px', background: 'rgba(239,68,68,0.1)' }}>
                              Failed
                            </span>
                          )}
                          {isNew && !imported && !failed && (
                            <button
                              onClick={() => importEmailPO(email.messageId)}
                              disabled={isImporting}
                              style={{ padding: '4px 10px', borderRadius: '5px', background: isImporting ? '#1e2d3d' : '#3b82f6', border: 'none', color: '#fff', fontSize: '10px', fontWeight: 700, cursor: 'pointer' }}
                            >
                              {isImporting ? 'Importing...' : 'Import'}
                            </button>
                          )}
                          {email.pdfs.length === 0 && !skippedOrExists && (
                            <span style={{ fontSize: '10px', color: '#4a5f78' }}>No PDF</span>
                          )}
                        </div>
                      </div>
                      {failed && result.error && (
                        <div style={{ fontSize: '10px', color: '#ef4444', marginTop: '4px' }}>{result.error}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!emailLoading && !emailNeedsAuth && emailEmails.length === 0 && (
            <div style={{ textAlign: 'center', padding: '16px', fontSize: '12px', color: '#4a5f78' }}>
              No PO emails found in the selected timeframe.
            </div>
          )}
        </div>
      )}

      {/* PDF Import Panel */}
      {showImport && !parsedPO && (
        <div style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#e8ecf1', marginBottom: '6px' }}>Import Masterack PO from PDF</div>
          <div style={{ fontSize: '11px', color: '#4a5f78', marginBottom: '10px' }}>
            Upload a Masterack PO PDF. Part numbers, quantities, and prices will be extracted. You can review and edit before saving.
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf"
            onChange={handlePDFUpload}
            style={{ fontSize: '13px', color: '#e8ecf1' }}
          />
          {parseError && (
            <div style={{ marginTop: '10px', padding: '8px 12px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', color: '#f87171', fontSize: '12px' }}>
              {parseError}
            </div>
          )}
        </div>
      )}

      {/* Review imported PO before saving */}
      {parsedPO && (
        <div style={{ background: '#141e2b', border: '1px solid rgba(59,130,246,0.3)', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 800, color: '#e8ecf1' }}>PO #{parsedPO.po_number}</div>
              <div style={{ fontSize: '11px', color: '#4a5f78' }}>
                Masterack • {parsedPO.ordered_date} • {importLines.filter((l) => l.include).length} lines
                {importLines.filter((l) => l.include && !l.catalog_match).length > 0 && (
                  <span style={{ color: '#fbbf24', marginLeft: '6px' }}>
                    • {importLines.filter((l) => l.include && !l.catalog_match).length} new to catalog
                  </span>
                )}
              </div>
            </div>
            <div style={{ fontSize: '11px', color: '#60a5fa', fontWeight: 700 }}>REVIEW</div>
          </div>

          {/* Line items to review */}
          {importLines.map((line, idx) => (
            <div
              key={idx}
              style={{
                padding: '10px', marginBottom: '6px', borderRadius: '8px',
                background: line.include ? 'rgba(59,130,246,0.04)' : 'rgba(100,100,100,0.04)',
                border: `1px solid ${line.include ? 'rgba(59,130,246,0.15)' : 'rgba(100,100,100,0.15)'}`,
                opacity: line.include ? 1 : 0.5,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '6px' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: '14px', color: '#e8ecf1' }}>{line.part_number}</div>
                  <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '1px' }}>{line.description}</div>
                  {line.catalog_match ? (
                    <div style={{ fontSize: '10px', color: '#4ade80', marginTop: '3px' }}>✓ Found in catalog: {line.catalog_match.graphic_package || line.catalog_match.part_number}</div>
                  ) : (
                    <div>
                      <div style={{ fontSize: '10px', color: '#fbbf24', marginTop: '3px', marginBottom: '6px' }}>⚠ New part — will be added to catalog on import</div>
                      {line.include && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
                          <div>
                            <label style={{ display: 'block', fontSize: '8px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', marginBottom: '2px' }}>End Customer</label>
                            <input
                              value={line.new_end_customer}
                              onChange={(e) => setImportLines((prev) => prev.map((l, j) => j === idx ? { ...l, new_end_customer: e.target.value } : l))}
                              placeholder="e.g. Glass America"
                              style={{ width: '100%', padding: '5px 8px', borderRadius: '6px', border: '1px solid #1e2d3d', background: '#0f1720', color: '#e8ecf1', fontSize: '11px' }}
                            />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: '8px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', marginBottom: '2px' }}>Vehicle Type</label>
                            <input
                              value={line.new_vehicle_type}
                              onChange={(e) => setImportLines((prev) => prev.map((l, j) => j === idx ? { ...l, new_vehicle_type: e.target.value } : l))}
                              placeholder="e.g. Transit"
                              style={{ width: '100%', padding: '5px 8px', borderRadius: '6px', border: '1px solid #1e2d3d', background: '#0f1720', color: '#e8ecf1', fontSize: '11px' }}
                            />
                          </div>
                          <div style={{ gridColumn: 'span 2' }}>
                            <label style={{ display: 'block', fontSize: '8px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', marginBottom: '2px' }}>Graphic Package</label>
                            <input
                              value={line.new_graphic_package}
                              onChange={(e) => setImportLines((prev) => prev.map((l, j) => j === idx ? { ...l, new_graphic_package: e.target.value } : l))}
                              placeholder="e.g. Install decals"
                              style={{ width: '100%', padding: '5px 8px', borderRadius: '6px', border: '1px solid #1e2d3d', background: '#0f1720', color: '#e8ecf1', fontSize: '11px' }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => toggleLineInclude(idx)}
                  style={{
                    padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, border: 'none',
                    background: line.include ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                    color: line.include ? '#4ade80' : '#f87171',
                  }}
                >
                  {line.include ? '✓ Include' : '✕ Skip'}
                </button>
              </div>

              {line.include && (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'end' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', marginBottom: '2px' }}>Qty</label>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: '#e8ecf1' }}>{line.quantity}</div>
                  </div>

                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', marginBottom: '2px' }}>Price</label>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <input
                        type="number"
                        value={line.final_price}
                        onChange={(e) => updateFinalPrice(idx, e.target.value)}
                        step="0.01"
                        style={{ width: '90px', padding: '6px 8px', borderRadius: '6px', border: '1px solid #1e2d3d', background: '#0f1720', color: '#e8ecf1', fontSize: '13px' }}
                      />
                      {line.catalog_match && line.catalog_match.price > 0 && (
                        <button
                          onClick={() => togglePriceSource(idx)}
                          style={{
                            padding: '3px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, border: 'none',
                            background: line.use_catalog_price ? 'rgba(34,197,94,0.1)' : 'rgba(251,191,36,0.1)',
                            color: line.use_catalog_price ? '#4ade80' : '#fbbf24',
                          }}
                        >
                          {line.use_catalog_price ? 'Catalog' : 'PO'} ${line.use_catalog_price ? line.catalog_match.price.toFixed(2) : line.unit_price.toFixed(2)}
                        </button>
                      )}
                    </div>
                  </div>

                  <div style={{ textAlign: 'right' }}>
                    <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', marginBottom: '2px' }}>Total</label>
                    <div style={{ fontSize: '14px', fontWeight: 800, color: '#60a5fa' }}>{fmt(line.quantity * line.final_price)}</div>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Totals and actions */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0 6px', borderTop: '1px solid #1e2d3d', marginTop: '6px' }}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: '#e8ecf1' }}>
              Grand Total: <span style={{ color: '#60a5fa' }}>{fmt(importLines.filter((l) => l.include).reduce((s, l) => s + l.quantity * l.final_price, 0))}</span>
            </div>
            <div style={{ fontSize: '11px', color: '#4a5f78' }}>
              {importLines.filter((l) => l.include).length} of {importLines.length} lines
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button
              onClick={handleImportPO}
              disabled={importing || importLines.filter((l) => l.include).length === 0}
              style={{
                flex: 1, padding: '12px', borderRadius: '10px', background: '#22c55e',
                color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none',
                opacity: importing || importLines.filter((l) => l.include).length === 0 ? 0.4 : 1,
              }}
            >
              {importing ? 'Importing...' : 'Import PO'}
            </button>
            <button
              onClick={cancelImport}
              style={{ padding: '12px 20px', borderRadius: '10px', background: 'transparent', border: '1px solid #1e2d3d', color: '#6b7a8d', fontWeight: 700, fontSize: '14px' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Manual create form */}
      {showCreate && (
        <div style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', padding: '14px', marginBottom: '12px' }}>
          <div style={{ marginBottom: '8px' }}>
            <label style={labelStyle}>PO Number</label>
            <input value={form.po_number} onChange={(e) => setForm({ ...form, po_number: e.target.value })} style={inputStyle} />
          </div>
          <div style={{ marginBottom: '8px' }}>
            <label style={labelStyle}>Customer</label>
            <select value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} style={inputStyle}>
              <option>Masterack</option><option>Knapheide</option><option>Bodewell</option><option>Designs That Stick</option>
            </select>
          </div>
          <div style={{ marginBottom: '8px' }}>
            <label style={labelStyle}>Add Part Number</label>
            <select onChange={(e) => { if (e.target.value) addLineItem(e.target.value); e.target.value = ''; }} style={inputStyle}>
              <option value="">Select part number...</option>
              {catalog.filter((c) => c.customer === form.customer || !c.customer).map((c) => (
                <option key={c.id} value={c.id}>{c.part_number} — {c.graphic_package || c.end_customer} (${c.price})</option>
              ))}
            </select>
          </div>

          {lineItems.length > 0 && (
            <div style={{ marginBottom: '8px' }}>
              {lineItems.map((li, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid #1e2d3d' }}>
                  <div style={{ flex: 1, fontSize: '13px', fontWeight: 700 }}>{li.part_number}</div>
                  <div style={{ fontSize: '12px', color: '#4a5f78' }}>{fmt(li.unit_price)}</div>
                  <input
                    type="number"
                    value={li.quantity}
                    onChange={(e) => {
                      const q = parseInt(e.target.value) || 1;
                      setLineItems((prev) => prev.map((item, j) => j === i ? { ...item, quantity: q } : item));
                    }}
                    style={{ ...inputStyle, width: '60px', textAlign: 'center' }}
                    min={1}
                  />
                  <button onClick={() => setLineItems((prev) => prev.filter((_, j) => j !== i))} style={{ color: '#f87171', fontSize: '18px', padding: '0 4px', background: 'none', border: 'none' }}>×</button>
                </div>
              ))}
              <div style={{ textAlign: 'right', marginTop: '6px', fontSize: '13px', fontWeight: 700, color: '#60a5fa' }}>
                Total: {fmt(lineItems.reduce((s, l) => s + l.quantity * l.unit_price, 0))}
              </div>
            </div>
          )}

          <button
            onClick={handleCreate}
            disabled={!form.po_number || lineItems.length === 0}
            style={{
              width: '100%', padding: '12px', borderRadius: '10px', background: '#22c55e',
              color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none',
              opacity: form.po_number && lineItems.length > 0 ? 1 : 0.4,
            }}
          >
            Create PO
          </button>
        </div>
      )}

      {pos.length === 0 && !showImport && !showCreate && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: '#4a5f78' }}>
          <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>📋</div>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>No purchase orders yet</div>
        </div>
      )}

      {pos.map((po) => {
        const totalQty = po.line_items.reduce((s, l) => s + l.quantity, 0);
        const totalInstalled = po.line_items.reduce((s, l) => s + l.installed, 0);
        const totalValue = po.line_items.reduce((s, l) => s + l.quantity * l.unit_price, 0);
        const pct = totalQty > 0 ? (totalInstalled / totalQty) * 100 : 0;
        const isExpanded = expandedPo === po.id;
        const isEditingPO = editPoId === po.id;
        const createdDate = new Date(po.created_at);

        return (
          <SwipeToDelete
            key={po.id}
            onDelete={() => handleDeletePO(po.id)}
            confirmMessage={`Delete PO #${po.po_number} and all its line items? This cannot be undone.`}
          >
            <div style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px', marginBottom: '6px', overflow: 'hidden' }}>
              <div onClick={() => toggleExpand(po.id)} style={{ padding: '12px', cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: '15px' }}>PO #{po.po_number}</div>
                    <div style={{ fontSize: '12px', color: '#4a5f78', marginTop: '1px' }}>
                      {po.customer} • {po.line_items.length} item{po.line_items.length !== 1 ? 's' : ''}
                      {po.status === 'complete' && <span style={{ color: '#4ade80', marginLeft: '6px' }}>✓ Complete</span>}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '14px', fontWeight: 800, color: '#60a5fa' }}>{fmt(totalValue)}</div>
                    <div style={{ fontSize: '10px', color: '#4a5f78', marginTop: '1px' }}>{isExpanded ? '▲' : '▼'} Details</div>
                  </div>
                </div>
                <div style={{ marginTop: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '3px' }}>
                    <span style={{ color: '#4a5f78' }}>Progress</span>
                    <span style={{ color: pct >= 100 ? '#4ade80' : '#60a5fa', fontWeight: 700 }}>{totalInstalled}/{totalQty}</span>
                  </div>
                  <div style={{ height: '6px', background: '#1e2d3d', borderRadius: '3px' }}>
                    <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: pct >= 100 ? '#22c55e' : '#3b82f6', borderRadius: '3px', transition: 'width 0.3s' }} />
                  </div>
                </div>
              </div>

              {isExpanded && (
                <div style={{ borderTop: '1px solid #1e2d3d', padding: '10px 12px' }}>
                  {isEditingPO ? (
                    <div style={{ marginBottom: '10px', padding: '8px', background: 'rgba(59,130,246,0.05)', borderRadius: '8px' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                        <div>
                          <label style={labelStyle}>PO Number</label>
                          <input value={editPoForm.po_number} onChange={(e) => setEditPoForm({ ...editPoForm, po_number: e.target.value })} style={inputStyle} />
                        </div>
                        <div>
                          <label style={labelStyle}>Customer</label>
                          <select value={editPoForm.customer} onChange={(e) => setEditPoForm({ ...editPoForm, customer: e.target.value })} style={inputStyle}>
                            <option>Masterack</option><option>Knapheide</option><option>Bodewell</option><option>Designs That Stick</option>
                          </select>
                        </div>
                      </div>
                      <div style={{ marginTop: '6px' }}>
                        <label style={labelStyle}>Status</label>
                        <select value={editPoForm.status} onChange={(e) => setEditPoForm({ ...editPoForm, status: e.target.value })} style={inputStyle}>
                          <option value="open">Open</option><option value="complete">Complete</option><option value="cancelled">Cancelled</option>
                        </select>
                      </div>
                      <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                        <button onClick={saveEditPO} style={{ flex: 1, padding: '8px', borderRadius: '8px', background: '#22c55e', color: '#fff', fontSize: '12px', fontWeight: 700, border: 'none' }}>Save</button>
                        <button onClick={() => setEditPoId(null)} style={{ flex: 1, padding: '8px', borderRadius: '8px', background: 'transparent', border: '1px solid #1e2d3d', color: '#6b7a8d', fontSize: '12px', fontWeight: 700 }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <div style={{ fontSize: '10px', color: '#4a5f78' }}>
                        Created {createdDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); startEditPO(po); }}
                        style={{ padding: '3px 8px', borderRadius: '6px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#60a5fa', fontSize: '10px', fontWeight: 700 }}
                      >
                        ✏️ Edit PO
                      </button>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '4px', padding: '8px 0 4px', borderBottom: '1px solid #1e2d3d', fontSize: '10px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
                    <div style={{ flex: 1 }}>Part #</div>
                    <div style={{ width: '36px', textAlign: 'center' }}>Qty</div>
                    <div style={{ width: '42px', textAlign: 'center' }}>Done</div>
                    <div style={{ width: '65px', textAlign: 'right' }}>Price</div>
                    <div style={{ width: '55px', textAlign: 'right' }}>Total</div>
                    <div style={{ width: '24px' }}></div>
                  </div>

                  {po.line_items.map((li) => {
                    const lineTotal = li.quantity * li.unit_price;
                    const linePct = li.quantity > 0 ? (li.installed / li.quantity) * 100 : 0;
                    const isEditingLine = editLineId === li.id;

                    if (isEditingLine) {
                      return (
                        <div key={li.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(30,45,61,0.5)' }}>
                          <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '4px' }}>{li.part_number}</div>
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'end' }}>
                            <div style={{ flex: 1 }}>
                              <label style={{ ...labelStyle, fontSize: '9px' }}>Qty</label>
                              <input type="number" value={editLineForm.quantity} onChange={(e) => setEditLineForm({ ...editLineForm, quantity: e.target.value })} style={{ ...inputStyle, padding: '6px 8px', fontSize: '12px' }} />
                            </div>
                            <div style={{ flex: 1 }}>
                              <label style={{ ...labelStyle, fontSize: '9px' }}>Unit Price</label>
                              <input type="number" value={editLineForm.unit_price} onChange={(e) => setEditLineForm({ ...editLineForm, unit_price: e.target.value })} style={{ ...inputStyle, padding: '6px 8px', fontSize: '12px' }} step="0.01" />
                            </div>
                            <button onClick={() => saveEditLine(po.id)} style={{ padding: '6px 10px', borderRadius: '6px', background: '#22c55e', color: '#fff', fontSize: '11px', fontWeight: 700, border: 'none' }}>✓</button>
                            <button onClick={() => setEditLineId(null)} style={{ padding: '6px 10px', borderRadius: '6px', background: 'transparent', border: '1px solid #1e2d3d', color: '#6b7a8d', fontSize: '11px', fontWeight: 700 }}>✕</button>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={li.id} style={{ display: 'flex', gap: '4px', padding: '8px 0', borderBottom: '1px solid rgba(30,45,61,0.5)', alignItems: 'center', fontSize: '12px' }}>
                        <div style={{ flex: 1 }} onClick={() => startEditLine(li)}>
                          <div style={{ fontWeight: 700, color: '#e8ecf1' }}>{li.part_number}</div>
                          <div style={{ height: '3px', background: '#1e2d3d', borderRadius: '2px', marginTop: '3px', width: '80%' }}>
                            <div style={{ height: '100%', width: `${Math.min(linePct, 100)}%`, background: linePct >= 100 ? '#22c55e' : '#3b82f6', borderRadius: '2px' }} />
                          </div>
                        </div>
                        <div style={{ width: '36px', textAlign: 'center', color: '#6b7a8d', fontWeight: 600 }} onClick={() => startEditLine(li)}>{li.quantity}</div>
                        <div style={{ width: '42px', textAlign: 'center', fontWeight: 700, color: li.installed >= li.quantity ? '#4ade80' : '#fbbf24' }}>{li.installed}</div>
                        <div style={{ width: '65px', textAlign: 'right', color: '#6b7a8d', fontSize: '11px' }} onClick={() => startEditLine(li)}>{fmt(li.unit_price)}</div>
                        <div style={{ width: '55px', textAlign: 'right', fontWeight: 700, color: '#e8ecf1' }}>{fmt(lineTotal)}</div>
                        <button
                          onClick={() => { if (window.confirm(`Remove ${li.part_number} from this PO?`)) handleDeleteLineItem(li.id, po.id); }}
                          style={{ width: '24px', background: 'none', border: 'none', color: '#f87171', fontSize: '14px', padding: 0, cursor: 'pointer' }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}

                  <div style={{ display: 'flex', gap: '4px', padding: '10px 0 4px', fontSize: '13px' }}>
                    <div style={{ flex: 1, fontWeight: 800, color: '#e8ecf1' }}>Total</div>
                    <div style={{ width: '36px', textAlign: 'center', fontWeight: 700, color: '#6b7a8d' }}>{totalQty}</div>
                    <div style={{ width: '42px', textAlign: 'center', fontWeight: 700, color: totalInstalled >= totalQty ? '#4ade80' : '#60a5fa' }}>{totalInstalled}</div>
                    <div style={{ width: '65px' }}></div>
                    <div style={{ width: '55px', textAlign: 'right', fontWeight: 800, color: '#60a5fa' }}>{fmt(totalValue)}</div>
                    <div style={{ width: '24px' }}></div>
                  </div>
                </div>
              )}
            </div>
          </SwipeToDelete>
        );
      })}

      <button onClick={() => router.push('/more')} style={{ width: '100%', padding: '10px', borderRadius: '10px', marginTop: '14px', border: '1px solid #1e2d3d', background: 'transparent', color: '#6b7a8d', fontSize: '13px', fontWeight: 700 }}>
        ← Back
      </button>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: '10px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #1e2d3d', background: '#0f1720', color: '#e8ecf1', fontSize: '13px' };
