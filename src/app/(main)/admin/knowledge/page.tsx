'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { storage } from '@/lib/storage';

interface KnowledgeDoc {
  id: string;
  title: string;
  category: string | null;
  content: string;
  tags: string[] | null;
  file_name: string | null;
  file_type: string | null;
  file_size: number | null;
  file_path: string | null;
  created_at: string;
  updated_at: string;
}

const CATEGORIES = ['SOP', 'spec', 'pricing', 'process', 'policy', 'other'];

const FILE_ICONS: Record<string, string> = {
  'application/pdf': '📄',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '📝',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '📊',
  'text/csv': '📊',
  'text/plain': '📃',
  'text/markdown': '📃',
  'image/png': '🖼️',
  'image/jpeg': '🖼️',
  'image/gif': '🖼️',
  'image/webp': '🖼️',
};

function getFileIcon(fileType: string | null): string {
  if (!fileType) return '📚';
  return FILE_ICONS[fileType] || '📎';
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function KnowledgePage() {
  const router = useRouter();
  const { user, isAdmin } = useAuth();
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('');

  // Create/edit (text mode)
  const [showForm, setShowForm] = useState(false);
  const [editingDoc, setEditingDoc] = useState<KnowledgeDoc | null>(null);
  const [form, setForm] = useState({ title: '', category: 'SOP', content: '', tags: '' });
  const [saving, setSaving] = useState(false);

  // File upload (supports multiple files)
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadForm, setUploadForm] = useState({ category: 'SOP', tags: '' });

  // Background upload status
  const [bgStatus, setBgStatus] = useState<{ message: string; type: 'processing' | 'success' | 'error' } | null>(null);

  // Expanded view
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadDocs();
  }, [isAdmin]);

  const loadDocs = async () => {
    const { data } = await supabase
      .from('knowledge_docs')
      .select('*')
      .order('updated_at', { ascending: false });
    setDocs((data as KnowledgeDoc[]) || []);
    setLoading(false);
  };

  // ─── Text-based save (existing) ───

  const saveDoc = async () => {
    if (!form.title.trim() || !form.content.trim()) return;
    setSaving(true);

    const payload = {
      title: form.title.trim(),
      category: form.category,
      content: form.content.trim(),
      tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : null,
      uploaded_by: user?.id,
      updated_at: new Date().toISOString(),
    };

    if (editingDoc) {
      await supabase.from('knowledge_docs').update(payload).eq('id', editingDoc.id);
    } else {
      await supabase.from('knowledge_docs').insert(payload);
    }

    setSaving(false);
    setShowForm(false);
    setEditingDoc(null);
    setForm({ title: '', category: 'SOP', content: '', tags: '' });
    loadDocs();
  };

  // ─── File upload ───

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploadFiles(Array.from(files));
    setShowUploadForm(true);
  };

  // Split a PDF into chunks of N pages each, returns array of File objects
  const splitPdfIntoChunks = async (file: File, pagesPerChunk: number = 10): Promise<File[]> => {
    const { PDFDocument } = await import('pdf-lib');
    const arrayBuffer = await file.arrayBuffer();
    const srcDoc = await PDFDocument.load(arrayBuffer);
    const totalPages = srcDoc.getPageCount();
    const chunks: File[] = [];
    const baseName = file.name.replace(/\.pdf$/i, '');

    for (let start = 0; start < totalPages; start += pagesPerChunk) {
      const end = Math.min(start + pagesPerChunk, totalPages);
      const newDoc = await PDFDocument.create();
      const pages = await newDoc.copyPages(srcDoc, Array.from({ length: end - start }, (_, i) => start + i));
      pages.forEach(p => newDoc.addPage(p));
      const pdfBytes = await newDoc.save();
      const ab = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;
      const blob = new Blob([ab], { type: 'application/pdf' });
      const chunkFile = new File(
        [blob],
        `${baseName}_pages_${start + 1}-${end}.pdf`,
        { type: 'application/pdf' }
      );
      chunks.push(chunkFile);
    }
    return chunks;
  };

  // Upload a single file chunk to the API and return the result
  const uploadSingleFile = async (file: File, title: string, category: string, tags: string): Promise<{ success: boolean; extractedLength: number; usedVision: boolean; error?: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', title);
    formData.append('category', category);
    formData.append('tags', tags);
    formData.append('userId', user?.id || '');

    const res = await fetch('/api/knowledge/upload', {
      method: 'POST',
      body: formData,
    });

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return { success: false, extractedLength: 0, usedVision: false, error: 'Server error (non-JSON response)' };
    }
    const data = await res.json();
    if (!res.ok) {
      return { success: false, extractedLength: 0, usedVision: false, error: data.error || 'Unknown error' };
    }
    return { success: true, extractedLength: data.extractedLength || 0, usedVision: data.usedVision || false };
  };

  const handleUpload = async () => {
    if (uploadFiles.length === 0) return;

    const MAX_API_SIZE = 4; // MB — Vercel serverless body limit is ~4.5MB, stay under it

    // Check for oversized non-PDF files before closing modal
    const oversized = uploadFiles.filter(f => f.size / (1024 * 1024) > MAX_API_SIZE && !f.name.toLowerCase().endsWith('.pdf'));
    if (oversized.length > 0) {
      alert(`These files are too large (non-PDF files must be under ${MAX_API_SIZE} MB):\n${oversized.map(f => f.name).join('\n')}`);
      return;
    }

    // Capture values before closing modal
    const filesToProcess = [...uploadFiles];
    const formCategory = uploadForm.category;
    const formTags = uploadForm.tags;
    const totalFiles = filesToProcess.length;

    // Close modal immediately — processing continues in background
    setShowUploadForm(false);
    setUploadFiles([]);
    setUploadForm({ category: 'SOP', tags: '' });
    if (fileInputRef.current) fileInputRef.current.value = '';

    setBgStatus({ message: `Processing ${totalFiles} file${totalFiles > 1 ? 's' : ''}...`, type: 'processing' });

    let filesCompleted = 0;
    let filesFailed = 0;

    // Process each file sequentially in background
    for (const fileToUpload of filesToProcess) {
      const fileName = fileToUpload.name;
      const fileSizeMB = fileToUpload.size / (1024 * 1024);
      const isPdfFile = fileName.toLowerCase().endsWith('.pdf');
      const formTitle = fileName.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');

      setBgStatus({
        message: totalFiles > 1
          ? `Processing "${fileName}" (${filesCompleted + 1}/${totalFiles})...`
          : `Processing "${fileName}"...`,
        type: 'processing',
      });

      try {
        if (fileSizeMB > MAX_API_SIZE && isPdfFile) {
          // Large PDF: split into small chunks (3 pages each to stay well under Vercel body limit)
          const PAGES_PER_CHUNK = 3;
          const chunks = await splitPdfIntoChunks(fileToUpload, PAGES_PER_CHUNK);
          const totalChunks = chunks.length;
          let chunksFailed = 0;

          for (let i = 0; i < chunks.length; i++) {
            const chunkSizeMB = chunks[i].size / (1024 * 1024);
            const startPage = i * PAGES_PER_CHUNK + 1;
            const endPage = Math.min((i + 1) * PAGES_PER_CHUNK, totalChunks * PAGES_PER_CHUNK);
            const chunkTitle = `${formTitle} (pages ${startPage}-${endPage})`;

            setBgStatus({
              message: totalFiles > 1
                ? `"${fileName}" chunk ${i + 1}/${totalChunks} (file ${filesCompleted + 1}/${totalFiles})...`
                : `"${fileName}" — analyzing chunk ${i + 1} of ${totalChunks}...`,
              type: 'processing',
            });

            try {
              if (chunkSizeMB > MAX_API_SIZE) {
                // Chunk still too large — store without AI extraction
                const timestamp = Date.now();
                const safeName = chunks[i].name.replace(/[^a-zA-Z0-9._-]/g, '_');
                const storagePath = `uploads/${timestamp}_${safeName}`;
                await storage.from('knowledge-files').upload(storagePath, chunks[i], {
                  contentType: 'application/pdf', upsert: false,
                });
                await fetch('/api/knowledge/upload', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    title: chunkTitle, category: formCategory, tags: formTags,
                    userId: user?.id || '', fileName: chunks[i].name,
                    fileType: 'application/pdf', fileSize: chunks[i].size,
                    storagePath, largeFile: true,
                  }),
                });
              } else {
                const result = await uploadSingleFile(chunks[i], chunkTitle, formCategory, formTags);
                if (!result.success) {
                  chunksFailed++;
                  console.error(`Chunk ${i + 1} of "${fileName}" failed:`, result.error);
                }
              }
            } catch (chunkErr: any) {
              chunksFailed++;
              console.error(`Chunk ${i + 1} of "${fileName}" error:`, chunkErr);
            }

            // Refresh list after each chunk
            loadDocs();
          }

          if (chunksFailed > 0 && chunksFailed === totalChunks) {
            filesFailed++;
          } else {
            filesCompleted++;
          }
        } else {
          // Normal single file (under 4MB)
          const result = await uploadSingleFile(fileToUpload, formTitle, formCategory, formTags);
          if (!result.success) {
            filesFailed++;
            setBgStatus({ message: `"${fileName}" failed: ${result.error}`, type: 'error' });
            console.error(`Upload failed for ${fileName}:`, result.error);
          } else {
            filesCompleted++;
          }
          loadDocs();
        }
      } catch (err: any) {
        filesFailed++;
        console.error(`Upload error for ${fileName}:`, err);
      }
    }

    // Final status
    if (filesFailed > 0) {
      setBgStatus({
        message: `${filesCompleted} of ${totalFiles} file${totalFiles > 1 ? 's' : ''} processed. ${filesFailed} failed.`,
        type: 'error',
      });
    } else {
      setBgStatus({
        message: totalFiles > 1
          ? `All ${totalFiles} files processed successfully`
          : `"${filesToProcess[0].name}" processed successfully`,
        type: 'success',
      });
    }

    loadDocs();

    // Auto-dismiss after 5 seconds (unless still processing)
    setTimeout(() => {
      setBgStatus(prev => prev?.type === 'processing' ? prev : null);
    }, 5000);
  };

  const deleteDoc = async (id: string, filePath?: string | null) => {
    if (!confirm('Delete this knowledge doc?')) return;

    // Delete file from storage if it exists
    if (filePath) {
      await storage.from('knowledge-files').remove([filePath]);
    }

    await supabase.from('knowledge_docs').delete().eq('id', id);
    loadDocs();
  };

  const startEdit = (doc: KnowledgeDoc) => {
    setEditingDoc(doc);
    setForm({
      title: doc.title,
      category: doc.category || 'SOP',
      content: doc.content,
      tags: doc.tags?.join(', ') || '',
    });
    setShowForm(true);
  };

  const getFileUrl = (filePath: string) => {
    const { data } = storage.from('knowledge-files').getPublicUrl(filePath);
    return data?.publicUrl || '';
  };

  // ─── Re-process a single doc with AI vision ───
  const reprocessDoc = async (docId: string, title: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/knowledge/reprocess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId }),
      });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        console.error(`Reprocess "${title}" got non-JSON response`);
        return false;
      }
      const data = await res.json();
      if (!res.ok) {
        console.error(`Reprocess "${title}" failed:`, data.error);
        return false;
      }
      return true;
    } catch (err: any) {
      console.error(`Reprocess "${title}" error:`, err);
      return false;
    }
  };

  const handleReprocess = async (docId: string, title: string) => {
    setBgStatus({ message: `Re-processing "${title}"...`, type: 'processing' });
    const success = await reprocessDoc(docId, title);
    if (success) {
      setBgStatus({ message: `"${title}" re-processed with visual extraction`, type: 'success' });
    } else {
      setBgStatus({ message: `Failed to re-process "${title}"`, type: 'error' });
    }
    loadDocs();
    setTimeout(() => setBgStatus(prev => prev?.type === 'processing' ? prev : null), 5000);
  };

  const handleReprocessAll = async () => {
    // Only re-process docs that have files (PDFs and images)
    const reprocessable = docs.filter(d => d.file_path && d.file_name && (
      d.file_name.toLowerCase().endsWith('.pdf') ||
      !!d.file_name.match(/\.(png|jpg|jpeg|gif|webp|bmp|tiff)$/i)
    ));

    if (reprocessable.length === 0) {
      setBgStatus({ message: 'No PDF or image files to re-process', type: 'error' });
      setTimeout(() => setBgStatus(null), 3000);
      return;
    }

    if (!confirm(`Re-process ${reprocessable.length} file${reprocessable.length > 1 ? 's' : ''} with updated AI vision? This will replace existing extracted text.`)) return;

    let completed = 0;
    let failed = 0;

    for (const doc of reprocessable) {
      setBgStatus({ message: `Re-processing "${doc.title}" (${completed + 1}/${reprocessable.length})...`, type: 'processing' });
      const success = await reprocessDoc(doc.id, doc.title);
      if (success) {
        completed++;
      } else {
        failed++;
      }
      loadDocs();
    }

    if (failed > 0) {
      setBgStatus({ message: `Re-processed ${completed} of ${reprocessable.length} files. ${failed} failed.`, type: 'error' });
    } else {
      setBgStatus({ message: `All ${completed} files re-processed with visual extraction`, type: 'success' });
    }
    setTimeout(() => setBgStatus(prev => prev?.type === 'processing' ? prev : null), 5000);
  };

  const filtered = docs.filter(d => {
    if (filterCat && d.category !== filterCat) return false;
    if (search) {
      const s = search.toLowerCase();
      return d.title.toLowerCase().includes(s) || d.content.toLowerCase().includes(s) || d.tags?.some(t => t.toLowerCase().includes(s)) || d.file_name?.toLowerCase().includes(s);
    }
    return true;
  });

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '8px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-body)', fontSize: '12px',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '9px', fontWeight: 700, color: 'var(--text-label)',
    textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px',
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-label)' }}>Loading knowledge base...</div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '22px', fontWeight: 800 }}>Knowledge Base</div>
          <div style={{ fontSize: '11px', color: 'var(--text-label)', marginTop: '2px' }}>
            Upload files or add docs the AI agent can reference
          </div>
        </div>
      </div>

      {/* Background upload status bar */}
      {bgStatus && (
        <div style={{
          padding: '10px 14px', borderRadius: '10px', marginBottom: '12px',
          fontSize: '12px', fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
          background: bgStatus.type === 'processing' ? 'rgba(59,130,246,0.1)' :
                     bgStatus.type === 'success' ? 'var(--success-bg)' : 'var(--error-bg)',
          border: `1px solid ${bgStatus.type === 'processing' ? 'rgba(59,130,246,0.25)' :
                  bgStatus.type === 'success' ? 'var(--success-border)' : 'var(--error-border)'}`,
          color: bgStatus.type === 'processing' ? '#60a5fa' :
                 bgStatus.type === 'success' ? 'var(--success)' : 'var(--error)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {bgStatus.type === 'processing' && (
              <div style={{
                width: '14px', height: '14px', borderRadius: '50%',
                border: '2px solid rgba(59,130,246,0.3)', borderTopColor: '#60a5fa',
                animation: 'spin 0.8s linear infinite',
              }} />
            )}
            {bgStatus.type === 'success' && <span>✓</span>}
            {bgStatus.type === 'error' && <span>✕</span>}
            <span>{bgStatus.message}</span>
          </div>
          {bgStatus.type !== 'processing' && (
            <button
              onClick={() => setBgStatus(null)}
              style={{ background: 'none', border: 'none', color: 'inherit', fontSize: '14px', cursor: 'pointer', padding: '0 4px' }}
            >✕</button>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <label
          style={{
            flex: 1, padding: '14px', borderRadius: '12px',
            background: 'linear-gradient(135deg, rgba(59,130,246,0.15), rgba(59,130,246,0.05))',
            border: '1px dashed rgba(59,130,246,0.4)',
            color: '#60a5fa', fontWeight: 800, fontSize: '13px',
            cursor: 'pointer', textAlign: 'center',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
          }}
        >
          <span style={{ fontSize: '22px' }}>📁</span>
          <span>Upload File</span>
          <span style={{ fontSize: '9px', color: 'var(--text-label)', fontWeight: 400 }}>
            PDF, Word, Excel, CSV, TXT, Images
          </span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.doc,.xlsx,.xls,.csv,.tsv,.txt,.md,.json,.xml,.html,.png,.jpg,.jpeg,.gif,.webp,.svg"
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />
        </label>

        <button
          onClick={() => { setEditingDoc(null); setForm({ title: '', category: 'SOP', content: '', tags: '' }); setShowForm(true); }}
          style={{
            flex: 1, padding: '14px', borderRadius: '12px',
            background: 'rgba(59,130,246,0.08)',
            border: '1px solid rgba(59,130,246,0.2)',
            color: '#60a5fa', fontWeight: 800, fontSize: '13px',
            cursor: 'pointer', textAlign: 'center',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
          }}
        >
          <span style={{ fontSize: '22px' }}>✏️</span>
          <span>Type / Paste</span>
          <span style={{ fontSize: '9px', color: 'var(--text-label)', fontWeight: 400 }}>
            Manually enter content
          </span>
        </button>
      </div>

      {/* Re-process all button */}
      {docs.some(d => d.file_path && d.file_name && (d.file_name.toLowerCase().endsWith('.pdf') || !!d.file_name.match(/\.(png|jpg|jpeg|gif|webp|bmp|tiff)$/i))) && (
        <button
          onClick={handleReprocessAll}
          disabled={bgStatus?.type === 'processing'}
          style={{
            width: '100%', padding: '8px', borderRadius: '8px', marginBottom: '12px',
            background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)',
            color: '#34d399', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            opacity: bgStatus?.type === 'processing' ? 0.5 : 1,
          }}
        >
          Re-process All Files with AI Vision
        </button>
      )}

      {/* Search + filter */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <input
          placeholder="Search docs..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
        />
        <select
          value={filterCat}
          onChange={e => setFilterCat(e.target.value)}
          style={{ ...inputStyle, width: '120px', flex: 'none' }}
        >
          <option value="">All types</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}
        </select>
      </div>

      {/* Doc list */}
      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-label)' }}>
          <div style={{ fontSize: '28px', marginBottom: '8px' }}>📚</div>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>{docs.length === 0 ? 'No documents yet' : 'No matching documents'}</div>
          <div style={{ fontSize: '11px', marginTop: '4px' }}>
            {docs.length === 0 ? 'Upload files or add reference docs for the AI agent to use.' : 'Try different search terms.'}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {filtered.map(doc => {
          const isExpanded = expandedId === doc.id;
          const hasFile = !!doc.file_path;
          return (
            <div key={doc.id} style={{
              padding: '12px', borderRadius: '12px',
              background: 'var(--card)', border: '1px solid var(--border)',
            }}>
              <div
                onClick={() => setExpandedId(isExpanded ? null : doc.id)}
                style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '16px' }}>{getFileIcon(doc.file_type)}</span>
                    <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {doc.title}
                    </div>
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-label)', display: 'flex', gap: '8px', marginTop: '2px', flexWrap: 'wrap' }}>
                    {doc.category && (
                      <span style={{ padding: '1px 6px', borderRadius: '4px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', fontSize: '9px', fontWeight: 700, textTransform: 'uppercase' }}>
                        {doc.category}
                      </span>
                    )}
                    {hasFile && (
                      <span style={{ padding: '1px 6px', borderRadius: '4px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', color: '#34d399', fontSize: '9px', fontWeight: 700 }}>
                        {doc.file_name}
                      </span>
                    )}
                    {doc.file_size && <span>{formatFileSize(doc.file_size)}</span>}
                    {!hasFile && <span>{doc.content.length} chars</span>}
                    <span>{new Date(doc.updated_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <span style={{ fontSize: '12px', color: 'var(--text-label)', marginLeft: '8px' }}>{isExpanded ? '▲' : '▼'}</span>
              </div>

              {isExpanded && (
                <div style={{ marginTop: '10px' }}>
                  {/* File download link */}
                  {hasFile && doc.file_path && (
                    <a
                      href={getFileUrl(doc.file_path)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '6px',
                        padding: '6px 12px', borderRadius: '8px', marginBottom: '8px',
                        background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)',
                        color: '#34d399', fontSize: '11px', fontWeight: 700,
                        textDecoration: 'none',
                      }}
                    >
                      ⬇️ Download {doc.file_name}
                    </a>
                  )}

                  {/* Extracted text preview */}
                  <div style={{
                    padding: '10px', borderRadius: '8px', background: 'var(--input-bg)',
                    fontSize: '12px', color: 'var(--text-body)', lineHeight: 1.6,
                    maxHeight: '200px', overflowY: 'auto', whiteSpace: 'pre-wrap',
                  }}>
                    {hasFile && (
                      <div style={{ fontSize: '9px', color: 'var(--text-label)', marginBottom: '6px', fontWeight: 700, textTransform: 'uppercase' }}>
                        Extracted Text Preview
                      </div>
                    )}
                    {doc.content.length > 2000 ? doc.content.substring(0, 2000) + '...' : doc.content}
                  </div>

                  {doc.tags && doc.tags.length > 0 && (
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' }}>
                      {doc.tags.map((t, i) => (
                        <span key={i} style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '4px', background: 'var(--subtle-bg)', color: 'var(--text-body)' }}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
                    {hasFile && doc.file_name && (doc.file_name.toLowerCase().endsWith('.pdf') || !!doc.file_name.match(/\.(png|jpg|jpeg|gif|webp|bmp|tiff)$/i)) && (
                      <button onClick={() => handleReprocess(doc.id, doc.title)} style={{ padding: '6px 12px', borderRadius: '6px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', color: '#34d399', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                        Re-process with AI
                      </button>
                    )}
                    <button onClick={() => startEdit(doc)} style={{ padding: '6px 12px', borderRadius: '6px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                      Edit Text
                    </button>
                    <button onClick={() => deleteDoc(doc.id, doc.file_path)} style={{ padding: '6px 12px', borderRadius: '6px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* File Upload Modal */}
      {showUploadForm && uploadFiles.length > 0 && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '18px', maxWidth: '480px', width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-body)' }}>
                Upload {uploadFiles.length > 1 ? `${uploadFiles.length} Files` : 'File'}
              </div>
              <button onClick={() => { setShowUploadForm(false); setUploadFiles([]); if (fileInputRef.current) fileInputRef.current.value = ''; }} style={{ background: 'none', border: 'none', color: 'var(--text-label)', fontSize: '18px', cursor: 'pointer' }}>✕</button>
            </div>

            {/* File list */}
            <div style={{
              borderRadius: '8px', background: 'var(--input-bg)', marginBottom: '12px',
              maxHeight: '180px', overflowY: 'auto',
            }}>
              {uploadFiles.map((file, idx) => (
                <div key={idx} style={{
                  padding: '8px 10px', display: 'flex', alignItems: 'center', gap: '8px',
                  borderBottom: idx < uploadFiles.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  <span style={{ fontSize: '20px' }}>{getFileIcon(file.type)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>{formatFileSize(file.size)}</div>
                  </div>
                  <button onClick={() => {
                    const updated = uploadFiles.filter((_, i) => i !== idx);
                    if (updated.length === 0) { setShowUploadForm(false); setUploadFiles([]); }
                    else setUploadFiles(updated);
                  }} style={{ background: 'none', border: 'none', color: 'var(--text-label)', fontSize: '14px', cursor: 'pointer', padding: '2px 6px' }}>✕</button>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <div style={labelStyle}>Category (applied to all)</div>
                <select style={inputStyle} value={uploadForm.category} onChange={e => setUploadForm({ ...uploadForm, category: e.target.value })}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}
                </select>
              </div>
              <div>
                <div style={labelStyle}>Tags (comma-separated, optional — applied to all)</div>
                <input style={inputStyle} value={uploadForm.tags} onChange={e => setUploadForm({ ...uploadForm, tags: e.target.value })} placeholder="e.g. vinyl, 3M, specs" />
              </div>

              <button
                onClick={handleUpload}
                style={{
                  width: '100%', padding: '12px', borderRadius: '10px',
                  background: '#3b82f6', color: '#fff', fontWeight: 800, fontSize: '13px',
                  border: 'none', cursor: 'pointer',
                }}
              >
                Upload & Process{uploadFiles.length > 1 ? ` (${uploadFiles.length} files)` : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create/Edit Text Modal */}
      {showForm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '18px', maxWidth: '480px', width: '100%', maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-body)' }}>
                {editingDoc ? 'Edit Document' : 'Add Knowledge Document'}
              </div>
              <button onClick={() => { setShowForm(false); setEditingDoc(null); }} style={{ background: 'none', border: 'none', color: 'var(--text-label)', fontSize: '18px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <div style={labelStyle}>Title</div>
                <input style={inputStyle} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Vinyl Spec Guide" />
              </div>
              <div>
                <div style={labelStyle}>Category</div>
                <select style={inputStyle} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}
                </select>
              </div>
              <div>
                <div style={labelStyle}>Content</div>
                <textarea
                  style={{ ...inputStyle, minHeight: '200px', resize: 'vertical', fontFamily: 'inherit' }}
                  value={form.content}
                  onChange={e => setForm({ ...form, content: e.target.value })}
                  placeholder="Paste the full document content here. The AI will be able to search and reference this."
                />
              </div>
              <div>
                <div style={labelStyle}>Tags (comma-separated)</div>
                <input style={inputStyle} value={form.tags} onChange={e => setForm({ ...form, tags: e.target.value })} placeholder="e.g. vinyl, 3M, laminate, specs" />
              </div>

              <button
                onClick={saveDoc}
                disabled={saving || !form.title.trim() || !form.content.trim()}
                style={{
                  width: '100%', padding: '12px', borderRadius: '10px',
                  background: '#3b82f6', color: '#fff', fontWeight: 800, fontSize: '13px',
                  border: 'none', cursor: 'pointer',
                  opacity: saving || !form.title.trim() || !form.content.trim() ? 0.5 : 1,
                }}
              >
                {saving ? 'Saving...' : editingDoc ? 'Update Document' : 'Add Document'}
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={() => router.push('/more')}
        style={{
          width: '100%', padding: '10px', borderRadius: '10px', marginTop: '12px',
          border: '1px solid var(--border)', background: 'transparent',
          color: 'var(--text-body)', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
        }}
      >
        ← Back
      </button>
    </div>
  );
}
