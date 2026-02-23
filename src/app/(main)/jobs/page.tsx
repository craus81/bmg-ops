'use client';

import { useState, useEffect, useRef } from 'react';
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
  scanner_name?: string;
  photo_count?: number;
  invoiced?: boolean;
}

export default function MyJobsPage() {
  const router = useRouter();
  const { user, profile, isAdmin } = useAuth();
  const supabase = createClient();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'mine' | 'review'>('all');
  const [isBmg, setIsBmg] = useState(true);
  const [companyName, setCompanyName] = useState('');

  // Invoice creation state
  const [invoiceMode, setInvoiceMode] = useState(false);
  const [selectedJobs, setSelectedJobs] = useState<Set<string>>(new Set());
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [submittingInvoice, setSubmittingInvoice] = useState(false);
  const [invoiceSuccess, setInvoiceSuccess] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user || !profile) return;
    loadJobs();
    checkCompany();
  }, [user, profile]);

  const checkCompany = async () => {
    if (!profile?.company_id) return;
    const { data } = await supabase
      .from('companies')
      .select('name')
      .eq('id', profile.company_id)
      .single();
    if (data) {
      setCompanyName(data.name);
      setIsBmg(data.name === 'BMG Fleet');
    }
  };

  const loadJobs = async () => {
    if (!profile?.company_id) {
      setLoading(false);
      return;
    }

    const { data } = await supabase
      .from('scanned_vehicles')
      .select('*')
      .eq('company_id', profile.company_id)
      .order('scanned_at', { ascending: false });

    if (!data) { setLoading(false); return; }

    // Get invoice status for each vehicle
    const { data: invoicedVehicles } = await supabase
      .from('invoice_vehicles')
      .select('vehicle_id, invoices!inner(status)')
      .in('vehicle_id', data.map((v: any) => v.id));

    const invoicedSet = new Set(
      (invoicedVehicles || [])
        .filter((iv: any) => iv.invoices?.status !== 'denied')
        .map((iv: any) => iv.vehicle_id)
    );

    const enriched: Job[] = await Promise.all(
      data.map(async (v: any) => {
        const { data: scannerProfile } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', v.scanned_by)
          .maybeSingle();

        const { count } = await supabase
          .from('vehicle_photos')
          .select('*', { count: 'exact', head: true })
          .eq('vehicle_id', v.id);

        return {
          ...v,
          scanner_name: scannerProfile?.full_name || 'Unknown',
          photo_count: count || 0,
          invoiced: invoicedSet.has(v.id),
        };
      })
    );

    setJobs(enriched);
    setLoading(false);
  };

  const vehicleTitle = (v: Job) =>
    [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Unknown Vehicle';

  const invoiceableJobs = jobs.filter(
    (j) => j.review_status === 'approved' && !j.invoiced
  );

  const toggleJobSelection = (jobId: string) => {
    setSelectedJobs((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  const selectAllInvoiceable = () => {
    if (selectedJobs.size === invoiceableJobs.length) {
      setSelectedJobs(new Set());
    } else {
      setSelectedJobs(new Set(invoiceableJobs.map((j) => j.id)));
    }
  };

  const handleSubmitInvoice = async () => {
    if (!user || !profile?.company_id || selectedJobs.size === 0 || !invoiceNumber.trim()) return;
    setSubmittingInvoice(true);

    let filePath: string | null = null;
    let fileName: string | null = null;

    if (invoiceFile) {
      const ext = invoiceFile.name.split('.').pop() || 'pdf';
      filePath = `${profile.company_id}/${Date.now()}.${ext}`;
      fileName = invoiceFile.name;

      const { error: uploadErr } = await supabase.storage
        .from('invoices')
        .upload(filePath, invoiceFile, { contentType: invoiceFile.type });

      if (uploadErr) {
        alert('File upload failed: ' + uploadErr.message);
        setSubmittingInvoice(false);
        return;
      }
    }

    const { data: invoice, error: invoiceErr } = await supabase
      .from('invoices')
      .insert({
        invoice_number: invoiceNumber.trim(),
        company_id: profile.company_id,
        submitted_by: user.id,
        file_path: filePath,
        file_name: fileName,
        status: 'pending',
      })
      .select()
      .single();

    if (invoiceErr || !invoice) {
      alert('Failed to create invoice: ' + (invoiceErr?.message || 'Unknown error'));
      setSubmittingInvoice(false);
      return;
    }

    const vehicleLinks = Array.from(selectedJobs).map((vehicleId) => ({
      invoice_id: invoice.id,
      vehicle_id: vehicleId,
    }));

    await supabase.from('invoice_vehicles').insert(vehicleLinks);

    // Notify admins
    const { data: admins } = await supabase
      .from('profiles')
      .select('id, email')
      .eq('role', 'admin')
      .eq('status', 'approved');

    if (admins && admins.length > 0) {
      await supabase
        .from('notifications')
        .insert(admins.map((admin: any) => ({
          user_id: admin.id,
          type: 'invoice_submitted',
          title: `Invoice #${invoiceNumber.trim()} from ${companyName}`,
          body: `${selectedJobs.size} vehicle${selectedJobs.size !== 1 ? 's' : ''} included`,
        })));

      try {
        const { data: { session } } = await supabase.auth.getSession();
        await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/send-review-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
            'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
          },
          body: JSON.stringify({
            type: 'invoice_submitted',
            invoice_number: invoiceNumber.trim(),
            company_name: companyName,
            vehicle_count: selectedJobs.size,
            admin_emails: admins.map((a: any) => a.email),
          }),
        });
      } catch (e) {
        console.error('Email send failed:', e);
      }
    }

    setInvoiceSuccess(true);
    setSubmittingInvoice(false);
  };

  const resetInvoiceMode = () => {
    setInvoiceMode(false);
    setSelectedJobs(new Set());
    setInvoiceNumber('');
    setInvoiceFile(null);
    setInvoiceSuccess(false);
    loadJobs();
  };

  const filtered = filter === 'mine'
    ? jobs.filter((j) => j.scanned_by === user?.id)
    : filter === 'review'
    ? jobs.filter((j) => j.submitted_for_review)
    : jobs;

  const statusBadge = (v: Job) => {
    if (v.invoiced) {
      return (
        <span style={{
          padding: '2px 7px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
          background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)',
        }}>💰 Invoiced</span>
      );
    }
    if (!v.submitted_for_review) return null;
    const isPending = v.review_status === 'pending';
    const isApproved = v.review_status === 'approved';
    const color = isPending ? 'var(--warning)' : isApproved ? 'var(--success)' : 'var(--error)';
    const bg = isPending ? 'var(--warning-bg)' : isApproved ? 'var(--success-bg)' : 'var(--error-bg)';
    const border = isPending ? 'var(--warning-border)' : isApproved ? 'var(--success-border)' : 'var(--error-border)';
    const label = isPending ? '⏳ Pending' : isApproved ? '✅ Approved' : '❌ Rework';
    return (
      <span style={{
        padding: '2px 7px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
        background: bg, border: `1px solid ${border}`, color,
      }}>{label}</span>
    );
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  if (!profile?.company_id) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
        <div style={{ fontSize: '36px', marginBottom: '8px', opacity: 0.4 }}>🏢</div>
        <div style={{ fontWeight: 600, fontSize: '14px' }}>No company assigned</div>
        <div style={{ fontSize: '12px', marginTop: '4px' }}>Ask an admin to assign you to a company.</div>
      </div>
    );
  }

  if (invoiceSuccess) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <div style={{ fontSize: '48px', marginBottom: '12px' }}>✅</div>
        <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Invoice Submitted</div>
        <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '6px' }}>
          Invoice #{invoiceNumber} with {selectedJobs.size} vehicle{selectedJobs.size !== 1 ? 's' : ''} has been submitted for review.
        </div>
        <button
          onClick={resetInvoiceMode}
          style={{
            marginTop: '20px', padding: '14px 28px', borderRadius: '14px',
            background: 'var(--navy)', color: '#fff', fontWeight: 700, fontSize: '14px', border: 'none',
          }}
        >
          Done
        </button>
      </div>
    );
  }

  if (invoiceMode) {
    return (
      <div>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
          Create Invoice
        </div>

        {invoiceableJobs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>📋</div>
            <div style={{ fontWeight: 600, fontSize: '13px' }}>No jobs ready to invoice</div>
            <div style={{ fontSize: '11px', marginTop: '4px' }}>Jobs must have approved photos before invoicing.</div>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: '12px' }}>
              <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
                Invoice Number
              </label>
              <input
                type="text"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                placeholder="Enter your invoice number..."
                style={{
                  width: '100%', padding: '12px', borderRadius: '10px',
                  border: '1px solid var(--border)', background: 'var(--bg)',
                  color: 'var(--text-primary)', fontSize: '15px', fontWeight: 700,
                }}
              />
            </div>

            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
                Invoice File (PDF or Photo)
              </label>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,image/*"
                onChange={(e) => setInvoiceFile(e.target.files?.[0] || null)}
                style={{ display: 'none' }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                style={{
                  width: '100%', padding: '12px', borderRadius: '10px',
                  border: '1px dashed var(--border)', background: 'var(--card)',
                  color: invoiceFile ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontSize: '13px', fontWeight: 600,
                }}
              >
                {invoiceFile ? `📎 ${invoiceFile.name}` : '📎 Tap to attach invoice file'}
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Select Jobs ({selectedJobs.size} of {invoiceableJobs.length})
              </label>
              <button
                onClick={selectAllInvoiceable}
                style={{
                  padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                  background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
                }}
              >
                {selectedJobs.size === invoiceableJobs.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
              {invoiceableJobs.map((job) => {
                const isSelected = selectedJobs.has(job.id);
                return (
                  <button
                    key={job.id}
                    onClick={() => toggleJobSelection(job.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
                      padding: '12px', borderRadius: '12px', textAlign: 'left',
                      border: isSelected ? '2px solid var(--success)' : '1px solid var(--border)',
                      background: isSelected ? 'var(--success-bg)' : 'var(--card)',
                      transition: 'all 0.15s',
                    }}
                  >
                    <div style={{
                      width: '24px', height: '24px', borderRadius: '6px',
                      border: isSelected ? '2px solid var(--success)' : '2px solid var(--border)',
                      background: isSelected ? 'var(--success)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '14px', color: '#fff', flexShrink: 0,
                    }}>
                      {isSelected ? '✓' : ''}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)' }}>
                        {vehicleTitle(job)}
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '1px' }}>
                        {job.vin}
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px' }}>
                        {job.scanner_name} • {new Date(job.scanned_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <button
              onClick={handleSubmitInvoice}
              disabled={submittingInvoice || selectedJobs.size === 0 || !invoiceNumber.trim()}
              style={{
                width: '100%', padding: '14px', borderRadius: '14px',
                background: 'var(--orange)', color: '#fff',
                fontWeight: 800, fontSize: '15px', border: 'none',
                boxShadow: '0 4px 16px rgba(238,49,32,0.3)',
                opacity: submittingInvoice || selectedJobs.size === 0 || !invoiceNumber.trim() ? 0.4 : 1,
              }}
            >
              {submittingInvoice ? 'Submitting...' : `Submit Invoice (${selectedJobs.size} job${selectedJobs.size !== 1 ? 's' : ''})`}
            </button>
          </>
        )}

        <button
          onClick={() => { setInvoiceMode(false); setSelectedJobs(new Set()); setInvoiceNumber(''); setInvoiceFile(null); }}
          style={{
            width: '100%', padding: '10px', borderRadius: '10px', marginTop: '8px',
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700,
          }}
        >
          ← Cancel
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
        My Jobs
      </div>

      {!isBmg && invoiceableJobs.length > 0 && (
        <button
          onClick={() => setInvoiceMode(true)}
          style={{
            width: '100%', padding: '14px', borderRadius: '14px', marginBottom: '12px',
            background: 'var(--orange)', color: '#fff',
            fontWeight: 800, fontSize: '14px', border: 'none',
            boxShadow: '0 4px 16px rgba(238,49,32,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          }}
        >
          💰 Create Invoice ({invoiceableJobs.length} job{invoiceableJobs.length !== 1 ? 's' : ''} ready)
        </button>
      )}

      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
        {([
          { id: 'all' as const, label: `All (${jobs.length})` },
          { id: 'mine' as const, label: 'My Scans' },
          { id: 'review' as const, label: 'Submitted' },
        ]).map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: filter === f.id ? 'var(--tab-active-bg)' : 'transparent',
            border: filter === f.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: filter === f.id ? 'var(--tab-active-color)' : 'var(--text-muted)',
          }}>
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '36px', marginBottom: '6px', opacity: 0.4 }}>📋</div>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>No jobs found</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {filtered.map((job) => (
          <button
            key={job.id}
            onClick={() => router.push(`/photos?id=${job.id}`)}
            style={{
              display: 'flex', alignItems: 'center', gap: '14px', width: '100%',
              padding: '14px', borderRadius: '14px', textAlign: 'left',
              border: '1px solid var(--border)', background: 'var(--card)',
              boxShadow: 'var(--shadow-sm)', transition: 'all 0.15s',
            }}
          >
            <div style={{
              width: '44px', height: '44px', borderRadius: '12px',
              background: 'var(--subtle-bg)', display: 'flex',
              alignItems: 'center', justifyContent: 'center', fontSize: '20px', flexShrink: 0,
            }}>🚐</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>
                  {vehicleTitle(job)}
                </div>
                {statusBadge(job)}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '2px' }}>
                {job.vin}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {job.scanner_name}
                {job.photo_count ? ` • ${job.photo_count} photo${job.photo_count !== 1 ? 's' : ''}` : ''}
                {job.end_customer ? ` • ${job.end_customer}` : ''}
                {' • '}{new Date(job.scanned_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
