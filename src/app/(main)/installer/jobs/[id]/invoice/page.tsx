'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import DropZone from '@/components/DropZone';

const INVOICE_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  none: { label: 'Not Submitted', color: 'var(--text-muted)' },
  submitted: { label: 'Submitted — Under Review', color: 'var(--warning)' },
  approved: { label: 'Approved — Bill Pending in NetSuite', color: 'var(--success)' },
  billed_in_netsuite: { label: 'Billed in NetSuite', color: 'var(--success)' },
};

export default function InstallerInvoicePage() {
  const router = useRouter();
  const params = useParams();
  const jobId = params.id as string;
  const { user } = useAuth();
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [job, setJob] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!user) return;
    loadJob();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user, jobId]);

  const loadJob = async () => {
    const { data } = await supabase
      .from('cni_jobs')
      .select('id, job_number, title, status, budget, invoice_status, invoice_file_path, netsuite_bill_id, assigned_installer_id')
      .eq('id', jobId)
      .single();
    if (!data) { router.push('/installer'); return; }
    setJob(data);
    setLoading(false);
  };

  const uploadInvoice = async (file: File) => {
    if (!user || !job) return;
    setUploading(true);

    try {
      const ext = file.name.split('.').pop() || 'pdf';
      const path = `cni-invoices/${job.id}/${Date.now()}.${ext}`;

      const formData = new FormData();
      formData.append('file', file);
      formData.append('bucket', 'photos'); // using same bucket, different prefix
      formData.append('path', path);

      const res = await fetch('/api/storage', { method: 'POST', body: formData });
      const result = await res.json();

      if (result.success) {
        await supabase.from('cni_jobs').update({
          invoice_file_path: result.key || path,
          invoice_status: 'submitted',
        }).eq('id', job.id);
        await loadJob();
      }
    } catch (err) {
      console.error('Invoice upload error:', err);
    }

    setUploading(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      uploadInvoice(files[0]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  if (loading || !job) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  const statusInfo = INVOICE_STATUS_LABELS[job.invoice_status] || INVOICE_STATUS_LABELS.none;
  const canUpload = ['in_progress', 'completed_pending_review'].includes(job.status)
    && ['none', 'submitted'].includes(job.invoice_status);

  const sectionStyle: React.CSSProperties = {
    padding: '14px 16px', borderRadius: '12px', marginBottom: '14px',
    background: 'var(--card)', border: '1px solid var(--border)',
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push(`/installer/jobs/${jobId}`)} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Invoice</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{job.job_number} • {job.title}</div>
        </div>
      </div>

      {/* Invoice Status */}
      <div style={{
        ...sectionStyle,
        background: `color-mix(in srgb, ${statusInfo.color} 8%, var(--card))`,
        borderColor: `color-mix(in srgb, ${statusInfo.color} 25%, transparent)`,
      }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>STATUS</div>
        <div style={{ fontSize: '15px', fontWeight: 700, color: statusInfo.color }}>
          {statusInfo.label}
        </div>
        {job.netsuite_bill_id && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            NetSuite Bill: {job.netsuite_bill_id}
          </div>
        )}
      </div>

      {/* Budget Reference */}
      {job.budget && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>JOB BUDGET</div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--success)' }}>
            ${Number(job.budget).toLocaleString()}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Your invoice should match this budget. Invoices exceeding the budget by more than 10% will be flagged for review.
          </div>
        </div>
      )}

      {/* Current Invoice */}
      {job.invoice_file_path && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>UPLOADED INVOICE</div>
          <div style={{
            padding: '12px', borderRadius: '8px',
            background: 'var(--input-bg)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: '10px',
          }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)' }}>File</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                Invoice File
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {job.invoice_file_path.split('/').pop()}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Upload / Replace */}
      {canUpload && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px' }}>
            {job.invoice_file_path ? 'REPLACE INVOICE' : 'UPLOAD INVOICE'}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
            Upload your invoice as a PDF or image file. No financial account details should be included — payment is handled through NetSuite.
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg"
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />

          <DropZone
            onFiles={(files) => { if (files[0]) uploadInvoice(files[0]); }}
            accept=".pdf,.png,.jpg,.jpeg"
            multiple={false}
            disabled={uploading}
            overlayLabel="Drop invoice to upload"
            style={{ borderRadius: '10px' }}
          >
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              style={{
                width: '100%', padding: '14px', borderRadius: '10px', fontSize: '14px', fontWeight: 700,
                background: uploading ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
              }}
            >
              {uploading ? 'Uploading...' : job.invoice_file_path ? 'Replace Invoice File' : 'Upload Invoice File'}
            </button>
          </DropZone>
        </div>
      )}

      {/* Info */}
      <div style={{
        padding: '12px 16px', borderRadius: '12px',
        background: 'var(--subtle-bg)', border: '1px solid var(--border)',
        fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.5',
      }}>
        <strong>How it works:</strong> Upload your invoice file, and the coordinator will review it. Once approved, a bill is created in NetSuite for payment processing. You can track the status here.
      </div>

      <div style={{ height: '80px' }} />
    </div>
  );
}
