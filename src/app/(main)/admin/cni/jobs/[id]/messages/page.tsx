'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import CniJobChat from '@/components/CniJobChat';

export default function AdminJobMessagesPage() {
  const router = useRouter();
  const params = useParams();
  const jobId = params.id as string;
  const { isAdmin, user, loading: authLoading } = useAuth();
  const supabase = createClient();
  const [job, setJob] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin) { router.push('/home'); return; }
    loadJob();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, isAdmin, jobId]);

  const loadJob = async () => {
    const { data } = await supabase
      .from('cni_jobs')
      .select('id, job_number, title')
      .eq('id', jobId)
      .single();
    if (!data) { router.push('/admin/cni'); return; }
    setJob(data);
    setLoading(false);
  };

  if (loading || !job || !user) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  return (
    <CniJobChat
      jobId={job.id}
      userId={user.id}
      backPath={`/admin/cni/jobs/${job.id}`}
      jobNumber={job.job_number}
      jobTitle={job.title}
    />
  );
}
