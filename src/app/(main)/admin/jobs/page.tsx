'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { decodeVIN, isValidVIN } from '@/lib/vin-decoder';
import type { CatalogItem } from '@/lib/types';

interface Job {
  id: string;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  part_number: string | null;
  end_customer: string | null;
  review_status: string;
  submitted_for_review: boolean;
  scanned_at: string;
  scanned_by: string;
  company_id: string | null;
  scanner_name?: string;
  company_name?: string;
  photo_count?: number;
}

interface Company {
  id: string;
  name: string;
}

interface Invoice {
  id: string;
  invoice_number: string;
  company_id: string;
  submitted_by: string;
  file_path: string | null;
  file_name: string | null;
  status: string;
  review_notes: string | null;
  reviewed_at: string | null;
  submitted_at: string;
  company_name?: string;
  submitter_name?: string;
  submitter_email?: string;
  vehicles: { id: string; vin: string; vehicle_year: string | null; vehicle_make: string | null; vehicle_model: string | null }[];
  file_url?: string;
  paid_at?: string | null;
  payment_amount?: number | null;
  payment_method?: string | null;
  payment_notes?: string | null;
}

export default function AllJobsPage() {
  const router = useRouter();
  const { isAdmin, user } = useAuth();
  const supabase = createClient();
  const [tab, setTab] = useState<'jobs' | 'invoices' | 'bulk'>('jobs');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [companyFilter, setCompanyFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'approved' | 'denied' | 'not_submitted'>('all');
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [invoiceFilter, setInvoiceFilter] = useState<'pending' | 'approved' | 'paid' | 'denied' | 'all'>('pending');
  const [expandedInvoice, setExpandedInvoice] = useState<string | null>(null);
  const [denyNotes, setDenyNotes] = useState('');
  const [processingInvoice, setProcessingInvoice] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  // Payment state
  const [payingInvoice, setPayingInvoice] = useState<string | null>(null);
  const [payDate, setPayDate] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [savingPayment, setSavingPayment] = useState(false);

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadData();
    loadInvoices();
  }, [isAdmin]);

  const loadData = async () => {
    const { data: companyData } = await supabase.from('companies').select('*').order('name');
    setCompanies(companyData || []);
    const { data } = await supabase.from('scanned_vehicles').select('*').order('scanned_at', { ascending: false });
    if (!data) { setLoading(false); return; }
    const enriched: Job[] = await Promise.all(
      data.map(async (v: any) => {
        const { data: sp } = await supabase.from('profiles').select('full_name, company_id').eq('id', v.scanned_by).maybeSingle();
        const cid = v.company_id || sp?.company_id;
        const company = (companyData || []).find((c: Company) => c.id === cid);
        const { count } = await supabase.from('vehicle_photos').select('*', { count: 'exact', head: true }).eq('vehicle_id', v.id);
        return { ...v, company_id: cid, scanner_name: sp?.full_name || 'Unknown', company_name: company?.name || 'Unassigned', photo_count: count || 0 };
      })
    );
    setJobs(enriched);
    setLoading(false);
  };

  const loadInvoices = async () => {
    const { data: invoiceData } = await supabase.from('invoices').select('*').order('submitted_at', { ascending: false });
    if (!invoiceData) { setInvoicesLoading(false); return; }
    const { data: companyData } = await supabase.from('companies').select('*');
    const enriched: Invoice[] = await Promise.all(
      invoiceData.map(async (inv: any) => {
        const company = (companyData || []).find((c: any) => c.id === inv.company_id);
        const { data: submitter } = await supabase.from('profiles').select('full_name, email').eq('id', inv.submitted_by).maybeSingle();
        const { data: vehicleLinks } = await supabase.from('invoice_vehicles').select('vehicle_id').eq('invoice_id', inv.id);
        let vehicles: any[] = [];
        if (vehicleLinks && vehicleLinks.length > 0) {
          const { data: vd } = await supabase.from('scanned_vehicles').select('id, vin, vehicle_year, vehicle_make, vehicle_model').in('id', vehicleLinks.map((vl: any) => vl.vehicle_id));
          vehicles = vd || [];
        }
        let fileUrl: string | undefined;
        if (inv.file_path) {
          const { data: sd } = await supabase.storage.from('invoices').createSignedUrl(inv.file_path, 3600);
          fileUrl = sd?.signedUrl;
        }
        return { ...inv, company_name: company?.name || 'Unknown', submitter_name: submitter?.full_name || 'Unknown', submitter_email: submitter?.email || '', vehicles, file_url: fileUrl };
      })
    );
    setInvoices(enriched);
    setInvoicesLoading(false);
  };

  const handleApproveInvoice = async (invoiceId: string) => {
    if (!user) return;
    setProcessingInvoice(invoiceId);
    const invoice = invoices.find((i) => i.id === invoiceId);
    await supabase.from('invoices').update({ status: 'approved', review_notes: null, reviewed_by: user.id, reviewed_at: new Date().toISOString() }).eq('id', invoiceId);
    if (invoice) {
      await supabase.from('notifications').insert({ user_id: invoice.submitted_by, type: 'invoice_approved', title: `Invoice #${invoice.invoice_number} Approved`, body: `Your invoice for ${invoice.vehicles.length} vehicle${invoice.vehicles.length !== 1 ? 's' : ''} has been approved.` });
      if (invoice.submitter_email) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/send-review-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`, 'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '' },
            body: JSON.stringify({ type: 'invoice_approved', invoice_number: invoice.invoice_number, vehicle_count: invoice.vehicles.length, installer_email: invoice.submitter_email, installer_name: invoice.submitter_name }),
          });
        } catch (e) { console.error('Email failed:', e); }
      }
    }
    setInvoices((prev) => prev.map((i) => i.id === invoiceId ? { ...i, status: 'approved', review_notes: null, reviewed_at: new Date().toISOString() } : i));
    setProcessingInvoice(null);
    setExpandedInvoice(null);
  };

  const handleDenyInvoice = async (invoiceId: string) => {
    if (!user || !denyNotes.trim()) return;
    setProcessingInvoice(invoiceId);
    const invoice = invoices.find((i) => i.id === invoiceId);
    await supabase.from('invoices').update({ status: 'denied', review_notes: denyNotes.trim(), reviewed_by: user.id, reviewed_at: new Date().toISOString() }).eq('id', invoiceId);
    await supabase.from('invoice_vehicles').delete().eq('invoice_id', invoiceId);
    if (invoice) {
      await supabase.from('notifications').insert({ user_id: invoice.submitted_by, type: 'invoice_denied', title: `Invoice #${invoice.invoice_number} Issue`, body: denyNotes.trim() });
      if (invoice.submitter_email) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/send-review-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`, 'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '' },
            body: JSON.stringify({ type: 'invoice_denied', invoice_number: invoice.invoice_number, vehicle_count: invoice.vehicles.length, review_notes: denyNotes.trim(), installer_email: invoice.submitter_email, installer_name: invoice.submitter_name }),
          });
        } catch (e) { console.error('Email failed:', e); }
      }
    }
    setInvoices((prev) => prev.map((i) => i.id === invoiceId ? { ...i, status: 'denied', review_notes: denyNotes.trim(), reviewed_at: new Date().toISOString(), vehicles: [] } : i));
    setDenyNotes('');
    setProcessingInvoice(null);
    setExpandedInvoice(null);
  };

  const handleMarkPaid = async (invoiceId: string) => {
    if (!user || !payDate || !payAmount || !payMethod) return;
    setSavingPayment(true);
    await supabase.from('invoices').update({
      status: 'paid',
      paid_at: new Date(payDate + 'T12:00:00').toISOString(),
      payment_amount: parseFloat(payAmount),
      payment_method: payMethod,
      payment_notes: payNotes.trim() || null,
      paid_by: user.id,
    }).eq('id', invoiceId);

    const invoice = invoices.find((i) => i.id === invoiceId);
    if (invoice?.submitter_email) {
      // Notify installer
      await supabase.from('notifications').insert({
        user_id: invoice.submitted_by,
        type: 'invoice_paid',
        title: `Invoice #${invoice.invoice_number} Paid`,
        body: `Payment of $${parseFloat(payAmount).toFixed(2)} via ${payMethod} on ${new Date(payDate + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`,
      });
    }

    setInvoices((prev) => prev.map((i) => i.id === invoiceId ? {
      ...i, status: 'paid',
      paid_at: new Date(payDate + 'T12:00:00').toISOString(),
      payment_amount: parseFloat(payAmount),
      payment_method: payMethod,
      payment_notes: payNotes.trim() || null,
    } : i));
    setPayingInvoice(null);
    setPayDate(''); setPayAmount(''); setPayMethod(''); setPayNotes('');
    setSavingPayment(false);
  };

  const vehicleTitle = (v: any) => [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle';

  const filteredJobs = jobs.filter((j) => {
    if (companyFilter !== 'all' && j.company_id !== companyFilter) return false;
    if (statusFilter === 'pending') return j.review_status === 'pending' && j.submitted_for_review;
    if (statusFilter === 'approved') return j.review_status === 'approved';
    if (statusFilter === 'denied') return j.review_status === 'denied';
    if (statusFilter === 'not_submitted') return !j.submitted_for_review;
    return true;
  });

  const grouped = filteredJobs.reduce((acc: Record<string, Job[]>, job) => {
    const key = job.company_name || 'Unassigned';
    if (!acc[key]) acc[key] = [];
    acc[key].push(job);
    return acc;
  }, {});

  const filteredInvoices = invoiceFilter === 'all' ? invoices : invoices.filter((i) => i.status === invoiceFilter);
  const pendingInvoiceCount = invoices.filter((i) => i.status === 'pending').length;
  const unpaidCount = invoices.filter((i) => i.status === 'approved').length;

  const jobStatusBadge = (v: Job) => {
    if (!v.submitted_for_review) return <span style={{ padding: '2px 7px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>Not Submitted</span>;
    const isPending = v.review_status === 'pending';
    const isApproved = v.review_status === 'approved';
    const color = isPending ? 'var(--warning)' : isApproved ? 'var(--success)' : 'var(--error)';
    const bg = isPending ? 'var(--warning-bg)' : isApproved ? 'var(--success-bg)' : 'var(--error-bg)';
    const border = isPending ? 'var(--warning-border)' : isApproved ? 'var(--success-border)' : 'var(--error-border)';
    const label = isPending ? '⏳ Pending' : isApproved ? '✅ Approved' : '❌ Rework';
    return <span style={{ padding: '2px 7px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: bg, border: `1px solid ${border}`, color }}>{label}</span>;
  };

  if (loading && invoicesLoading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  if (viewingFile) {
    const isPdf = viewingFile.toLowerCase().includes('.pdf') || viewingFile.includes('application/pdf');
    return (
      <div onClick={() => setViewingFile(null)} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.95)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
        <button onClick={() => setViewingFile(null)} style={{ position: 'absolute', top: '12px', right: '16px', padding: '8px 14px', borderRadius: '10px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', fontSize: '12px', fontWeight: 700, zIndex: 210 }}>✕ Close</button>
        {isPdf ? (
          <iframe src={viewingFile} style={{ width: '100%', maxWidth: '600px', height: '80vh', borderRadius: '8px', border: 'none' }} />
        ) : (
          <img src={viewingFile} alt="Invoice" style={{ maxWidth: '100%', maxHeight: '90vh', objectFit: 'contain', borderRadius: '8px' }} onClick={(e) => e.stopPropagation()} />
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: '4px', marginBottom: '14px', background: 'var(--card)', borderRadius: '10px', padding: '3px' }}>
        <button onClick={() => setTab('jobs')} style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: tab === 'jobs' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: tab === 'jobs' ? 'var(--text-primary)' : 'var(--text-muted)' }}>📋 Jobs</button>
        <button onClick={() => setTab('invoices')} style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: tab === 'invoices' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: tab === 'invoices' ? 'var(--text-primary)' : 'var(--text-muted)', position: 'relative' }}>
          💰 Invoices
          {pendingInvoiceCount > 0 && <span style={{ position: 'absolute', top: '4px', right: '8px', width: '18px', height: '18px', borderRadius: '50%', background: 'var(--orange)', color: '#fff', fontSize: '10px', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{pendingInvoiceCount}</span>}
        </button>
        <button onClick={() => setTab('bulk')} style={{ flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: tab === 'bulk' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: tab === 'bulk' ? 'var(--text-primary)' : 'var(--text-muted)' }}>📤 Bulk VIN</button>
      </div>

      {tab === 'jobs' && (
        <div>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>All Jobs ({filteredJobs.length})</div>
          <div style={{ marginBottom: '8px' }}>
            <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600 }}>
              <option value="all">All Companies</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="unassigned">Unassigned</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: '4px', marginBottom: '14px', overflowX: 'auto' }}>
            {([{ id: 'all' as const, label: 'All' }, { id: 'not_submitted' as const, label: 'Logged' }, { id: 'pending' as const, label: 'Pending' }, { id: 'approved' as const, label: 'Approved' }, { id: 'denied' as const, label: 'Denied' }]).map((f) => (
              <button key={f.id} onClick={() => setStatusFilter(f.id)} style={{ padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap', background: statusFilter === f.id ? 'var(--tab-active-bg)' : 'transparent', border: statusFilter === f.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)', color: statusFilter === f.id ? 'var(--tab-active-color)' : 'var(--text-muted)' }}>{f.label}</button>
            ))}
          </div>
          {filteredJobs.length === 0 && <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}><div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>📋</div><div style={{ fontWeight: 600, fontSize: '13px' }}>No jobs match filters</div></div>}
          {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([cn, cj]) => (
            <div key={cn} style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)', padding: '8px 0', borderBottom: '1px solid var(--border)', marginBottom: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>🏢 {cn}</span>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>{cj.length} job{cj.length !== 1 ? 's' : ''}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {cj.map((job) => (
                  <button key={job.id} onClick={() => router.push(`/photos?id=${job.id}`)} style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%', padding: '12px', borderRadius: '12px', textAlign: 'left', border: '1px solid var(--border)', background: 'var(--card)', boxShadow: 'var(--shadow-sm)', transition: 'all 0.15s' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)' }}>{vehicleTitle(job)}</div>
                        {jobStatusBadge(job)}
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '2px' }}>{job.vin}</div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{job.scanner_name}{job.photo_count ? ` • ${job.photo_count} photo${job.photo_count !== 1 ? 's' : ''}` : ''}{job.end_customer ? ` • ${job.end_customer}` : ''}{' • '}{new Date(job.scanned_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'invoices' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Invoices ({filteredInvoices.length})</div>
            {pendingInvoiceCount > 0 && <div style={{ padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', color: 'var(--warning)' }}>{pendingInvoiceCount} pending</div>}
          </div>
          <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
            {([{ id: 'pending' as const, label: `Pending${pendingInvoiceCount > 0 ? ` (${pendingInvoiceCount})` : ''}` }, { id: 'approved' as const, label: `Unpaid${unpaidCount > 0 ? ` (${unpaidCount})` : ''}` }, { id: 'paid' as const, label: 'Paid' }, { id: 'denied' as const, label: 'Denied' }, { id: 'all' as const, label: 'All' }]).map((f) => (
              <button key={f.id} onClick={() => setInvoiceFilter(f.id)} style={{ padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, background: invoiceFilter === f.id ? 'var(--tab-active-bg)' : 'transparent', border: invoiceFilter === f.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)', color: invoiceFilter === f.id ? 'var(--tab-active-color)' : 'var(--text-muted)' }}>{f.label}</button>
            ))}
          </div>
          {filteredInvoices.length === 0 && <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}><div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>{invoiceFilter === 'pending' ? '✅' : '💰'}</div><div style={{ fontWeight: 600, fontSize: '13px' }}>{invoiceFilter === 'pending' ? 'No pending invoices — all caught up!' : `No ${invoiceFilter} invoices`}</div></div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {filteredInvoices.map((inv) => {
              const isExpanded = expandedInvoice === inv.id;
              const isPending = inv.status === 'pending';
              const isApproved = inv.status === 'approved';
              const isDenied = inv.status === 'denied';
              const isPaid = inv.status === 'paid';
              const statusColor = isPending ? 'var(--warning)' : (isApproved || isPaid) ? 'var(--success)' : 'var(--error)';
              const statusBg = isPending ? 'var(--warning-bg)' : (isApproved || isPaid) ? 'var(--success-bg)' : 'var(--error-bg)';
              const statusBorder = isPending ? 'var(--warning-border)' : (isApproved || isPaid) ? 'var(--success-border)' : 'var(--error-border)';
              return (
                <div key={inv.id} style={{ background: 'var(--card)', border: `1px solid ${isPending ? 'var(--warning-border)' : 'var(--border)'}`, borderRadius: '14px', overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
                  <button onClick={() => { setExpandedInvoice(isExpanded ? null : inv.id); setDenyNotes(''); }} style={{ width: '100%', padding: '14px', textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--text-primary)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: '15px' }}>Invoice #{inv.invoice_number}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>🏢 {inv.company_name} • {inv.submitter_name}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{inv.vehicles.length} vehicle{inv.vehicles.length !== 1 ? 's' : ''}{inv.file_name ? ` • 📎 ${inv.file_name}` : ''}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <span style={{ padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: statusBg, border: `1px solid ${statusBorder}`, color: statusColor }}>{isPending ? '⏳ Pending' : isPaid ? '💵 Paid' : isApproved ? '✅ Approved' : '❌ Denied'}</span>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>{new Date(inv.submitted_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</div>
                      </div>
                    </div>
                  </button>
                  {isExpanded && (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '14px' }}>
                      {inv.file_url && (
                        <button onClick={() => setViewingFile(inv.file_url!)} style={{ width: '100%', padding: '12px', borderRadius: '10px', marginBottom: '10px', border: '1px solid var(--border)', background: 'var(--subtle-bg)', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>📄 View Invoice File</button>
                      )}
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>Vehicles ({inv.vehicles.length})</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {inv.vehicles.map((v: any) => (
                            <button key={v.id} onClick={() => router.push(`/photos?id=${v.id}`)} style={{ padding: '8px 12px', borderRadius: '8px', textAlign: 'left', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '12px' }}>
                              <div style={{ fontWeight: 700 }}>{vehicleTitle(v)}</div>
                              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{v.vin}</div>
                            </button>
                          ))}
                        </div>
                      </div>
                      {isDenied && inv.review_notes && (
                        <div style={{ padding: '10px', borderRadius: '8px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', marginBottom: '10px', fontSize: '12px', color: 'var(--error)' }}><strong>Denial reason:</strong> {inv.review_notes}</div>
                      )}
                      {isPending && (
                        <div>
                          <button onClick={() => handleApproveInvoice(inv.id)} disabled={processingInvoice === inv.id} style={{ width: '100%', padding: '12px', borderRadius: '10px', marginBottom: '8px', background: 'var(--success)', color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none', opacity: processingInvoice === inv.id ? 0.5 : 1 }}>{processingInvoice === inv.id ? 'Processing...' : '✓ Approve Invoice'}</button>
                          <div style={{ padding: '10px', borderRadius: '10px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
                            <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>Deny with reason</label>
                            <textarea value={denyNotes} onChange={(e) => setDenyNotes(e.target.value)} placeholder="What's the issue..." rows={2} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px', resize: 'vertical' }} />
                            <button onClick={() => handleDenyInvoice(inv.id)} disabled={!denyNotes.trim() || processingInvoice === inv.id} style={{ marginTop: '6px', width: '100%', padding: '10px', borderRadius: '8px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontWeight: 700, fontSize: '12px', opacity: !denyNotes.trim() || processingInvoice === inv.id ? 0.4 : 1 }}>✕ Deny Invoice</button>
                          </div>
                        </div>
                      )}
                      {isApproved && (
                        <div>
                          {inv.reviewed_at && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>Approved {new Date(inv.reviewed_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>}
                          {payingInvoice === inv.id ? (
                            <div style={{ padding: '12px', borderRadius: '10px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
                              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' }}>Record Payment</div>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
                                <div>
                                  <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Payment Date</label>
                                  <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px' }} />
                                </div>
                                <div>
                                  <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Amount ($)</label>
                                  <input type="number" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="0.00" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px' }} />
                                </div>
                              </div>
                              <div style={{ marginBottom: '8px' }}>
                                <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Method</label>
                                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                  {['Check', 'ACH', 'Wire', 'Zelle', 'Cash', 'Credit Card', 'Other'].map((m) => (
                                    <button key={m} onClick={() => setPayMethod(m)} style={{
                                      padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                                      background: payMethod === m ? 'var(--navy)' : 'transparent',
                                      border: `1px solid ${payMethod === m ? 'var(--navy)' : 'var(--border)'}`,
                                      color: payMethod === m ? '#fff' : 'var(--text-muted)',
                                    }}>{m}</button>
                                  ))}
                                </div>
                              </div>
                              <div style={{ marginBottom: '10px' }}>
                                <label style={{ display: 'block', fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>Notes (optional)</label>
                                <input type="text" value={payNotes} onChange={(e) => setPayNotes(e.target.value)} placeholder="Check #, reference, etc." style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '13px' }} />
                              </div>
                              <button onClick={() => handleMarkPaid(inv.id)} disabled={savingPayment || !payDate || !payAmount || !payMethod} style={{
                                width: '100%', padding: '12px', borderRadius: '10px', marginBottom: '6px',
                                background: 'var(--success)', color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none',
                                opacity: savingPayment || !payDate || !payAmount || !payMethod ? 0.4 : 1,
                              }}>{savingPayment ? 'Saving...' : '💵 Mark as Paid'}</button>
                              <button onClick={() => { setPayingInvoice(null); setPayDate(''); setPayAmount(''); setPayMethod(''); setPayNotes(''); }} style={{
                                width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid var(--border)',
                                background: 'transparent', color: 'var(--text-muted)', fontSize: '12px', fontWeight: 700,
                              }}>Cancel</button>
                            </div>
                          ) : (
                            <button onClick={() => { setPayingInvoice(inv.id); setPayDate(new Date().toISOString().split('T')[0]); }} style={{
                              width: '100%', padding: '12px', borderRadius: '10px',
                              background: 'var(--navy)', color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none',
                            }}>💵 Mark as Paid</button>
                          )}
                        </div>
                      )}
                      {isPaid && (
                        <div style={{ padding: '12px', borderRadius: '10px', background: 'var(--success-bg)', border: '1px solid var(--success-border)' }}>
                          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--success)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>Payment Recorded</div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '12px' }}>
                            <div><span style={{ color: 'var(--text-muted)' }}>Date:</span> <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{inv.paid_at ? new Date(inv.paid_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</span></div>
                            <div><span style={{ color: 'var(--text-muted)' }}>Amount:</span> <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>${inv.payment_amount?.toFixed(2) || '—'}</span></div>
                            <div><span style={{ color: 'var(--text-muted)' }}>Method:</span> <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{inv.payment_method || '—'}</span></div>
                            {inv.payment_notes && <div><span style={{ color: 'var(--text-muted)' }}>Notes:</span> <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{inv.payment_notes}</span></div>}
                          </div>
                          {inv.reviewed_at && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px' }}>Approved {new Date(inv.reviewed_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</div>}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'bulk' && <BulkVINUpload />}

      <button onClick={() => router.push('/more')} style={{ width: '100%', padding: '10px', borderRadius: '14px', marginTop: '14px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700 }}>← Back</button>
    </div>
  );
}

// ---------- Bulk VIN Upload Component ----------

interface ParsedVIN {
  raw: string;
  vin: string;
  valid: boolean;
  reason?: string;
  duplicate?: boolean;
  existsInDb?: boolean;
  partNumber?: string;
  unitNumber?: string;
  isPartial?: boolean;
}

interface ProcessResult {
  vin: string;
  success: boolean;
  vehicleTitle?: string;
  poMatch?: string;
  error?: string;
}

interface WorksheetHeader {
  vendor_name?: string | null;
  part_number?: string | null;
  date?: string | null;
  po_number?: string | null;
  customer?: string | null;
}

function BulkVINUpload() {
  const { user, profile } = useAuth();
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const worksheetInputRef = useRef<HTMLInputElement>(null);

  // State
  const [inputMode, setInputMode] = useState<'paste' | 'file' | 'worksheet'>('paste');
  const [textInput, setTextInput] = useState('');
  const [fileName, setFileName] = useState('');
  const [parsedVINs, setParsedVINs] = useState<ParsedVIN[]>([]);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [selectedPartId, setSelectedPartId] = useState<string>('');
  const [hasPartNumberColumn, setHasPartNumberColumn] = useState(false);

  // Worksheet state
  const [worksheetHeader, setWorksheetHeader] = useState<WorksheetHeader | null>(null);
  const [scanningWorksheet, setScanningWorksheet] = useState(false);
  const [worksheetError, setWorksheetError] = useState('');
  const [worksheetNotes, setWorksheetNotes] = useState('');

  // Editing state
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [editingField, setEditingField] = useState<'vin' | 'unit' | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editingHeaderField, setEditingHeaderField] = useState<string | null>(null);
  const [editHeaderValue, setEditHeaderValue] = useState('');

  // Processing state
  const [processing, setProcessing] = useState(false);
  const [processedCount, setProcessedCount] = useState(0);
  const [results, setResults] = useState<ProcessResult[]>([]);
  const [showResults, setShowResults] = useState(false);

  // Load catalog items for part selection
  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.from('catalog').select('*').eq('active', true).order('part_number');
      setCatalogItems(data || []);
    };
    load();
  }, []);

  const selectedPart = catalogItems.find(c => c.id === selectedPartId) || null;

  // Parse VINs from text input
  const parseFromText = async (text: string) => {
    const lines = text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    const vins = lines.map(raw => {
      const cleaned = raw.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
      const valid = isValidVIN(cleaned);
      return {
        raw,
        vin: cleaned,
        valid,
        reason: !valid ? (cleaned.length !== 17 ? `${cleaned.length} chars (need 17)` : 'Invalid characters') : undefined,
      } as ParsedVIN;
    });
    // Mark duplicates
    const seen = new Set<string>();
    vins.forEach(v => {
      if (v.valid) {
        if (seen.has(v.vin)) { v.duplicate = true; }
        seen.add(v.vin);
      }
    });
    // Check which already exist in DB
    const validVins = vins.filter(v => v.valid).map(v => v.vin);
    if (validVins.length > 0) {
      const { data: existing } = await supabase.from('scanned_vehicles').select('vin').in('vin', validVins);
      const existingSet = new Set((existing || []).map((e: any) => e.vin));
      vins.forEach(v => {
        if (existingSet.has(v.vin)) v.existsInDb = true;
      });
    }
    setHasPartNumberColumn(false);
    setParsedVINs(vins);
  };

  // Parse VINs from file upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);

    const ext = file.name.split('.').pop()?.toLowerCase();

    if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
      // Use xlsx package
      const XLSX = (await import('xlsx'));
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
      if (rows.length === 0) { setParsedVINs([]); return; }

      // Detect header row
      const headerRow = rows[0].map((h: any) => String(h || '').trim().toUpperCase());
      let vinColIdx = headerRow.findIndex(h => h === 'VIN');
      let partColIdx = headerRow.findIndex(h => h === 'PART_NUMBER' || h === 'PART NUMBER' || h === 'PART' || h === 'PARTNUMBER' || h === 'PART_NUM' || h === 'PART#');

      // If no VIN header, try to find a column with 17-char values
      let dataStartRow = 0;
      if (vinColIdx === -1) {
        // Check if first row looks like a header
        const firstRowHasVin = rows[0].some((c: any) => isValidVIN(String(c || '').trim().toUpperCase()));
        if (firstRowHasVin) {
          vinColIdx = rows[0].findIndex((c: any) => isValidVIN(String(c || '').trim().toUpperCase()));
          dataStartRow = 0;
        } else {
          // First row is headers, find column with VIN-like data in row 2
          dataStartRow = 1;
          for (let col = 0; col < (rows[1]?.length || 0); col++) {
            if (isValidVIN(String(rows[1][col] || '').trim().toUpperCase())) {
              vinColIdx = col;
              break;
            }
          }
        }
      } else {
        dataStartRow = 1; // header row detected, data starts at row 1
      }

      if (vinColIdx === -1) { vinColIdx = 0; } // fallback to first column

      const hasPartCol = partColIdx !== -1;
      setHasPartNumberColumn(hasPartCol);

      const vins: ParsedVIN[] = [];
      for (let i = dataStartRow; i < rows.length; i++) {
        const rawVal = String(rows[i]?.[vinColIdx] || '').trim();
        if (!rawVal) continue;
        const cleaned = rawVal.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
        const valid = isValidVIN(cleaned);
        const partNum = hasPartCol ? String(rows[i]?.[partColIdx] || '').trim() : undefined;
        vins.push({
          raw: rawVal,
          vin: cleaned,
          valid,
          reason: !valid ? (cleaned.length !== 17 ? `${cleaned.length} chars (need 17)` : 'Invalid characters') : undefined,
          partNumber: partNum || undefined,
        });
      }

      // Mark duplicates
      const seen = new Set<string>();
      vins.forEach(v => {
        if (v.valid) {
          if (seen.has(v.vin)) v.duplicate = true;
          seen.add(v.vin);
        }
      });

      // Check DB existence
      const validVins = vins.filter(v => v.valid).map(v => v.vin);
      if (validVins.length > 0) {
        const { data: existing } = await supabase.from('scanned_vehicles').select('vin').in('vin', validVins);
        const existingSet = new Set((existing || []).map((e: any) => e.vin));
        vins.forEach(v => {
          if (existingSet.has(v.vin)) v.existsInDb = true;
        });
      }

      setParsedVINs(vins);
    } else {
      // Plain text file
      const text = await file.text();
      parseFromText(text);
    }
  };

  // Handle worksheet image/PDF upload
  const handleWorksheetUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setWorksheetError('');
    setWorksheetHeader(null);
    setWorksheetNotes('');
    setScanningWorksheet(true);

    try {
      let imageBase64 = '';
      let mediaType = 'image/jpeg';

      const ext = file.name.split('.').pop()?.toLowerCase();
      if (ext === 'pdf') {
        // Send PDF directly to Claude API as a document (native PDF support)
        const reader = new FileReader();
        const pdfBase64 = await new Promise<string>((resolve) => {
          reader.onload = () => resolve((reader.result as string).split(',')[1]);
          reader.readAsDataURL(file);
        });
        imageBase64 = pdfBase64;
        mediaType = 'application/pdf';
      } else {
        // Image file - convert to base64
        const reader = new FileReader();
        const b64 = await new Promise<string>((resolve) => {
          reader.onload = () => resolve((reader.result as string).split(',')[1]);
          reader.readAsDataURL(file);
        });
        imageBase64 = b64;
        mediaType = file.type || 'image/jpeg';
      }

      // Send to API for OCR
      const res = await fetch('/api/scan-worksheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64, mediaType }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to scan worksheet');
      }

      const { data } = await res.json();

      // Set header info
      if (data.header) {
        setWorksheetHeader(data.header);
        autoMatchPart(data.header.part_number || '');
      }
      if (data.notes) setWorksheetNotes(data.notes);

      // Parse rows into VINs
      const vins: ParsedVIN[] = (data.rows || []).map((row: any) => ({
        raw: row.partial_vin || '',
        vin: (row.partial_vin || '').toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, ''),
        valid: !!(row.partial_vin && row.partial_vin.trim().length >= 4),
        isPartial: true,
        unitNumber: row.unit_number || undefined,
        reason: (!row.partial_vin || row.partial_vin.trim().length < 4) ? 'Too short or empty' : undefined,
      }));

      await markDuplicatesAndExisting(vins);
      setParsedVINs(vins);
    } catch (err: any) {
      setWorksheetError(err.message || 'Failed to scan worksheet');
    }
    setScanningWorksheet(false);
  };

  // Auto-match part number from worksheet header
  const autoMatchPart = (partNum: string) => {
    if (!partNum) return;
    const cleaned = partNum.replace(/\s+/g, '').toUpperCase();
    const match = catalogItems.find(c =>
      c.part_number.replace(/\s+/g, '').toUpperCase() === cleaned ||
      c.part_number.replace(/\s+/g, '').toUpperCase().includes(cleaned) ||
      cleaned.includes(c.part_number.replace(/\s+/g, '').toUpperCase())
    );
    if (match) setSelectedPartId(match.id);
  };

  // Mark duplicates within list and check DB existence
  const markDuplicatesAndExisting = async (vins: ParsedVIN[]) => {
    const seen = new Set<string>();
    vins.forEach(v => {
      if (v.valid) {
        if (seen.has(v.vin)) v.duplicate = true;
        seen.add(v.vin);
      }
    });
    const validVins = vins.filter(v => v.valid).map(v => v.vin);
    if (validVins.length > 0) {
      // For partial VINs, check if any existing VIN ends with this partial
      const { data: allVehicles } = await supabase.from('scanned_vehicles').select('vin');
      if (allVehicles) {
        const existingSet = new Set<string>();
        vins.forEach(v => {
          if (v.isPartial) {
            const match = allVehicles.find((ev: any) => ev.vin.endsWith(v.vin));
            if (match) existingSet.add(v.vin);
          } else {
            if (allVehicles.find((ev: any) => ev.vin === v.vin)) existingSet.add(v.vin);
          }
        });
        vins.forEach(v => {
          if (existingSet.has(v.vin)) v.existsInDb = true;
        });
      }
    }
  };

  // --- Inline Editing Helpers ---
  const startEditRow = (index: number, field: 'vin' | 'unit') => {
    const pv = parsedVINs[index];
    setEditingRow(index);
    setEditingField(field);
    setEditValue(field === 'vin' ? (pv.vin || pv.raw) : (pv.unitNumber || ''));
  };

  const commitEditRow = async () => {
    if (editingRow === null || !editingField) return;
    const updated = [...parsedVINs];
    const pv = { ...updated[editingRow] };

    if (editingField === 'vin') {
      const cleaned = editValue.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
      pv.vin = cleaned;
      pv.raw = editValue;
      // Re-validate
      if (pv.isPartial) {
        pv.valid = cleaned.length >= 4;
        pv.reason = cleaned.length < 4 ? 'Too short or empty' : undefined;
      } else {
        pv.valid = isValidVIN(cleaned);
        pv.reason = !pv.valid ? 'Invalid VIN format' : undefined;
      }
      pv.duplicate = false;
      pv.existsInDb = false;
    } else {
      pv.unitNumber = editValue || undefined;
    }

    updated[editingRow] = pv;
    // Re-check duplicates
    updated.forEach(v => { v.duplicate = false; v.existsInDb = false; });
    await markDuplicatesAndExisting(updated);
    setParsedVINs(updated);
    setEditingRow(null);
    setEditingField(null);
    setEditValue('');
  };

  const cancelEditRow = () => {
    setEditingRow(null);
    setEditingField(null);
    setEditValue('');
  };

  const removeRow = (index: number) => {
    const updated = parsedVINs.filter((_, i) => i !== index);
    updated.forEach(v => { v.duplicate = false; v.existsInDb = false; });
    markDuplicatesAndExisting(updated).then(() => setParsedVINs([...updated]));
  };

  const addRow = () => {
    setParsedVINs(prev => [...prev, {
      raw: '',
      vin: '',
      valid: false,
      reason: 'Empty — tap to edit',
      isPartial: inputMode === 'worksheet',
      unitNumber: undefined,
    }]);
    // Auto-focus the new row
    setTimeout(() => startEditRow(parsedVINs.length, 'vin'), 50);
  };

  const startEditHeader = (field: string) => {
    if (!worksheetHeader) return;
    setEditingHeaderField(field);
    setEditHeaderValue((worksheetHeader as any)[field] || '');
  };

  const commitEditHeader = () => {
    if (!editingHeaderField || !worksheetHeader) return;
    const updated = { ...worksheetHeader, [editingHeaderField]: editHeaderValue || null };
    setWorksheetHeader(updated);
    // Re-match part if part_number changed
    if (editingHeaderField === 'part_number') {
      autoMatchPart(editHeaderValue || '');
    }
    setEditingHeaderField(null);
    setEditHeaderValue('');
  };

  const cancelEditHeader = () => {
    setEditingHeaderField(null);
    setEditHeaderValue('');
  };

  // Process all valid VINs
  const processVINs = async () => {
    const toProcess = parsedVINs.filter(v => v.valid && !v.duplicate && !v.existsInDb);
    if (toProcess.length === 0) return;

    setProcessing(true);
    setProcessedCount(0);
    setResults([]);
    setShowResults(false);

    const allResults: ProcessResult[] = [];

    for (let i = 0; i < toProcess.length; i++) {
      const pv = toProcess[i];
      try {
        // 1. Decode VIN (skip for partial VINs from worksheets)
        let vehicle = { year: '', make: '', model: '', trim: '', bodyClass: '', driveType: '', fuelType: '', doors: '', gvwr: '' };
        if (!pv.isPartial) {
          vehicle = await decodeVIN(pv.vin);
        }

        // 2. Determine which part to use
        let part: CatalogItem | null = null;
        if (pv.partNumber) {
          part = catalogItems.find(c => c.part_number === pv.partNumber) || null;
        }
        if (!part && selectedPart) {
          part = selectedPart;
        }

        // 3. PO matching
        let matchedPoLineId: string | null = null;
        let poMatchStr = '';
        let poLines: any[] = [];

        if (part) {
          const { data: poLineData } = await supabase
            .from('po_line_items')
            .select('*, purchase_orders!inner(id, po_number, status)')
            .eq('part_number', part.part_number)
            .eq('purchase_orders.status', 'open');
          poLines = poLineData || [];

          const availableLine = poLines.find((line: any) => line.installed < line.quantity);
          if (availableLine) {
            matchedPoLineId = availableLine.id;
            const poNum = (availableLine as any).purchase_orders.po_number;
            poMatchStr = `PO #${poNum} (${availableLine.installed + 1}/${availableLine.quantity})`;
          }
        }

        // 4. Insert into scanned_vehicles
        const insertPayload: any = {
          vin: pv.vin,
          vehicle_year: vehicle.year || null,
          vehicle_make: vehicle.make || null,
          vehicle_model: vehicle.model || null,
          vehicle_trim: vehicle.trim || null,
          body_class: vehicle.bodyClass || null,
          drive_type: vehicle.driveType || null,
          fuel_type: vehicle.fuelType || null,
          gvwr: vehicle.gvwr || null,
          catalog_id: part?.id || null,
          part_number: part?.part_number || null,
          customer: part?.customer || null,
          end_customer: part?.end_customer || null,
          po_line_item_id: matchedPoLineId,
          scanned_by: user!.id,
          company_id: profile?.company_id || null,
        };
        // Store unit number in notes for worksheet entries
        if (pv.unitNumber) {
          insertPayload.notes = `Unit: ${pv.unitNumber}`;
        }

        const { error: insertError } = await supabase
          .from('scanned_vehicles')
          .insert(insertPayload);

        if (insertError) throw new Error(insertError.message);

        // 5. Increment PO installed count
        if (matchedPoLineId) {
          await supabase.rpc('increment_po_installed', { p_line_id: matchedPoLineId });

          // 6. Check PO completion
          const matchedLine = poLines.find((l: any) => l.id === matchedPoLineId);
          if (matchedLine) {
            const poId = (matchedLine as any).purchase_orders.id;
            const { data: allLines } = await supabase
              .from('po_line_items')
              .select('quantity, installed')
              .eq('po_id', poId);
            const allFulfilled = (allLines || []).every((l: any) => l.installed >= l.quantity);
            if (allFulfilled) {
              await supabase.from('purchase_orders').update({ status: 'complete' }).eq('id', poId);
              poMatchStr += ' - PO COMPLETE!';
            }
          }
        }

        const title = pv.isPartial
          ? `VIN ...${pv.vin}${pv.unitNumber ? ` (${pv.unitNumber})` : ''}`
          : ([vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Unknown Vehicle');
        allResults.push({ vin: pv.vin, success: true, vehicleTitle: title, poMatch: poMatchStr || undefined });
      } catch (err: any) {
        allResults.push({ vin: pv.vin, success: false, error: err.message || 'Unknown error' });
      }

      setProcessedCount(i + 1);
      setResults([...allResults]);

      // Small delay to avoid rate limiting NHTSA API
      if (i < toProcess.length - 1) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    setProcessing(false);
    setShowResults(true);
  };

  const reset = () => {
    setTextInput('');
    setFileName('');
    setParsedVINs([]);
    setResults([]);
    setShowResults(false);
    setProcessedCount(0);
    setHasPartNumberColumn(false);
    setWorksheetHeader(null);
    setWorksheetError('');
    setWorksheetNotes('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (worksheetInputRef.current) worksheetInputRef.current.value = '';
  };

  const validCount = parsedVINs.filter(v => v.valid && !v.duplicate && !v.existsInDb).length;
  const invalidCount = parsedVINs.filter(v => !v.valid).length;
  const duplicateCount = parsedVINs.filter(v => v.duplicate).length;
  const existsCount = parsedVINs.filter(v => v.existsInDb).length;
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  const poMatchCount = results.filter(r => r.poMatch).length;

  // ---- Results View ----
  if (showResults) {
    return (
      <div>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>Bulk Upload Results</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '16px' }}>
          <div style={{ padding: '14px', borderRadius: '12px', background: 'var(--success-bg)', border: '1px solid var(--success-border)', textAlign: 'center' }}>
            <div style={{ fontSize: '28px', fontWeight: 800, color: 'var(--success)' }}>{successCount}</div>
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--success)' }}>Uploaded</div>
          </div>
          {failCount > 0 && (
            <div style={{ padding: '14px', borderRadius: '12px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', textAlign: 'center' }}>
              <div style={{ fontSize: '28px', fontWeight: 800, color: 'var(--error)' }}>{failCount}</div>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--error)' }}>Failed</div>
            </div>
          )}
          {poMatchCount > 0 && (
            <div style={{ padding: '14px', borderRadius: '12px', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', textAlign: 'center' }}>
              <div style={{ fontSize: '28px', fontWeight: 800, color: 'var(--warning)' }}>{poMatchCount}</div>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--warning)' }}>PO Matched</div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '16px' }}>
          {results.map((r, i) => (
            <div key={i} style={{ padding: '10px 12px', borderRadius: '10px', border: `1px solid ${r.success ? 'var(--success-border)' : 'var(--error-border)'}`, background: r.success ? 'var(--success-bg)' : 'var(--error-bg)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{r.success ? '✅' : '❌'} {r.vehicleTitle || r.vin}</span>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{r.vin}</div>
                </div>
                {r.poMatch && <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--warning)', background: 'var(--warning-bg)', padding: '2px 6px', borderRadius: '4px' }}>{r.poMatch}</span>}
              </div>
              {r.error && <div style={{ fontSize: '11px', color: 'var(--error)', marginTop: '4px' }}>{r.error}</div>}
            </div>
          ))}
        </div>

        <button onClick={reset} style={{ width: '100%', padding: '14px', borderRadius: '12px', border: 'none', background: 'var(--navy)', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: 'pointer' }}>Upload More VINs</button>
      </div>
    );
  }

  // ---- Processing View ----
  if (processing) {
    const toProcess = parsedVINs.filter(v => v.valid && !v.duplicate && !v.existsInDb);
    const pct = toProcess.length > 0 ? Math.round((processedCount / toProcess.length) * 100) : 0;
    return (
      <div>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '16px' }}>Processing VINs...</div>
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: '36px', fontWeight: 800, color: 'var(--text-primary)' }}>{processedCount} / {toProcess.length}</div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>Decoding & uploading</div>
        </div>
        <div style={{ height: '8px', borderRadius: '4px', background: 'var(--border)', overflow: 'hidden', marginBottom: '16px' }}>
          <div style={{ height: '100%', borderRadius: '4px', background: 'var(--success)', width: `${pct}%`, transition: 'width 0.3s ease' }} />
        </div>
        {results.length > 0 && (
          <div style={{ maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {results.slice(-5).map((r, i) => (
              <div key={i} style={{ fontSize: '11px', color: r.success ? 'var(--success)' : 'var(--error)', padding: '4px 8px' }}>
                {r.success ? '✅' : '❌'} {r.vin} — {r.success ? r.vehicleTitle : r.error}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---- Main Input View ----
  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>Bulk VIN Upload</div>

      {/* Part Selection */}
      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>Assign Part (optional)</label>
        <select
          value={selectedPartId}
          onChange={(e) => setSelectedPartId(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600 }}
        >
          <option value="">No part selected</option>
          {catalogItems.map(c => (
            <option key={c.id} value={c.id}>{c.part_number} — {c.customer} / {c.end_customer}</option>
          ))}
        </select>
        {hasPartNumberColumn && <div style={{ fontSize: '10px', color: 'var(--warning)', marginTop: '4px', fontWeight: 600 }}>Part number column detected in file — per-VIN parts will override this selection</div>}
      </div>

      {/* Input Mode Toggle */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', background: 'var(--card)', borderRadius: '10px', padding: '3px' }}>
        <button onClick={() => setInputMode('paste')} style={{ flex: 1, padding: '8px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: inputMode === 'paste' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: inputMode === 'paste' ? 'var(--text-primary)' : 'var(--text-muted)' }}>Paste VINs</button>
        <button onClick={() => setInputMode('file')} style={{ flex: 1, padding: '8px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: inputMode === 'file' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: inputMode === 'file' ? 'var(--text-primary)' : 'var(--text-muted)' }}>Upload File</button>
        <button onClick={() => setInputMode('worksheet')} style={{ flex: 1, padding: '8px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: inputMode === 'worksheet' ? 'var(--tab-active-bg)' : 'transparent', border: 'none', color: inputMode === 'worksheet' ? 'var(--text-primary)' : 'var(--text-muted)' }}>Scan Sheet</button>
      </div>

      {/* Input Area */}
      {inputMode === 'paste' ? (
        <div style={{ marginBottom: '12px' }}>
          <textarea
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder={'Paste VINs here — one per line, comma-separated, or space-separated\n\n1FTBW2XM5HKA12345\n1FTBW2XM5HKA12346\n1FTBW2XM5HKA12347'}
            rows={8}
            style={{ width: '100%', padding: '12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'monospace', resize: 'vertical' }}
          />
          <button
            onClick={() => parseFromText(textInput)}
            disabled={!textInput.trim()}
            style={{ width: '100%', marginTop: '8px', padding: '12px', borderRadius: '10px', border: 'none', background: !textInput.trim() ? 'var(--border)' : 'var(--navy)', color: !textInput.trim() ? 'var(--text-muted)' : '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}
          >Parse VINs</button>
        </div>
      ) : inputMode === 'file' ? (
        <div style={{ marginBottom: '12px' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls,.txt"
            onChange={handleFileUpload}
            style={{ display: 'none' }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{ width: '100%', padding: '24px', borderRadius: '12px', border: '2px dashed var(--border)', background: 'var(--card)', color: 'var(--text-muted)', fontSize: '14px', fontWeight: 700, cursor: 'pointer', textAlign: 'center' }}
          >
            {fileName ? `📄 ${fileName}` : '📁 Choose .csv, .xlsx, or .txt file'}
          </button>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px', textAlign: 'center' }}>
            Supports CSV, Excel, and text files. Optionally include a &quot;part_number&quot; column for per-VIN part assignment.
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: '12px' }}>
          <input
            ref={worksheetInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.pdf,.heic"
            onChange={handleWorksheetUpload}
            style={{ display: 'none' }}
          />
          {scanningWorksheet ? (
            <div style={{ width: '100%', padding: '32px', borderRadius: '12px', border: '2px dashed var(--border)', background: 'var(--card)', textAlign: 'center' }}>
              <div style={{ fontSize: '28px', marginBottom: '8px' }}>🔍</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Scanning worksheet...</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>AI is reading the handwritten data</div>
            </div>
          ) : (
            <button
              onClick={() => worksheetInputRef.current?.click()}
              style={{ width: '100%', padding: '24px', borderRadius: '12px', border: '2px dashed var(--border)', background: 'var(--card)', color: 'var(--text-muted)', fontSize: '14px', fontWeight: 700, cursor: 'pointer', textAlign: 'center' }}
            >
              {fileName ? `📄 ${fileName}` : '📷 Upload worksheet photo or PDF'}
            </button>
          )}
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px', textAlign: 'center' }}>
            Take a photo or scan of a handwritten worksheet. AI reads the VINs, part numbers, and PO info.
          </div>
          {worksheetError && (
            <div style={{ padding: '10px', borderRadius: '8px', marginTop: '8px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', fontSize: '12px', color: 'var(--error)' }}>{worksheetError}</div>
          )}
        </div>
      )}

      {/* Worksheet Header Info — Editable */}
      {worksheetHeader && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Worksheet Header</div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>tap to edit</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '12px' }}>
            {(['part_number', 'customer', 'date', 'po_number'] as const).map(field => {
              const labels: Record<string, string> = { part_number: 'Part#', customer: 'Customer', date: 'Date', po_number: 'PO#' };
              const val = (worksheetHeader as any)[field];
              if (!val && editingHeaderField !== field) return null;
              return (
                <div key={field}>
                  <span style={{ color: 'var(--text-muted)' }}>{labels[field]}:</span>{' '}
                  {editingHeaderField === field ? (
                    <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
                      <input
                        autoFocus
                        value={editHeaderValue}
                        onChange={e => setEditHeaderValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') commitEditHeader(); if (e.key === 'Escape') cancelEditHeader(); }}
                        style={{ fontSize: '12px', fontWeight: 700, padding: '2px 6px', border: '1px solid var(--primary)', borderRadius: '4px', background: 'var(--subtle-bg)', color: 'var(--text-primary)', width: '100px', outline: 'none' }}
                      />
                      <button onClick={commitEditHeader} style={{ fontSize: '10px', padding: '2px 4px', border: 'none', background: 'var(--success)', color: '#fff', borderRadius: '3px', cursor: 'pointer' }}>✓</button>
                      <button onClick={cancelEditHeader} style={{ fontSize: '10px', padding: '2px 4px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', borderRadius: '3px', cursor: 'pointer' }}>✕</button>
                    </span>
                  ) : (
                    <span
                      onClick={() => startEditHeader(field)}
                      style={{ fontWeight: 700, color: 'var(--text-primary)', cursor: 'pointer', borderBottom: '1px dashed var(--border)', paddingBottom: '1px' }}
                    >{val}</span>
                  )}
                </div>
              );
            })}
          </div>
          {selectedPart && (
            <div style={{ marginTop: '6px', padding: '4px 8px', borderRadius: '6px', background: 'var(--success-bg)', border: '1px solid var(--success-border)', fontSize: '11px', color: 'var(--success)', fontWeight: 600 }}>
              ✓ Auto-matched to: {selectedPart.part_number}
            </div>
          )}
          {worksheetNotes && (
            <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--text-muted)', fontStyle: 'italic' }}>{worksheetNotes}</div>
          )}
        </div>
      )}

      {/* Preview Table */}
      {parsedVINs.length > 0 && (
        <div>
          {/* Summary */}
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
            <span style={{ padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, background: 'var(--success-bg)', border: '1px solid var(--success-border)', color: 'var(--success)' }}>✓ {validCount} valid</span>
            {invalidCount > 0 && <span style={{ padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)' }}>✕ {invalidCount} invalid</span>}
            {duplicateCount > 0 && <span style={{ padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', color: 'var(--warning)' }}>⚠ {duplicateCount} duplicate</span>}
            {existsCount > 0 && <span style={{ padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>↻ {existsCount} already exists</span>}
          </div>

          {/* VIN List — Editable */}
          <div style={{ maxHeight: '350px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '8px' }}>
            {parsedVINs.map((pv, i) => {
              const skipped = pv.duplicate || pv.existsInDb;
              const isEditingVin = editingRow === i && editingField === 'vin';
              const isEditingUnit = editingRow === i && editingField === 'unit';
              const borderColor = !pv.valid ? 'var(--error-border)' : skipped ? 'var(--border)' : 'var(--success-border)';
              const bgColor = !pv.valid ? 'var(--error-bg)' : skipped ? 'var(--subtle-bg)' : 'var(--success-bg)';
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px', borderRadius: '8px', border: `1px solid ${borderColor}`, background: bgColor }}>
                  <span style={{ fontSize: '14px', width: '20px', textAlign: 'center', flexShrink: 0 }}>{!pv.valid ? '❌' : skipped ? '⏭️' : '✅'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* VIN — editable */}
                    {isEditingVin ? (
                      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                        <input
                          autoFocus
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') commitEditRow(); if (e.key === 'Escape') cancelEditRow(); }}
                          style={{ flex: 1, fontSize: '12px', fontWeight: 700, fontFamily: 'monospace', padding: '3px 6px', border: '1px solid var(--primary)', borderRadius: '4px', background: 'var(--subtle-bg)', color: 'var(--text-primary)', outline: 'none' }}
                          placeholder="Enter VIN..."
                        />
                        <button onClick={commitEditRow} style={{ fontSize: '11px', padding: '3px 6px', border: 'none', background: 'var(--success)', color: '#fff', borderRadius: '4px', cursor: 'pointer', fontWeight: 700 }}>✓</button>
                        <button onClick={cancelEditRow} style={{ fontSize: '11px', padding: '3px 6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', borderRadius: '4px', cursor: 'pointer' }}>✕</button>
                      </div>
                    ) : (
                      <div
                        onClick={() => startEditRow(i, 'vin')}
                        style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', borderBottom: '1px dashed transparent' }}
                        onMouseEnter={e => (e.currentTarget.style.borderBottomColor = 'var(--border)')}
                        onMouseLeave={e => (e.currentTarget.style.borderBottomColor = 'transparent')}
                        title="Click to edit VIN"
                      >{pv.vin || pv.raw || '(empty — click to edit)'}</div>
                    )}
                    {pv.reason && <div style={{ fontSize: '10px', color: 'var(--error)' }}>{pv.reason}</div>}
                    {pv.duplicate && <div style={{ fontSize: '10px', color: 'var(--warning)' }}>Duplicate in list</div>}
                    {pv.existsInDb && <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Already in system</div>}
                    {pv.partNumber && <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Part: {pv.partNumber}</div>}
                    {/* Unit Number — editable */}
                    {isEditingUnit ? (
                      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', marginTop: '2px' }}>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Unit:</span>
                        <input
                          autoFocus
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') commitEditRow(); if (e.key === 'Escape') cancelEditRow(); }}
                          style={{ flex: 1, fontSize: '10px', padding: '2px 4px', border: '1px solid var(--primary)', borderRadius: '3px', background: 'var(--subtle-bg)', color: 'var(--text-primary)', outline: 'none' }}
                          placeholder="Unit number..."
                        />
                        <button onClick={commitEditRow} style={{ fontSize: '9px', padding: '2px 4px', border: 'none', background: 'var(--success)', color: '#fff', borderRadius: '3px', cursor: 'pointer' }}>✓</button>
                        <button onClick={cancelEditRow} style={{ fontSize: '9px', padding: '2px 4px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', borderRadius: '3px', cursor: 'pointer' }}>✕</button>
                      </div>
                    ) : pv.unitNumber ? (
                      <div
                        onClick={() => startEditRow(i, 'unit')}
                        style={{ fontSize: '10px', color: 'var(--text-muted)', cursor: 'pointer' }}
                        title="Click to edit unit number"
                      >Unit: <span style={{ borderBottom: '1px dashed var(--border)' }}>{pv.unitNumber}</span></div>
                    ) : inputMode === 'worksheet' ? (
                      <div
                        onClick={() => startEditRow(i, 'unit')}
                        style={{ fontSize: '10px', color: 'var(--text-muted)', cursor: 'pointer', fontStyle: 'italic' }}
                        title="Click to add unit number"
                      >+ add unit #</div>
                    ) : null}
                    {pv.isPartial && <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontStyle: 'italic' }}>Last 8 of VIN</div>}
                  </div>
                  {/* Remove button */}
                  <button
                    onClick={() => removeRow(i)}
                    title="Remove row"
                    style={{ width: '22px', height: '22px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, lineHeight: 1 }}
                  >✕</button>
                </div>
              );
            })}
          </div>
          {/* Add Row Button */}
          <button
            onClick={addRow}
            style={{ width: '100%', padding: '8px', borderRadius: '8px', border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', marginBottom: '12px' }}
          >+ Add VIN</button>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={reset} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>Clear</button>
            <button
              onClick={processVINs}
              disabled={validCount === 0}
              style={{ flex: 2, padding: '12px', borderRadius: '10px', border: 'none', background: validCount === 0 ? 'var(--border)' : 'var(--success)', color: validCount === 0 ? 'var(--text-muted)' : '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}
            >Upload {validCount} VIN{validCount !== 1 ? 's' : ''}</button>
          </div>
        </div>
      )}
    </div>
  );
}
