/**
 * CNI job attachments (proofs, photos, docs that describe a job). Files live
 * in R2 under bucket 'photos', prefix 'cni-job-files/<jobId>/'; the job row
 * keeps a [{ name, path }] list in cni_jobs.attachments. Client-side helpers
 * shared by the new-job form and the job detail pages.
 */

import { storage } from './storage';

export interface JobFile {
  name: string;   // original filename, for display
  path: string;   // R2 key
}

const BUCKET = 'photos';

function safeName(name: string): string {
  return name.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';
}

/** Upload files for a job; returns the ones that succeeded plus any errors. */
export async function uploadJobFiles(
  jobId: string,
  files: File[],
): Promise<{ uploaded: JobFile[]; errors: string[] }> {
  const uploaded: JobFile[] = [];
  const errors: string[] = [];
  for (const f of files) {
    const path = `cni-job-files/${jobId}/${Date.now()}-${safeName(f.name)}`;
    const { error } = await storage.from(BUCKET).upload(path, f);
    if (error) errors.push(`${f.name}: ${error.message}`);
    else uploaded.push({ name: f.name, path });
  }
  return { uploaded, errors };
}

/** Public download URL for an attachment path. */
export function jobFileUrl(path: string): string {
  return storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}
