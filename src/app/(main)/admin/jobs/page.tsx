'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

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
}

export default function AllJobsPage() {
  const router = useRouter();
  const { isAdmin, user } = useAuth();
  const supabase = createClient();
  const [tab, setTab] = useState<'jobs' | 'invoices'>('jobs');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [companyFilter, setCompanyFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'approved' | 'denied' | 'not_submitted'>('all');
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [invoiceFilter, setInvoiceFilter] = useState<'pending' | 'approved' | 'denied' | 'all'>('pending');
  const [expandedInvoice, setExpandedInvoice] = useState<string | null>(null);
  const [denyNotes, setDenyNotes] = useState('');
  const [processingInvoice, setProcessingInvoice] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<string | null>(null);

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
            {([{ id: 'pending' as const, label: `Pending${pendingInvoiceCount > 0 ? ` (${pendingInvoiceCount})` : ''}` }, { id: 'approved' as const, label: 'Approved' }, { id: 'denied' as const, label: 'Denied' }, { id: 'all' as const, label: 'All' }]).map((f) => (
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
              const statusColor = isPending ? 'var(--warning)' : isApproved ? 'var(--success)' : 'var(--error)';
              const statusBg = isPending ? 'var(--warning-bg)' : isApproved ? 'var(--success-bg)' : 'var(--error-bg)';
              const statusBorder = isPending ? 'var(--warning-border)' : isApproved ? 'var(--success-border)' : 'var(--error-border)';
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
                        <span style={{ padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: statusBg, border: `1px solid ${statusBorder}`, color: statusColor }}>{isPending ? '⏳ Pending' : isApproved ? '✅ Approved' : '❌ Denied'}</span>
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
                      {isApproved && inv.reviewed_at && <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>Approved {new Date(inv.reviewed_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button onClick={() => router.push('/more')} style={{ width: '100%', padding: '10px', borderRadius: '14px', marginTop: '14px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700 }}>← Back</button>
    </div>
  );
}
