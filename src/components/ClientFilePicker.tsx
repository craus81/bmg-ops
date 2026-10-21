'use client';

/**
 * "From Client Files": search the Dropbox client files (migration 379) and
 * tick several to put on a graphics job, without downloading and uploading
 * them again (Craig, 2026-10-19: "A lot of the files i need to upload come
 * from that dropbox folder"). Opens on the job's customer folders, with a
 * chip per folder (Masterack's end customers live in their own) and an
 * "All clients" chip for anything filed elsewhere. The customer's folders
 * show as in Dropbox, folders and sub-folders (ClientFolderBrowser, Craig
 * 2026-10-21); All clients is a search.
 *
 * The picker only picks; the caller links the files (POST
 * /api/graphics-jobs/<id>/client-files), straight away on the job page or
 * once the job exists in the create wizard.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/lib/api-client';
import { createClient } from '@/lib/supabase-browser';
import { closeOnEscape } from '@/lib/modal-escape';
import ClientFileRow, { type ClientFile } from '@/components/ClientFileRow';
import type { ClientFolder } from '@/components/ClientFolderMatches';
import ClientFolderBrowser from '@/components/ClientFolderBrowser';

const PAGE = 30;

interface Props {
  customerName: string | null;
  customerNetsuiteId?: string | null;
  /** Files already on the job: shown ticked and not added twice. */
  alreadyIds?: Set<string>;
  onAdd: (files: ClientFile[]) => void | Promise<void>;
  onClose: () => void;
}

/** customers.id for the job's customer: NetSuite id first, then the exact name. */
async function findCustomerId(name: string | null, netsuiteId?: string | null): Promise<string | null> {
  const supabase = createClient();
  if (netsuiteId) {
    const { data } = await supabase.from('customers').select('id').eq('netsuite_id', netsuiteId).limit(1).maybeSingle();
    if (data?.id) return data.id;
  }
  const n = (name || '').trim();
  if (!n) return null;
  const { data } = await supabase.from('customers').select('id').ilike('company_name', n.replace(/[%_]/g, '\\$&')).limit(1).maybeSingle();
  return data?.id ?? null;
}

export default function ClientFilePicker({ customerName, customerNetsuiteId, alreadyIds, onAdd, onClose }: Props) {
  const [customerId, setCustomerId] = useState<string | null | undefined>(undefined);
  const [folders, setFolders] = useState<ClientFolder[] | null>(null);
  /** 'customer' = every folder linked to the customer; 'all' = every client; else one folder id. */
  const [scope, setScope] = useState<string>('customer');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [files, setFiles] = useState<ClientFile[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(PAGE);
  const [picked, setPicked] = useState<Map<string, ClientFile>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setQ(qInput.trim()); setLimit(PAGE); }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  // The customer's linked folders; none (or no customer) starts on All clients.
  useEffect(() => {
    let live = true;
    (async () => {
      const id = await findCustomerId(customerName, customerNetsuiteId).catch(() => null);
      if (!live) return;
      setCustomerId(id);
      if (!id) { setFolders([]); setScope('all'); return; }
      try {
        const res = await apiFetch(`/api/client-files/folders?customer=${id}`);
        const json = await res.json();
        if (!live) return;
        const list: ClientFolder[] = res.ok ? json.linked || [] : [];
        setFolders(list);
        if (list.length === 0) setScope('all');
      } catch {
        if (live) { setFolders([]); setScope('all'); }
      }
    })();
    return () => { live = false; };
  }, [customerName, customerNetsuiteId]);

  useEffect(() => {
    if (folders === null || scope !== 'all') return;
    let live = true;
    (async () => {
      try {
        // The customer's own folders browse in ClientFolderBrowser; this is the All clients search.
        const p = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
        if (q) p.set('q', q);
        const res = await apiFetch(`/api/client-files?${p.toString()}`);
        const json = await res.json();
        if (!live) return;
        if (!res.ok) throw new Error(json.error || 'Could not search Client Files');
        setFiles(json.files || []);
        setTotal(json.total ?? 0);
        setError(null);
      } catch (e: any) {
        if (live) { setError(e.message); setFiles([]); }
      }
    })();
    return () => { live = false; };
  }, [folders, scope, customerId, q, limit]);

  const toggle = (f: ClientFile) => {
    if (alreadyIds?.has(f.id)) return;
    setPicked(prev => {
      const next = new Map(prev);
      if (next.has(f.id)) next.delete(f.id); else next.set(f.id, f);
      return next;
    });
  };

  const add = async () => {
    if (picked.size === 0) return;
    setAdding(true);
    try {
      await onAdd([...picked.values()]);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not add the files');
    } finally {
      setAdding(false);
    }
  };

  const chip = (active: boolean): CSSProperties => ({
    padding: '5px 11px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
    border: `1px solid ${active ? 'var(--orange, #fb923c)' : 'var(--border-strong)'}`,
    background: active ? 'rgba(251,146,60,0.15)' : 'transparent',
    color: active ? 'var(--orange, #fb923c)' : 'var(--text-secondary)',
    whiteSpace: 'nowrap',
  });

  const sorted = useMemo(() => [...(folders || [])].sort((a, b) => a.name.localeCompare(b.name)), [folders]);
  const scopeName = scope === 'all' ? 'every client'
    : scope === 'customer' ? (sorted.length === 1 ? sorted[0].name : `${customerName}'s folders`)
    : sorted.find(f => f.id === scope)?.name || 'this folder';

  // Portalled above everything: it also opens from inside the create-job sheet (z 1000).
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={closeOnEscape(onClose)}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: '560px', margin: '0 auto',
          height: 'calc(100vh / var(--ts))', display: 'flex', flexDirection: 'column',
          background: 'var(--bg)',
        }}
      >
        <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>Add from Client Files</div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                Linked to the job, not copied: they open from Dropbox&apos;s latest version.
              </div>
            </div>
            <button onClick={onClose} style={{
              background: 'transparent', border: '1px solid var(--border)', borderRadius: '6px', flexShrink: 0,
              padding: '4px 10px', color: 'var(--text-body)', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            }}>Cancel</button>
          </div>
          {folders !== null && (
            <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '8px' }}>
              {sorted.length > 0 && (
                <button onClick={() => { setScope('customer'); setLimit(PAGE); }} style={chip(scope === 'customer')}>
                  {sorted.length === 1 ? `📁 ${sorted[0].name}` : `${customerName} · all ${sorted.length} folders`}
                </button>
              )}
              {sorted.length > 1 && sorted.map(f => (
                <button key={f.id} onClick={() => { setScope(f.id); setLimit(PAGE); }} style={chip(scope === f.id)}>📁 {f.name}</button>
              ))}
              <button onClick={() => { setScope('all'); setLimit(PAGE); }} style={chip(scope === 'all')}>🔎 All clients</button>
            </div>
          )}
          {folders !== null && sorted.length === 0 && (
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
              {customerName
                ? `No Dropbox folder is linked to ${customerName} yet, so this searches every client.`
                : 'Pick the customer first to start in their folder. Searching every client.'}
            </div>
          )}
          {scope === 'all' && <input
            type="search" value={qInput} onChange={e => setQInput(e.target.value)} autoFocus
            placeholder={`🔍 Search ${scopeName}: file name or folder`}
            style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', fontSize: '16px', background: 'var(--input-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}
          />}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px', WebkitOverflowScrolling: 'touch' }}>
          {scope !== 'all' && folders ? (
            <div style={{ paddingTop: '10px' }}>
              <ClientFolderBrowser
                compact
                roots={(scope === 'customer' ? sorted : sorted.filter(f => f.id === scope)).map(f => ({ id: f.id, name: f.name, fileCount: f.fileCount }))}
                rootLabel={`${customerName}'s folders`}
                rootSearch={customerId ? `customer=${customerId}` : undefined}
                pick={{ checked: id => picked.has(id) || !!alreadyIds?.has(id), toggle }}
              />
            </div>
          ) : files === null ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '14px 0' }}>Loading…</div>
          ) : files.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '14px 0' }}>
              {q ? `No files in ${scopeName} match "${q}".` : 'No files here yet.'}
              {scope !== 'all' && (
                <button onClick={() => setScope('all')} style={{ marginLeft: '6px', background: 'none', border: 'none', padding: 0, color: '#60a5fa', fontWeight: 700, cursor: 'pointer', fontSize: 'inherit' }}>
                  Search all clients
                </button>
              )}
            </div>
          ) : (
            files.map(f => (
              <ClientFileRow
                key={f.id} file={f} compact hideClient={scope !== 'all' && sorted.length <= 1}
                checked={picked.has(f.id) || !!alreadyIds?.has(f.id)}
                onCheck={() => toggle(f)}
              />
            ))
          )}
          {scope === 'all' && files && files.length < total && limit < 100 && (
            <button onClick={() => setLimit(100)} style={{ display: 'block', margin: '8px 0 12px', padding: '6px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)' }}>
              Show more ({(total - files.length).toLocaleString()} left)
            </button>
          )}
          {scope === 'all' && files && files.length < total && limit >= 100 && (
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', margin: '8px 0 12px' }}>
              Showing the newest 100 of {total.toLocaleString()}. Type more words to narrow it down.
            </div>
          )}
        </div>

        <div style={{ padding: '10px 16px calc(10px + env(safe-area-inset-bottom))', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ flex: 1, fontSize: '12px', color: error ? 'var(--error)' : 'var(--text-secondary)', minWidth: 0 }}>
            {error || (picked.size === 0 ? 'Tick the files to add.' : `${picked.size} picked`)}
          </div>
          {picked.size > 0 && (
            <button onClick={() => setPicked(new Map())} style={{ padding: '8px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)' }}>Clear</button>
          )}
          <button
            onClick={add} disabled={picked.size === 0 || adding}
            style={{
              padding: '9px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 800, border: 'none',
              cursor: picked.size === 0 || adding ? 'default' : 'pointer',
              background: picked.size === 0 ? 'var(--subtle-bg)' : 'var(--accent, #2563eb)',
              color: picked.size === 0 ? 'var(--text-muted)' : '#fff',
            }}
          >{adding ? 'Adding…' : picked.size === 0 ? 'Add files' : `Add ${picked.size} file${picked.size === 1 ? '' : 's'}`}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
