'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

interface Customer {
  id: string;
  netsuite_id: string | null;
  netsuite_url: string | null;
  company_name: string;
  entity_id: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  total_orders: number;
  total_spend: number;
  avg_order_value: number;
  ytd_spend: number;
  ytd_orders: number;
  last_year_spend: number;
  last_year_orders: number;
  last_order_date: string | null;
  active: boolean;
  created_at: string;
}

interface Contact {
  id: string;
  customer_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  address: string | null;
  notes: string | null;
  created_at: string;
}

interface Prospect {
  id: string;
  company_name: string;
  contact_name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  website: string | null;
  notes: string | null;
  source: string;
  netsuite_id: string | null;
  netsuite_type: string | null;
  netsuite_url: string | null;
  pushed_at: string | null;
  created_at: string;
}

const emptyProspect = {
  company_name: '', contact_name: '', title: '', email: '', phone: '',
  address: '', city: '', state: '', zip: '', website: '', notes: '',
};

const emptyContact = { name: '', email: '', phone: '', title: '', address: '', notes: '' };

export default function CustomersPage() {
  const router = useRouter();
  const { user, isAdmin, isSales } = useAuth();
  const supabase = createClient();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'spend' | 'orders' | 'recent'>('name');

  // Tab state
  const [tab, setTab] = useState<'customers' | 'prospects'>('customers');

  // Prospects state
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [showAddProspect, setShowAddProspect] = useState(false);
  const [prospectForm, setProspectForm] = useState(emptyProspect);
  const [savingProspect, setSavingProspect] = useState(false);
  const [scanningCard, setScanningCard] = useState(false);
  const [pushingToNS, setPushingToNS] = useState<string | null>(null);
  const [pushTypeModal, setPushTypeModal] = useState<string | null>(null);
  const [editingProspect, setEditingProspect] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Purchase report state
  const [reportCustomer, setReportCustomer] = useState<string | null>(null);
  const [reportStartDate, setReportStartDate] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [reportEndDate, setReportEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [generatingReport, setGeneratingReport] = useState(false);
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);

  // Invoice search state
  const [invoiceCustomer, setInvoiceCustomer] = useState<string | null>(null);
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [invoicesLoaded, setInvoicesLoaded] = useState<string | null>(null);
  const [downloadingPdf, setDownloadingPdf] = useState<string | null>(null);

  // Add/edit contact state
  const [showAddContact, setShowAddContact] = useState<string | null>(null); // customer_id
  const [editingContact, setEditingContact] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState(emptyContact);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    loadData();
  }, [isAdmin, isSales]);

  const loadData = async () => {
    // Supabase returns max 1000 rows by default — paginate to get all customers
    let allCustomers: Customer[] = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;
    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data } = await supabase
        .from('customers')
        .select('*')
        .eq('active', true)
        .order('company_name')
        .range(from, to);
      const batch = (data || []) as Customer[];
      allCustomers = allCustomers.concat(batch);
      hasMore = batch.length === pageSize;
      page++;
    }

    const { data: contData } = await supabase.from('contacts').select('*').order('name');
    setCustomers(allCustomers);
    setContacts((contData as Contact[]) || []);

    // Load prospects
    try {
      const pRes = await fetch('/api/prospects');
      const pData = await pRes.json();
      setProspects(pData.prospects || []);
    } catch { /* prospects table may not exist yet */ }

    setLoading(false);
  };

  const syncFromNetSuite = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch('/api/netsuite/customers');
      const data = await res.json();
      if (!res.ok || data.error) {
        setSyncResult(`Error: ${data.error || 'Sync failed'}`);
      } else {
        const msg = `Synced ${data.synced} of ${data.total} customers from NetSuite`;
        setSyncResult(data.firstError ? `${msg} (errors: ${data.firstError})` : msg);
        await loadData();
      }
    } catch (err: any) {
      setSyncResult(`Error: ${err.message || 'Network error'}`);
    }
    setSyncing(false);
  };

  const saveContact = async (customerId: string) => {
    if (!contactForm.name.trim()) return;
    setSaving(true);

    if (editingContact) {
      // Update
      const res = await fetch('/api/contacts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingContact, ...contactForm }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to update');
      } else {
        setContacts(prev => prev.map(c => c.id === editingContact ? data : c));
      }
    } else {
      // Create
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerId, ...contactForm }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to create');
      } else {
        setContacts(prev => [...prev, data]);
      }
    }

    setSaving(false);
    setShowAddContact(null);
    setEditingContact(null);
    setContactForm(emptyContact);
  };

  const deleteContact = async (id: string) => {
    if (!window.confirm('Delete this contact?')) return;
    const res = await fetch('/api/contacts', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      setContacts(prev => prev.filter(c => c.id !== id));
    }
  };

  const searchInvoices = async (netsuiteId: string, query?: string) => {
    setLoadingInvoices(true);
    try {
      const params = new URLSearchParams({ customerId: netsuiteId });
      if (query?.trim()) params.set('q', query.trim());
      const res = await fetch(`/api/netsuite/invoices?${params}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        alert(data.error || 'Failed to fetch invoices');
      } else {
        setInvoices(data.invoices || []);
        setInvoicesLoaded(netsuiteId);
      }
    } catch (err: any) {
      alert(err.message || 'Failed to fetch invoices');
    }
    setLoadingInvoices(false);
  };

  const downloadInvoicePdf = async (invoiceId: string, invoiceNumber: string) => {
    setDownloadingPdf(invoiceId);
    try {
      const res = await fetch(`/api/netsuite/invoice-pdf?id=${invoiceId}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || 'Failed to download invoice PDF');
        setDownloadingPdf(null);
        return;
      }
      // Convert base64 to blob and download
      const byteChars = atob(data.pdfBase64);
      const byteNumbers = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) {
        byteNumbers[i] = byteChars.charCodeAt(i);
      }
      const blob = new Blob([new Uint8Array(byteNumbers)], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.filename || `Invoice_${invoiceNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err.message || 'Failed to download PDF');
    }
    setDownloadingPdf(null);
  };

  const generatePurchaseReport = async (customer: Customer) => {
    setGeneratingReport(true);
    try {
      const params = new URLSearchParams({
        customerId: customer.netsuite_id || '',
        startDate: reportStartDate,
        endDate: reportEndDate,
      });
      const res = await fetch(`/api/netsuite/customer-purchases?${params}`);
      const data = await res.json();

      if (!res.ok || data.error) {
        alert(data.error || 'Failed to fetch purchase data');
        setGeneratingReport(false);
        return;
      }

      const { lines, summary } = data;

      // Generate PDF
      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();

      // Header
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.text('Customer Purchase Report', 14, 20);

      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');
      doc.text(customer.company_name, 14, 28);

      doc.setFontSize(9);
      doc.setTextColor(100);
      const startFormatted = new Date(reportStartDate + 'T00:00:00').toLocaleDateString();
      const endFormatted = new Date(reportEndDate + 'T00:00:00').toLocaleDateString();
      doc.text(`${startFormatted} — ${endFormatted}`, 14, 34);
      doc.text(`Generated ${new Date().toLocaleDateString()}`, 14, 39);

      // Summary box
      doc.setDrawColor(200);
      doc.setFillColor(245, 247, 250);
      doc.roundedRect(14, 44, pageWidth - 28, 18, 2, 2, 'FD');

      doc.setTextColor(0);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      const summaryY = 53;
      const colW = (pageWidth - 28) / 4;
      doc.text(`Total Spend`, 20, summaryY - 3);
      doc.text(`$${summary.totalSpend.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`, 20, summaryY + 2);

      doc.text(`Orders`, 20 + colW, summaryY - 3);
      doc.text(`${summary.uniqueOrders}`, 20 + colW, summaryY + 2);

      doc.text(`Unique Items`, 20 + colW * 2, summaryY - 3);
      doc.text(`${summary.uniqueItems}`, 20 + colW * 2, summaryY + 2);

      doc.text(`Avg Order`, 20 + colW * 3, summaryY - 3);
      doc.text(`$${summary.avgOrderValue.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`, 20 + colW * 3, summaryY + 2);

      // Table
      if (lines.length > 0) {
        autoTable(doc, {
          startY: 68,
          head: [['Date', 'SO #', 'PO #', 'Item', 'Qty', 'Rate', 'Total']],
          body: lines.map((l: any) => [
            l.orderDate ? new Date(l.orderDate + 'T00:00:00').toLocaleDateString() : '',
            l.soNumber,
            l.poNumber,
            l.itemName,
            l.quantity.toString(),
            `$${l.rate.toFixed(2)}`,
            `$${l.lineTotal.toFixed(2)}`,
          ]),
          styles: { fontSize: 8, cellPadding: 2 },
          headStyles: { fillColor: [59, 130, 246], textColor: 255, fontStyle: 'bold' },
          alternateRowStyles: { fillColor: [245, 247, 250] },
          columnStyles: {
            0: { cellWidth: 22 },
            4: { halign: 'right', cellWidth: 14 },
            5: { halign: 'right', cellWidth: 20 },
            6: { halign: 'right', cellWidth: 22 },
          },
        });
      } else {
        doc.setFontSize(11);
        doc.setTextColor(150);
        doc.text('No purchase data found for this date range.', 14, 75);
      }

      // Footer on each page
      const totalPages = (doc as any).internal.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(7);
        doc.setTextColor(150);
        doc.text(
          `BMG FleetSuite — ${customer.company_name} — Page ${i} of ${totalPages}`,
          pageWidth / 2, doc.internal.pageSize.getHeight() - 8,
          { align: 'center' }
        );
      }

      // Download
      doc.save(`${customer.company_name.replace(/[^a-zA-Z0-9]/g, '_')}_purchases_${reportStartDate}_${reportEndDate}.pdf`);
    } catch (err: any) {
      alert(err.message || 'Failed to generate report');
    }
    setGeneratingReport(false);
  };

  const startEditContact = (contact: Contact) => {
    setEditingContact(contact.id);
    setShowAddContact(contact.customer_id);
    setContactForm({
      name: contact.name,
      email: contact.email || '',
      phone: contact.phone || '',
      title: contact.title || '',
      address: contact.address || '',
      notes: contact.notes || '',
    });
  };

  // ── Prospect functions ──────────────────────────────────
  const handleScanCard = async (file: File) => {
    setScanningCard(true);
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve) => {
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(',')[1]); // strip data:image/...;base64,
        };
        reader.readAsDataURL(file);
      });

      const res = await fetch('/api/prospects/scan-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64, mimeType: file.type }),
      });
      const data = await res.json();
      if (data.success && data.data) {
        setProspectForm({
          company_name: data.data.company_name || '',
          contact_name: data.data.contact_name || '',
          title: data.data.title || '',
          email: data.data.email || '',
          phone: data.data.phone || '',
          address: data.data.address || '',
          city: data.data.city || '',
          state: data.data.state || '',
          zip: data.data.zip || '',
          website: data.data.website || '',
          notes: '',
        });
        setShowAddProspect(true);
      } else {
        alert(data.error || 'Failed to scan card');
      }
    } catch (err: any) {
      alert(err.message || 'Failed to scan card');
    }
    setScanningCard(false);
  };

  const saveProspect = async (pushType?: 'customer' | 'lead' | 'prospect') => {
    if (!prospectForm.company_name.trim()) { alert('Company name is required'); return; }
    setSavingProspect(true);
    try {
      const method = editingProspect ? 'PUT' : 'POST';
      const source = scanningCard ? 'business_card' : 'manual';
      const body = editingProspect
        ? { id: editingProspect, ...prospectForm }
        : { ...prospectForm, source, created_by: user?.id };
      const res = await fetch('/api/prospects', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        if (editingProspect) {
          setProspects(prev => prev.map(p => p.id === editingProspect ? data.prospect : p));
        } else {
          setProspects(prev => [data.prospect, ...prev]);
        }

        // If pushType specified, immediately push to NetSuite
        if (pushType && data.prospect?.id) {
          await pushToNetSuite(data.prospect.id, pushType);
          // Refresh customers list so the new entry shows up
          await loadData();
        }

        setShowAddProspect(false);
        setEditingProspect(null);
        setProspectForm(emptyProspect);
      } else {
        alert(data.error || 'Failed to save');
      }
    } catch (err: any) {
      alert(err.message || 'Failed to save');
    }
    setSavingProspect(false);
  };

  const deleteProspect = async (id: string) => {
    if (!window.confirm('Delete this prospect?')) return;
    const res = await fetch(`/api/prospects?id=${id}`, { method: 'DELETE' });
    if (res.ok) setProspects(prev => prev.filter(p => p.id !== id));
  };

  const pushToNetSuite = async (prospectId: string, type: 'customer' | 'lead' | 'prospect') => {
    setPushingToNS(prospectId);
    setPushTypeModal(null);
    try {
      const res = await fetch('/api/prospects/push-to-netsuite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospectId, type, userId: user?.id }),
      });
      const data = await res.json();
      if (data.success) {
        setProspects(prev => prev.map(p =>
          p.id === prospectId
            ? { ...p, netsuite_id: data.customerId, netsuite_type: type, netsuite_url: data.netsuiteUrl, pushed_at: new Date().toISOString() }
            : p
        ));
        // Also refresh customers list to show the new entry after next sync
      } else {
        alert(data.error || 'Failed to push to NetSuite');
      }
    } catch (err: any) {
      alert(err.message || 'Failed to push');
    }
    setPushingToNS(null);
  };

  const fmt = (n: number) => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fmtK = (n: number) => n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : fmt(n);

  const filteredCustomers = customers
    .filter(c => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      if (c.company_name.toLowerCase().includes(q)) return true;
      if (c.entity_id?.toLowerCase().includes(q)) return true;
      if (c.email?.toLowerCase().includes(q)) return true;
      const custContacts = contacts.filter(ct => ct.customer_id === c.id);
      if (custContacts.some(ct =>
        ct.name.toLowerCase().includes(q) ||
        ct.email?.toLowerCase().includes(q) ||
        ct.phone?.toLowerCase().includes(q)
      )) return true;
      return false;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'spend': return (b.total_spend || 0) - (a.total_spend || 0);
        case 'orders': return (b.total_orders || 0) - (a.total_orders || 0);
        case 'recent': return (b.last_order_date || '').localeCompare(a.last_order_date || '');
        default: return a.company_name.localeCompare(b.company_name);
      }
    });

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '13px', outline: 'none',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-label)',
    marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.05em',
  };

  if (loading) {
    return <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-label)' }}>Loading...</div>;
  }

  return (
    <div style={{ padding: '16px', maxWidth: '800px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-body)', margin: 0 }}>Customers & Prospects</h1>
          <div style={{ fontSize: '12px', color: 'var(--text-label)', marginTop: '2px' }}>
            {customers.length} customers · {prospects.filter(p => !p.netsuite_id).length} prospects
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={() => { setTab('prospects'); fileInputRef.current?.click(); }}
            disabled={scanningCard}
            style={{
              padding: '8px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
              background: scanningCard ? 'var(--border)' : 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.25)',
              color: '#fbbf24', cursor: 'pointer',
            }}
          >
            {scanningCard ? 'Scanning...' : '📷 Scan Card'}
          </button>
          {tab === 'customers' ? (
            <button
              onClick={syncFromNetSuite}
              disabled={syncing}
              style={{
                padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: syncing ? 'var(--border)' : '#3b82f6', border: 'none', color: '#fff', cursor: 'pointer',
              }}
            >
              {syncing ? 'Syncing...' : 'Sync NetSuite'}
            </button>
          ) : (
            <button
              onClick={() => { setProspectForm(emptyProspect); setEditingProspect(null); setShowAddProspect(true); }}
              style={{
                padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: '#4ade80', border: 'none', color: '#000', cursor: 'pointer',
              }}
            >
              + Add New
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', background: 'var(--card)', borderRadius: '10px', padding: '3px' }}>
        <button onClick={() => setTab('customers')} style={{
          flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, border: 'none', cursor: 'pointer',
          background: tab === 'customers' ? '#3b82f6' : 'transparent',
          color: tab === 'customers' ? '#fff' : 'var(--text-label)',
        }}>Customers ({customers.length})</button>
        <button onClick={() => setTab('prospects')} style={{
          flex: 1, padding: '8px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, border: 'none', cursor: 'pointer',
          background: tab === 'prospects' ? '#3b82f6' : 'transparent',
          color: tab === 'prospects' ? '#fff' : 'var(--text-label)',
        }}>Prospects ({prospects.length})</button>
      </div>

      {/* Hidden file input for card scanning */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleScanCard(file);
          e.target.value = '';
        }}
      />

      {/* ══════ CUSTOMERS TAB ══════ */}
      {tab === 'customers' && <>
      {syncResult && (
        <div style={{
          padding: '8px 12px', borderRadius: '6px', marginBottom: '12px', fontSize: '12px',
          background: syncResult.startsWith('Error') ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)',
          color: syncResult.startsWith('Error') ? '#ef4444' : '#4ade80',
          border: `1px solid ${syncResult.startsWith('Error') ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.2)'}`,
        }}>
          {syncResult}
        </div>
      )}

      {/* Search + Sort */}
      <input
        type="text"
        placeholder="Search customers, contacts..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ ...inputStyle, marginBottom: '8px' }}
      />
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
        {([
          ['name', 'A-Z'],
          ['spend', 'Top Spend'],
          ['orders', 'Most Orders'],
          ['recent', 'Recent'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSortBy(key)}
            style={{
              padding: '4px 10px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
              background: sortBy === key ? '#3b82f6' : 'rgba(59,130,246,0.1)',
              border: sortBy === key ? 'none' : '1px solid rgba(59,130,246,0.2)',
              color: sortBy === key ? '#fff' : '#60a5fa',
            }}
          >{label}</button>
        ))}
      </div>

      {/* Customer list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {filteredCustomers.map(customer => {
          const isExpanded = expandedCustomer === customer.id;
          const custContacts = contacts.filter(c => c.customer_id === customer.id);
          const isAddingContact = showAddContact === customer.id;

          return (
            <div key={customer.id} style={{
              borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)', overflow: 'hidden',
            }}>
              {/* Customer header */}
              <div
                onClick={() => {
                  setExpandedCustomer(isExpanded ? null : customer.id);
                  setShowAddContact(null);
                  setEditingContact(null);
                  setContactForm(emptyContact);
                }}
                style={{
                  padding: '12px 14px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-body)' }}>
                    {customer.company_name}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-label)', marginTop: '2px' }}>
                    {customer.entity_id && <span>{customer.entity_id} · </span>}
                    {customer.email && <span>{customer.email} · </span>}
                    {customer.phone && <span>{customer.phone} · </span>}
                    {custContacts.length} contact{custContacts.length !== 1 ? 's' : ''}
                  </div>
                </div>
                {/* Spend metrics - compact */}
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexShrink: 0 }}>
                  {(customer.ytd_spend > 0) && (
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '13px', fontWeight: 800, color: '#4ade80' }}>{fmtK(customer.ytd_spend)}</div>
                      <div style={{ fontSize: '9px', color: 'var(--text-label)', textTransform: 'uppercase' }}>YTD</div>
                    </div>
                  )}
                  {(customer.total_spend > 0) && (
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '13px', fontWeight: 800, color: '#60a5fa' }}>{fmtK(customer.total_spend)}</div>
                      <div style={{ fontSize: '9px', color: 'var(--text-label)', textTransform: 'uppercase' }}>All-Time</div>
                    </div>
                  )}
                  {(customer.total_orders > 0) && (
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '13px', fontWeight: 800, color: '#fbbf24' }}>{customer.total_orders}</div>
                      <div style={{ fontSize: '9px', color: 'var(--text-label)', textTransform: 'uppercase' }}>Orders</div>
                    </div>
                  )}
                  <div style={{ fontSize: '16px', color: 'var(--text-label)', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
                    ▾
                  </div>
                </div>
              </div>

              {/* Expanded: contacts */}
              {isExpanded && (
                <div style={{ padding: '0 14px 14px 14px', borderTop: '1px solid var(--border)' }}>
                  {/* Spend breakdown */}
                  {(customer.total_spend > 0 || customer.ytd_spend > 0) && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', padding: '10px 0', borderBottom: '1px solid rgba(30,45,61,0.5)' }}>
                      <div style={{ textAlign: 'center', padding: '8px', borderRadius: '6px', background: 'rgba(34,197,94,0.08)' }}>
                        <div style={{ fontSize: '15px', fontWeight: 800, color: '#4ade80' }}>{fmtK(customer.ytd_spend || 0)}</div>
                        <div style={{ fontSize: '9px', color: 'var(--text-label)', textTransform: 'uppercase', marginTop: '2px' }}>YTD Spend</div>
                        {customer.ytd_orders > 0 && <div style={{ fontSize: '9px', color: 'var(--text-body)' }}>{customer.ytd_orders} orders</div>}
                      </div>
                      <div style={{ textAlign: 'center', padding: '8px', borderRadius: '6px', background: 'rgba(251,191,36,0.08)' }}>
                        <div style={{ fontSize: '15px', fontWeight: 800, color: '#fbbf24' }}>{fmtK(customer.last_year_spend || 0)}</div>
                        <div style={{ fontSize: '9px', color: 'var(--text-label)', textTransform: 'uppercase', marginTop: '2px' }}>Last Year</div>
                        {customer.last_year_orders > 0 && <div style={{ fontSize: '9px', color: 'var(--text-body)' }}>{customer.last_year_orders} orders</div>}
                      </div>
                      <div style={{ textAlign: 'center', padding: '8px', borderRadius: '6px', background: 'rgba(59,130,246,0.08)' }}>
                        <div style={{ fontSize: '15px', fontWeight: 800, color: '#60a5fa' }}>{fmtK(customer.total_spend || 0)}</div>
                        <div style={{ fontSize: '9px', color: 'var(--text-label)', textTransform: 'uppercase', marginTop: '2px' }}>All-Time</div>
                        {customer.total_orders > 0 && <div style={{ fontSize: '9px', color: 'var(--text-body)' }}>{customer.total_orders} orders</div>}
                      </div>
                      <div style={{ textAlign: 'center', padding: '8px', borderRadius: '6px', background: 'rgba(168,85,247,0.08)' }}>
                        <div style={{ fontSize: '15px', fontWeight: 800, color: '#a855f7' }}>{fmtK(customer.avg_order_value || 0)}</div>
                        <div style={{ fontSize: '9px', color: 'var(--text-label)', textTransform: 'uppercase', marginTop: '2px' }}>Avg Order</div>
                      </div>
                    </div>
                  )}

                  {/* Customer details */}
                  <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', padding: '8px 0', borderBottom: '1px solid rgba(30,45,61,0.5)', fontSize: '11px', color: 'var(--text-body)', alignItems: 'center' }}>
                    {customer.address && <span>{customer.address}</span>}
                    {customer.last_order_date && (
                      <span>Last order: <strong style={{ color: '#94a3b8' }}>{new Date(customer.last_order_date).toLocaleDateString()}</strong></span>
                    )}
                    {customer.netsuite_url && (
                      <a
                        href={customer.netsuite_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        style={{ color: 'var(--text-label)', textDecoration: 'none', fontWeight: 600, fontSize: '10px' }}
                      >
                        NetSuite ↗
                      </a>
                    )}
                  </div>

                  {/* Purchase Report */}
                  {customer.netsuite_id && (
                    <div style={{ padding: '10px 0', borderBottom: '1px solid rgba(30,45,61,0.5)' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '6px' }}>Purchase Report</div>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <label style={{ fontSize: '10px', color: 'var(--text-body)' }}>From</label>
                          <input
                            type="date"
                            value={reportCustomer === customer.id ? reportStartDate : `${new Date().getFullYear()}-01-01`}
                            onClick={(e) => { e.stopPropagation(); setReportCustomer(customer.id); }}
                            onChange={(e) => { setReportCustomer(customer.id); setReportStartDate(e.target.value); }}
                            style={{
                              padding: '4px 8px', borderRadius: '5px', border: '1px solid var(--border)',
                              background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '11px', outline: 'none',
                            }}
                          />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <label style={{ fontSize: '10px', color: 'var(--text-body)' }}>To</label>
                          <input
                            type="date"
                            value={reportCustomer === customer.id ? reportEndDate : new Date().toISOString().slice(0, 10)}
                            onClick={(e) => { e.stopPropagation(); setReportCustomer(customer.id); }}
                            onChange={(e) => { setReportCustomer(customer.id); setReportEndDate(e.target.value); }}
                            style={{
                              padding: '4px 8px', borderRadius: '5px', border: '1px solid var(--border)',
                              background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '11px', outline: 'none',
                            }}
                          />
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (reportCustomer !== customer.id) {
                              setReportCustomer(customer.id);
                              setReportStartDate(`${new Date().getFullYear()}-01-01`);
                              setReportEndDate(new Date().toISOString().slice(0, 10));
                            }
                            generatePurchaseReport(customer);
                          }}
                          disabled={generatingReport}
                          style={{
                            padding: '5px 14px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                            background: generatingReport ? 'var(--border)' : 'rgba(59,130,246,0.15)',
                            border: '1px solid rgba(59,130,246,0.3)', color: generatingReport ? 'var(--text-label)' : '#60a5fa',
                            cursor: generatingReport ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {generatingReport && reportCustomer === customer.id ? 'Generating...' : '📄 Download Report'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Invoice Search */}
                  {customer.netsuite_id && (
                    <div style={{ padding: '10px 0', borderBottom: '1px solid rgba(30,45,61,0.5)' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '6px' }}>Invoices</div>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <input
                          type="text"
                          placeholder="Search by invoice # or memo..."
                          value={invoiceCustomer === customer.id ? invoiceSearch : ''}
                          onClick={(e) => { e.stopPropagation(); setInvoiceCustomer(customer.id); }}
                          onChange={(e) => { setInvoiceCustomer(customer.id); setInvoiceSearch(e.target.value); }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.stopPropagation();
                              searchInvoices(customer.netsuite_id!, invoiceCustomer === customer.id ? invoiceSearch : '');
                            }
                          }}
                          style={{
                            flex: 1, padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border)',
                            background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '12px', outline: 'none',
                          }}
                        />
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (invoiceCustomer !== customer.id) {
                              setInvoiceCustomer(customer.id);
                              setInvoiceSearch('');
                            }
                            searchInvoices(customer.netsuite_id!, invoiceCustomer === customer.id ? invoiceSearch : '');
                          }}
                          disabled={loadingInvoices}
                          style={{
                            padding: '6px 14px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                            background: loadingInvoices ? 'var(--border)' : 'rgba(168,85,247,0.15)',
                            border: '1px solid rgba(168,85,247,0.3)', color: loadingInvoices ? 'var(--text-label)' : '#c084fc',
                            cursor: loadingInvoices ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                          }}
                        >
                          {loadingInvoices && invoiceCustomer === customer.id ? 'Searching...' : 'Search Invoices'}
                        </button>
                      </div>

                      {/* Invoice results */}
                      {invoiceCustomer === customer.id && invoicesLoaded === customer.netsuite_id && (
                        <div style={{ marginTop: '8px' }}>
                          {invoices.length === 0 ? (
                            <div style={{ fontSize: '11px', color: 'var(--text-label)', padding: '8px 0' }}>No invoices found</div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <div style={{ fontSize: '10px', color: 'var(--text-label)', marginBottom: '2px' }}>{invoices.length} invoice{invoices.length !== 1 ? 's' : ''} found</div>
                              {invoices.map((inv: any) => (
                                <div key={inv.id} style={{
                                  padding: '8px 10px', borderRadius: '6px',
                                  background: 'rgba(168,85,247,0.05)', border: '1px solid rgba(168,85,247,0.1)',
                                }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-body)' }}>
                                          #{inv.invoiceNumber}
                                        </span>
                                        <span style={{
                                          fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px',
                                          background: inv.status?.toLowerCase().includes('paid') ? 'rgba(34,197,94,0.15)' : 'rgba(251,191,36,0.15)',
                                          color: inv.status?.toLowerCase().includes('paid') ? '#4ade80' : '#fbbf24',
                                        }}>
                                          {inv.status}
                                        </span>
                                      </div>
                                      <div style={{ fontSize: '11px', color: 'var(--text-label)', marginTop: '2px' }}>
                                        {inv.date && <span>{new Date(inv.date + 'T00:00:00').toLocaleDateString()}</span>}
                                        {inv.memo && <span> · {inv.memo}</span>}
                                      </div>
                                    </div>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); downloadInvoicePdf(inv.id, inv.invoiceNumber); }}
                                      disabled={downloadingPdf === inv.id}
                                      style={{
                                        padding: '4px 10px', borderRadius: '5px', fontSize: '11px', fontWeight: 700,
                                        background: downloadingPdf === inv.id ? 'var(--border)' : 'rgba(168,85,247,0.15)',
                                        border: '1px solid rgba(168,85,247,0.3)', color: downloadingPdf === inv.id ? 'var(--text-label)' : '#c084fc',
                                        cursor: downloadingPdf === inv.id ? 'not-allowed' : 'pointer', flexShrink: 0, marginLeft: '12px',
                                      }}
                                    >
                                      {downloadingPdf === inv.id ? 'Downloading...' : 'PDF'}
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Contacts list */}
                  {custContacts.length > 0 ? (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', marginBottom: '6px' }}>Contacts</div>
                      {custContacts.map(contact => (
                        <div key={contact.id} style={{
                          padding: '8px 10px', borderRadius: '6px', background: 'rgba(59,130,246,0.05)',
                          border: '1px solid rgba(59,130,246,0.1)', marginBottom: '4px',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div>
                              <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-body)' }}>
                                {contact.name}
                                {contact.title && <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--text-body)', marginLeft: '8px' }}>{contact.title}</span>}
                              </div>
                              <div style={{ fontSize: '11px', color: 'var(--text-label)', marginTop: '2px' }}>
                                {contact.email && <span>{contact.email}</span>}
                                {contact.email && contact.phone && <span> · </span>}
                                {contact.phone && <span>{contact.phone}</span>}
                              </div>
                              {contact.address && (
                                <div style={{ fontSize: '11px', color: 'var(--text-label)', marginTop: '1px' }}>{contact.address}</div>
                              )}
                              {contact.notes && (
                                <div style={{ fontSize: '11px', color: 'var(--text-body)', marginTop: '2px', fontStyle: 'italic' }}>{contact.notes}</div>
                              )}
                            </div>
                            <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                              <button
                                onClick={(e) => { e.stopPropagation(); startEditContact(contact); }}
                                style={{ background: 'none', border: 'none', color: '#3b82f6', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}
                              >Edit</button>
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteContact(contact.id); }}
                                style={{ background: 'none', border: 'none', color: '#f87171', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}
                              >Delete</button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: '11px', color: 'var(--text-label)', padding: '12px 0' }}>No contacts yet</div>
                  )}

                  {/* Add/Edit contact form */}
                  {isAddingContact ? (
                    <div style={{ marginTop: '8px', padding: '10px', borderRadius: '8px', background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.15)' }}>
                      <div style={{ fontSize: '11px', fontWeight: 700, color: '#60a5fa', marginBottom: '8px' }}>
                        {editingContact ? 'Edit Contact' : 'Add Contact'}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                        <div>
                          <label style={labelStyle}>Name *</label>
                          <input
                            style={inputStyle}
                            value={contactForm.name}
                            onChange={e => setContactForm(f => ({ ...f, name: e.target.value }))}
                            placeholder="Full name"
                          />
                        </div>
                        <div>
                          <label style={labelStyle}>Title / Role</label>
                          <input
                            style={inputStyle}
                            value={contactForm.title}
                            onChange={e => setContactForm(f => ({ ...f, title: e.target.value }))}
                            placeholder="e.g. Purchasing Manager"
                          />
                        </div>
                        <div>
                          <label style={labelStyle}>Email</label>
                          <input
                            style={inputStyle}
                            value={contactForm.email}
                            onChange={e => setContactForm(f => ({ ...f, email: e.target.value }))}
                            placeholder="email@example.com"
                          />
                        </div>
                        <div>
                          <label style={labelStyle}>Phone</label>
                          <input
                            style={inputStyle}
                            value={contactForm.phone}
                            onChange={e => setContactForm(f => ({ ...f, phone: e.target.value }))}
                            placeholder="(555) 123-4567"
                          />
                        </div>
                        <div style={{ gridColumn: '1 / -1' }}>
                          <label style={labelStyle}>Address</label>
                          <input
                            style={inputStyle}
                            value={contactForm.address}
                            onChange={e => setContactForm(f => ({ ...f, address: e.target.value }))}
                            placeholder="Full address"
                          />
                        </div>
                        <div style={{ gridColumn: '1 / -1' }}>
                          <label style={labelStyle}>Notes</label>
                          <input
                            style={inputStyle}
                            value={contactForm.notes}
                            onChange={e => setContactForm(f => ({ ...f, notes: e.target.value }))}
                            placeholder="Any additional notes..."
                          />
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '6px', marginTop: '8px', justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => { setShowAddContact(null); setEditingContact(null); setContactForm(emptyContact); }}
                          style={{ padding: '6px 12px', borderRadius: '6px', background: 'var(--border)', border: 'none', color: 'var(--text-body)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                        >Cancel</button>
                        <button
                          onClick={() => saveContact(customer.id)}
                          disabled={saving || !contactForm.name.trim()}
                          style={{
                            padding: '6px 14px', borderRadius: '6px', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                            background: saving ? 'var(--border)' : '#3b82f6', color: '#fff',
                          }}
                        >{saving ? 'Saving...' : editingContact ? 'Update' : 'Add Contact'}</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowAddContact(customer.id); setEditingContact(null); setContactForm(emptyContact); }}
                      style={{
                        marginTop: '8px', padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                        background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', color: '#4ade80', cursor: 'pointer',
                      }}
                    >+ Add Contact</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filteredCustomers.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-label)' }}>
          {customers.length === 0
            ? <div><div style={{ fontSize: '14px', marginBottom: '8px' }}>No customers yet</div><div style={{ fontSize: '12px' }}>Click "Sync from NetSuite" to import your customer list</div></div>
            : <div style={{ fontSize: '13px' }}>No customers match "{search}"</div>
          }
        </div>
      )}
      </>}

      {/* ══════ PROSPECTS TAB ══════ */}
      {tab === 'prospects' && <>
        {/* Scan Card Button */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={scanningCard}
            style={{
              flex: 1, padding: '14px', borderRadius: '12px', fontSize: '14px', fontWeight: 700,
              background: scanningCard ? 'var(--border)' : 'var(--card)', border: '2px dashed var(--border)',
              color: scanningCard ? 'var(--text-label)' : 'var(--text-body)', cursor: 'pointer', textAlign: 'center',
            }}
          >
            {scanningCard ? 'Scanning card...' : '📷 Scan Business Card'}
          </button>
        </div>

        {/* Add/Edit Prospect Form */}
        {showAddProspect && (
          <div style={{
            background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px',
            padding: '16px', marginBottom: '14px',
          }}>
            <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '10px' }}>
              {editingProspect ? 'Edit Prospect' : 'New Prospect'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={labelStyle}>Company Name *</label>
                <input style={inputStyle} value={prospectForm.company_name}
                  onChange={e => setProspectForm(f => ({ ...f, company_name: e.target.value }))} placeholder="Company name" />
              </div>
              <div>
                <label style={labelStyle}>Contact Name</label>
                <input style={inputStyle} value={prospectForm.contact_name}
                  onChange={e => setProspectForm(f => ({ ...f, contact_name: e.target.value }))} placeholder="Full name" />
              </div>
              <div>
                <label style={labelStyle}>Title</label>
                <input style={inputStyle} value={prospectForm.title}
                  onChange={e => setProspectForm(f => ({ ...f, title: e.target.value }))} placeholder="Job title" />
              </div>
              <div>
                <label style={labelStyle}>Email</label>
                <input style={inputStyle} type="email" value={prospectForm.email}
                  onChange={e => setProspectForm(f => ({ ...f, email: e.target.value }))} placeholder="email@company.com" />
              </div>
              <div>
                <label style={labelStyle}>Phone</label>
                <input style={inputStyle} type="tel" value={prospectForm.phone}
                  onChange={e => setProspectForm(f => ({ ...f, phone: e.target.value }))} placeholder="(555) 123-4567" />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={labelStyle}>Address</label>
                <input style={inputStyle} value={prospectForm.address}
                  onChange={e => setProspectForm(f => ({ ...f, address: e.target.value }))} placeholder="Street address" />
              </div>
              <div>
                <label style={labelStyle}>City</label>
                <input style={inputStyle} value={prospectForm.city}
                  onChange={e => setProspectForm(f => ({ ...f, city: e.target.value }))} placeholder="City" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                <div>
                  <label style={labelStyle}>State</label>
                  <input style={inputStyle} value={prospectForm.state}
                    onChange={e => setProspectForm(f => ({ ...f, state: e.target.value }))} placeholder="ST" />
                </div>
                <div>
                  <label style={labelStyle}>Zip</label>
                  <input style={inputStyle} value={prospectForm.zip}
                    onChange={e => setProspectForm(f => ({ ...f, zip: e.target.value }))} placeholder="12345" />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Website</label>
                <input style={inputStyle} value={prospectForm.website}
                  onChange={e => setProspectForm(f => ({ ...f, website: e.target.value }))} placeholder="www.company.com" />
              </div>
              <div>
                <label style={labelStyle}>Notes</label>
                <input style={inputStyle} value={prospectForm.notes}
                  onChange={e => setProspectForm(f => ({ ...f, notes: e.target.value }))} placeholder="Notes..." />
              </div>
            </div>
            <div style={{ marginTop: '12px' }}>
              {!editingProspect && (
                <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
                  Save & push to NetSuite as:
                </div>
              )}
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <button
                  onClick={() => { setShowAddProspect(false); setEditingProspect(null); setProspectForm(emptyProspect); }}
                  style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-label)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                >Cancel</button>
                {editingProspect ? (
                  <button
                    onClick={() => saveProspect()}
                    disabled={savingProspect || !prospectForm.company_name.trim()}
                    style={{
                      padding: '8px 18px', borderRadius: '8px', border: 'none', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                      background: savingProspect ? 'var(--border)' : '#3b82f6', color: '#fff',
                    }}
                  >{savingProspect ? 'Saving...' : 'Update'}</button>
                ) : (
                  <>
                    <button
                      onClick={() => saveProspect()}
                      disabled={savingProspect || !prospectForm.company_name.trim()}
                      style={{
                        padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                        background: savingProspect ? 'var(--border)' : 'rgba(59,130,246,0.1)',
                        border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa',
                      }}
                    >{savingProspect ? 'Saving...' : 'Save as Prospect'}</button>
                    <button
                      onClick={() => saveProspect('lead')}
                      disabled={savingProspect || !prospectForm.company_name.trim()}
                      style={{
                        padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                        background: savingProspect ? 'var(--border)' : 'rgba(251,191,36,0.1)',
                        border: '1px solid rgba(251,191,36,0.2)', color: '#fbbf24',
                      }}
                    >Save as Lead</button>
                    <button
                      onClick={() => saveProspect('customer')}
                      disabled={savingProspect || !prospectForm.company_name.trim()}
                      style={{
                        padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                        background: savingProspect ? 'var(--border)' : 'rgba(34,197,94,0.1)',
                        border: '1px solid rgba(34,197,94,0.2)', color: '#4ade80',
                      }}
                    >Save as Customer</button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Prospect list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {prospects.map(p => (
            <div key={p.id} style={{
              borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', padding: '12px 14px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-body)' }}>{p.company_name}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-label)', marginTop: '2px' }}>
                    {p.contact_name && <span>{p.contact_name}</span>}
                    {p.title && <span> · {p.title}</span>}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-label)', marginTop: '2px' }}>
                    {p.email && <span>{p.email} · </span>}
                    {p.phone && <span>{p.phone}</span>}
                  </div>
                  {(p.city || p.state) && (
                    <div style={{ fontSize: '11px', color: 'var(--text-label)', marginTop: '1px' }}>
                      {[p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', flexShrink: 0 }}>
                  {p.netsuite_id ? (
                    <a
                      href={p.netsuite_url || '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                        background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', color: '#4ade80',
                        textDecoration: 'none',
                      }}
                    >
                      In NetSuite ({p.netsuite_type})
                    </a>
                  ) : (
                    <button
                      onClick={() => setPushTypeModal(p.id)}
                      disabled={pushingToNS === p.id}
                      style={{
                        padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                        background: pushingToNS === p.id ? 'var(--border)' : 'rgba(59,130,246,0.1)',
                        border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', cursor: 'pointer',
                      }}
                    >
                      {pushingToNS === p.id ? 'Pushing...' : 'Push to NetSuite'}
                    </button>
                  )}
                  <div style={{ fontSize: '9px', color: 'var(--text-label)' }}>
                    {new Date(p.created_at).toLocaleDateString()}
                    {p.source === 'business_card' && ' · scanned'}
                  </div>
                </div>
              </div>

              {/* Push type modal */}
              {pushTypeModal === p.id && (
                <div style={{
                  marginTop: '10px', padding: '10px', borderRadius: '8px',
                  background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.15)',
                }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-body)', marginBottom: '6px' }}>
                    Create in NetSuite as:
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {(['customer', 'lead', 'prospect'] as const).map(type => (
                      <button
                        key={type}
                        onClick={() => pushToNetSuite(p.id, type)}
                        style={{
                          flex: 1, padding: '8px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                          border: '1px solid var(--border)', cursor: 'pointer',
                          background: type === 'customer' ? 'rgba(34,197,94,0.1)' : type === 'lead' ? 'rgba(251,191,36,0.1)' : 'rgba(59,130,246,0.1)',
                          color: type === 'customer' ? '#4ade80' : type === 'lead' ? '#fbbf24' : '#60a5fa',
                          textTransform: 'capitalize',
                        }}
                      >{type}</button>
                    ))}
                    <button
                      onClick={() => setPushTypeModal(null)}
                      style={{
                        padding: '8px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                        border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-label)', cursor: 'pointer',
                      }}
                    >Cancel</button>
                  </div>
                </div>
              )}

              {/* Edit/Delete buttons */}
              {!p.netsuite_id && (
                <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                  <button
                    onClick={() => {
                      setEditingProspect(p.id);
                      setProspectForm({
                        company_name: p.company_name, contact_name: p.contact_name || '', title: p.title || '',
                        email: p.email || '', phone: p.phone || '', address: p.address || '',
                        city: p.city || '', state: p.state || '', zip: p.zip || '',
                        website: p.website || '', notes: p.notes || '',
                      });
                      setShowAddProspect(true);
                    }}
                    style={{
                      padding: '4px 10px', borderRadius: '5px', fontSize: '10px', fontWeight: 700,
                      background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.15)', color: '#60a5fa', cursor: 'pointer',
                    }}
                  >Edit</button>
                  <button
                    onClick={() => deleteProspect(p.id)}
                    style={{
                      padding: '4px 10px', borderRadius: '5px', fontSize: '10px', fontWeight: 700,
                      background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.15)', color: '#ef4444', cursor: 'pointer',
                    }}
                  >Delete</button>
                </div>
              )}
            </div>
          ))}
        </div>

        {prospects.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-label)' }}>
            <div style={{ fontSize: '14px', marginBottom: '8px' }}>No prospects yet</div>
            <div style={{ fontSize: '12px' }}>Add a prospect manually or scan a business card</div>
          </div>
        )}
      </>}
    </div>
  );
}
