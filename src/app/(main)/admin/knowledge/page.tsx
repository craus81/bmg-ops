'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

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

  // File upload
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadForm, setUploadForm] = useState({ title: '', category: 'SOP', tags: '' });

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
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadFile(file);
    // Pre-fill title from filename
    const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
    setUploadForm({ ...uploadForm, title: nameWithoutExt });
    setShowUploadForm(true);
  };

  const handleUpload = async () => {
    if (!uploadFile) return;
    setUploading(true);
    setUploadProgress('Uploading and extracting text...');

    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      formData.append('title', uploadForm.title.trim() || uploadFile.name);
      formData.append('category', uploadForm.category);
      formData.append('tags', uploadForm.tags);
      formData.append('userId', user?.id || '');

      const res = await fetch('/api/knowledge/upload', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        alert('Upload failed: ' + (data.error || 'Unknown error'));
      } else {
        setUploadProgress(`Extracted ${data.extractedLength?.toLocaleString() || 0} characters of text`);
      }
    } catch (err: any) {
      alert('Upload error: ' + err.message);
    } finally {
      setUploading(false);
      setUploadProgress('');
      setShowUploadForm(false);
      setUploadFile(null);
      setUploadForm({ title: '', category: 'SOP', tags: '' });
      if (fileInputRef.current) fileInputRef.current.value = '';
      loadDocs();
    }
  };

  const deleteDoc = async (id: string, filePath?: string | null) => {
    if (!confirm('Delete this knowledge doc?')) return;

    // Delete file from storage if it exists
    if (filePath) {
      await supabase.storage.from('knowledge-files').remove([filePath]);
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
    const { data } = supabase.storage.from('knowledge-files').getPublicUrl(filePath);
    return data?.publicUrl || '';
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
    border: '1px solid #2a3a4d', background: '#0f1720',
    color: '#e8ecf1', fontSize: '12px',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '9px', fontWeight: 700, color: '#4a5f78',
    textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px',
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px', color: '#4a5f78' }}>Loading knowledge base...</div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '22px', fontWeight: 800 }}>Knowledge Base</div>
          <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '2px' }}>
            Upload files or add docs the AI agent can reference
          </div>
        </div>
      </div>

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
          <span style={{ fontSize: '9px', color: '#4a5f78', fontWeight: 400 }}>
            PDF, Word, Excel, CSV, TXT, Images
          </span>
          <input
            ref={fileInputRef}
            type="file"
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
          <span style={{ fontSize: '9px', color: '#4a5f78', fontWeight: 400 }}>
            Manually enter content
          </span>
        </button>
      </div>

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
        <div style={{ textAlign: 'center', padding: '40px', color: '#4a5f78' }}>
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
              background: '#141e2b', border: '1px solid #1e2d3d',
            }}>
              <div
                onClick={() => setExpandedId(isExpanded ? null : doc.id)}
                style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '16px' }}>{getFileIcon(doc.file_type)}</span>
                    <div style={{ fontSize: '13px', fontWeight: 800, color: '#e8ecf1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {doc.title}
                    </div>
                  </div>
                  <div style={{ fontSize: '10px', color: '#4a5f78', display: 'flex', gap: '8px', marginTop: '2px', flexWrap: 'wrap' }}>
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
                <span style={{ fontSize: '12px', color: '#4a5f78', marginLeft: '8px' }}>{isExpanded ? '▲' : '▼'}</span>
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
                    padding: '10px', borderRadius: '8px', background: '#0f1720',
                    fontSize: '12px', color: '#c8d6e5', lineHeight: 1.6,
                    maxHeight: '200px', overflowY: 'auto', whiteSpace: 'pre-wrap',
                  }}>
                    {hasFile && (
                      <div style={{ fontSize: '9px', color: '#4a5f78', marginBottom: '6px', fontWeight: 700, textTransform: 'uppercase' }}>
                        Extracted Text Preview
                      </div>
                    )}
                    {doc.content.length > 2000 ? doc.content.substring(0, 2000) + '...' : doc.content}
                  </div>

                  {doc.tags && doc.tags.length > 0 && (
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' }}>
                      {doc.tags.map((t, i) => (
                        <span key={i} style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '4px', background: '#1e2d3d', color: '#6b7a8d' }}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
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
      {showUploadForm && uploadFile && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '14px', padding: '18px', maxWidth: '480px', width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ fontSize: '16px', fontWeight: 800, color: '#e8ecf1' }}>Upload File</div>
              <button onClick={() => { setShowUploadForm(false); setUploadFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }} style={{ background: 'none', border: 'none', color: '#4a5f78', fontSize: '18px', cursor: 'pointer' }}>✕</button>
            </div>

            {/* File preview */}
            <div style={{
              padding: '10px', borderRadius: '8px', background: '#0f1720',
              marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '10px',
            }}>
              <span style={{ fontSize: '28px' }}>{getFileIcon(uploadFile.type)}</span>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#e8ecf1' }}>{uploadFile.name}</div>
                <div style={{ fontSize: '10px', color: '#4a5f78' }}>{formatFileSize(uploadFile.size)}</div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <div style={labelStyle}>Title (auto-filled from filename)</div>
                <input style={inputStyle} value={uploadForm.title} onChange={e => setUploadForm({ ...uploadForm, title: e.target.value })} />
              </div>
              <div>
                <div style={labelStyle}>Category</div>
                <select style={inputStyle} value={uploadForm.category} onChange={e => setUploadForm({ ...uploadForm, category: e.target.value })}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}
                </select>
              </div>
              <div>
                <div style={labelStyle}>Tags (comma-separated, optional)</div>
                <input style={inputStyle} value={uploadForm.tags} onChange={e => setUploadForm({ ...uploadForm, tags: e.target.value })} placeholder="e.g. vinyl, 3M, specs" />
              </div>

              {uploadProgress && (
                <div style={{ fontSize: '11px', color: '#60a5fa', textAlign: 'center', padding: '4px' }}>
                  {uploadProgress}
                </div>
              )}

              <button
                onClick={handleUpload}
                disabled={uploading}
                style={{
                  width: '100%', padding: '12px', borderRadius: '10px',
                  background: '#3b82f6', color: '#fff', fontWeight: 800, fontSize: '13px',
                  border: 'none', cursor: 'pointer',
                  opacity: uploading ? 0.5 : 1,
                }}
              >
                {uploading ? 'Uploading & Extracting Text...' : 'Upload & Process'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create/Edit Text Modal */}
      {showForm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '14px', padding: '18px', maxWidth: '480px', width: '100%', maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ fontSize: '16px', fontWeight: 800, color: '#e8ecf1' }}>
                {editingDoc ? 'Edit Document' : 'Add Knowledge Document'}
              </div>
              <button onClick={() => { setShowForm(false); setEditingDoc(null); }} style={{ background: 'none', border: 'none', color: '#4a5f78', fontSize: '18px', cursor: 'pointer' }}>✕</button>
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
          border: '1px solid #1e2d3d', background: 'transparent',
          color: '#6b7a8d', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
        }}
      >
        ← Back
      </button>
    </div>
  );
}
