'use client';

/**
 * Install guide editor: upload 1:20 scale template/proof pages (images or
 * PDFs — PDFs rasterize client-side via pdfjs, which also auto-calibrates
 * them), draw engineering-style dimension lines whose labels read in
 * actual vehicle inches, add leader notes, tune the best-practice
 * sections, and export the branded PDF for CNI installers.
 *
 * Geometry lives in template-image pixel coordinates (like the wrap-quote
 * estimator) so annotations redraw at any display size; the per-page
 * px_per_in calibration converts pixel spans to real inches.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { createClient } from '@/lib/supabase-browser';
import { storage } from '@/lib/storage';
import { theme } from '@/lib/theme';
import { fetchCompanyLetterhead, type CompanyLetterhead } from '@/lib/company-profile';
import {
  DIM_COLOR,
  NOTE_COLOR,
  PDF_RENDER_SCALE,
  defaultGuideSections,
  dimLabelText,
  makeId,
  parseGuideScale,
  renderGuidePage,
  type DimAnnotation,
  type GuidePage,
  type InstallGuide,
} from '@/lib/install-guide';
import { baseSourcePath, type ProofMode } from '@/lib/proof-assembly';
import { buildDimensionedProofPdf, dimensionedProofFileName } from '@/lib/proof-pdf';
import EmailComposeModal, { type EmailComposeFields } from '@/components/EmailComposeModal';
import { apiFetch } from '@/lib/api-client';
import { uploadJobFiles, type JobFile } from '@/lib/job-files';
import { layoutDimension, pointToSegmentDistance, type Pt } from '@/lib/dimension-geometry';
import {
  distancePx,
  formatDimension,
  pxPerRealInchFromDpi,
  realInchesFromPx,
  snapToAxis,
  type DimUnits,
} from '@/lib/dimension-scale';
import { buildInstallGuidePdf, installGuideFileName, type RenderedGuidePage } from '@/lib/install-guide-pdf';

type Tool = 'select' | 'dim' | 'note' | 'calibrate';

interface DragState {
  dimId: string;
  part: 'p1' | 'p2' | 'offset';
  start: Pt;
  moved: boolean;
}

interface CniJobLite {
  id: string;
  job_number: string;
  title: string;
  customer_name: string | null;
  status: string;
  created_at: string;
}

const BUCKET = 'vehicle-templates';

const cardStyle: React.CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px 16px',
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${theme.border}`,
  background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px',
};
const labelStyle: React.CSSProperties = {
  fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px',
};
const btnStyle = (color: string, bg: string): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
  background: bg, border: `1px solid ${color}40`, color, cursor: 'pointer',
});

const saveErrorMessage = (error: { message?: string; code?: string } | null | undefined) => {
  const msg = error?.message || 'unknown error';
  const drift =
    error?.code === 'PGRST204' || /schema cache|relation .* does not exist|column .* does not exist/i.test(msg);
  return drift
    ? `${msg}\n\nThe install_guides migration hasn't been applied to this database yet. Run "npm run migrate".`
    : msg;
};

export default function InstallGuideEditorPage() {
  const { isAdmin, isSales, isGraphicsProduction, loading: authLoading } = useAuth();
  const hasAccess = isAdmin || isSales || isGraphicsProduction;
  const params = useParams<{ id: string }>();
  const guideId = params?.id;
  const router = useRouter();
  const dialog = useDialog();
  const supabase = createClient();

  const [guide, setGuide] = useState<InstallGuide | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [selId, setSelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ p1: Pt; p2: Pt } | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportingProof, setExportingProof] = useState(false);
  const [proofMode, setProofMode] = useState<ProofMode>('replace');
  const [sendOpen, setSendOpen] = useState(false);
  const [sendKind, setSendKind] = useState<'proof' | 'guide'>('guide');
  const [sendBusy, setSendBusy] = useState<string | null>(null);
  const [jobPicker, setJobPicker] = useState<{ jobs: CniJobLite[]; search: string } | null>(null);
  const [emailAttachment, setEmailAttachment] = useState<{ path: string; name: string; sizeBytes: number } | null>(null);
  const [showSections, setShowSections] = useState(false);
  const [letterhead, setLetterhead] = useState<CompanyLetterhead | null>(null);
  const [pdfImport, setPdfImport] = useState<{
    fileName: string;
    thumbs: { idx: number; dataUrl: string }[];
    selected: Set<number>;
  } | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const draftRef = useRef<{ p1: Pt; p2: Pt } | null>(null);
  const undoRef = useRef<string[]>([]);
  const dirtyRef = useRef(false);
  const pdfDocRef = useRef<any>(null);
  const pdfFileRef = useRef<File | null>(null);
  const attachFileRef = useRef<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---- Load ----
  useEffect(() => {
    if (authLoading || !hasAccess || !guideId) return;
    (async () => {
      const { data, error } = await supabase.from('install_guides').select('*').eq('id', guideId).single();
      if (error || !data) {
        setLoadError(saveErrorMessage(error) || 'Guide not found.');
      } else {
        const g = data as InstallGuide;
        g.pages = Array.isArray(g.pages) ? g.pages : [];
        g.sections = Array.isArray(g.sections) && g.sections.length ? g.sections : defaultGuideSections();
        g.units = (g.units === 'ft-in' ? 'ft-in' : 'in') as DimUnits;
        g.fraction_denominator = g.fraction_denominator || 8;
        setGuide(g);
        setActivePageId(g.pages[0]?.id || null);
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [authLoading, hasAccess, guideId]);

  useEffect(() => {
    fetchCompanyLetterhead().then(setLetterhead);
  }, []);

  // ---- Autosave (debounced) ----
  useEffect(() => {
    if (!guide || !dirtyRef.current) return;
    setSaveState('dirty');
    const t = setTimeout(async () => {
      setSaveState('saving');
      const { error } = await supabase
        .from('install_guides')
        .update({
          title: guide.title,
          customer_name: guide.customer_name,
          vehicle_desc: guide.vehicle_desc,
          scale: guide.scale,
          units: guide.units,
          fraction_denominator: guide.fraction_denominator,
          pages: guide.pages,
          sections: guide.sections,
          updated_at: new Date().toISOString(),
        })
        .eq('id', guide.id);
      if (error) {
        setSaveError(saveErrorMessage(error));
        setSaveState('error');
      } else {
        dirtyRef.current = false;
        setSaveError(null);
        setSaveState('saved');
      }
    }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [guide]);

  const mutate = useCallback((fn: (g: InstallGuide) => InstallGuide) => {
    dirtyRef.current = true;
    setGuide(prev => (prev ? fn(prev) : prev));
  }, []);

  // Flush a pending debounced save when the editor unmounts (Back button,
  // tab list click) so the last edit isn't silently dropped, and warn on a
  // hard navigation while dirty.
  const guideRef = useRef<InstallGuide | null>(null);
  useEffect(() => {
    guideRef.current = guide;
  }, [guide]);
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      const g = guideRef.current;
      if (dirtyRef.current && g) {
        supabase
          .from('install_guides')
          .update({
            title: g.title,
            customer_name: g.customer_name,
            vehicle_desc: g.vehicle_desc,
            scale: g.scale,
            units: g.units,
            fraction_denominator: g.fraction_denominator,
            pages: g.pages,
            sections: g.sections,
            updated_at: new Date().toISOString(),
          })
          .eq('id', g.id)
          .then(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, []);

  const activePage = useMemo(
    () => guide?.pages.find(p => p.id === activePageId) || guide?.pages[0] || null,
    [guide, activePageId],
  );

  const updatePage = useCallback(
    (pageId: string, fn: (p: GuidePage) => GuidePage) => {
      mutate(g => ({ ...g, pages: g.pages.map(p => (p.id === pageId ? fn(p) : p)) }));
    },
    [mutate],
  );

  const pushUndo = useCallback(() => {
    if (!guide) return;
    undoRef.current.push(JSON.stringify(guide.pages));
    if (undoRef.current.length > 50) undoRef.current.shift();
  }, [guide]);

  const undo = useCallback(() => {
    const snap = undoRef.current.pop();
    if (!snap) return;
    setSelId(null);
    mutate(g => ({ ...g, pages: JSON.parse(snap) }));
  }, [mutate]);

  const imgUrl = useCallback(
    (path: string) => storage.from(BUCKET).getPublicUrl(path).data.publicUrl,
    [],
  );

  // ---- Keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        undo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && selId && activePage) {
        e.preventDefault();
        pushUndo();
        updatePage(activePage.id, p => ({ ...p, dims: p.dims.filter(d => d.id !== selId) }));
        setSelId(null);
      } else if (e.key === 'Escape') {
        setDraft(null);
        draftRef.current = null;
        dragRef.current = null;
        if (tool !== 'select') setTool('select');
        else setSelId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selId, activePage, tool, undo, pushUndo, updatePage]);

  // ---- Canvas coordinate mapping ----
  // getBoundingClientRect and clientX/Y are both in the zoomed page's space,
  // so the text-size zoom factor cancels out of this ratio (see CLAUDE.md).
  const svgPoint = (e: { clientX: number; clientY: number }): Pt | null => {
    const svg = svgRef.current;
    if (!svg || !activePage) return null;
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: (e.clientX - r.left) * (activePage.image_w / r.width),
      y: (e.clientY - r.top) * (activePage.image_h / r.height),
    };
  };

  const hitThreshold = () => (activePage ? Math.max(10, activePage.image_w / 80) : 12);

  const hitTest = (p: Pt): { id: string; part: DragState['part'] } | null => {
    if (!activePage) return null;
    const thr = hitThreshold();
    // Endpoint handles of the selected annotation take priority.
    const sel = activePage.dims.find(d => d.id === selId);
    if (sel) {
      if (Math.hypot(p.x - sel.p1.x, p.y - sel.p1.y) < thr) return { id: sel.id, part: 'p1' };
      if (Math.hypot(p.x - sel.p2.x, p.y - sel.p2.y) < thr) return { id: sel.id, part: 'p2' };
    }
    let best: { id: string; part: DragState['part']; dist: number } | null = null;
    for (const d of activePage.dims) {
      let dist: number;
      let part: DragState['part'];
      if (d.kind === 'dim') {
        const lay = layoutDimension(d.p1, d.p2, d.offset);
        dist = pointToSegmentDistance(p, lay.dim[0], lay.dim[1]);
        part = 'offset';
      } else {
        dist = Math.min(
          pointToSegmentDistance(p, d.p1, d.p2),
          Math.hypot(p.x - d.p2.x, p.y - d.p2.y),
        );
        part = 'p2';
      }
      if (dist < thr && (!best || dist < best.dist)) best = { id: d.id, part, dist };
    }
    return best ? { id: best.id, part: best.part } : null;
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!activePage) return;
    const p = svgPoint(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (tool === 'dim' || tool === 'calibrate') {
      draftRef.current = { p1: p, p2: p };
      setDraft(draftRef.current);
      return;
    }
    if (tool === 'note') {
      pushUndo();
      const off = activePage.image_w * 0.06;
      const note: DimAnnotation = {
        id: makeId(), kind: 'note', p1: p,
        p2: { x: p.x + off, y: Math.max(0, p.y - off * 0.7) },
        offset: 0, label: 'Note',
      };
      updatePage(activePage.id, pg => ({ ...pg, dims: [...pg.dims, note] }));
      setSelId(note.id);
      setTool('select');
      return;
    }
    // select tool
    const hit = hitTest(p);
    if (hit) {
      setSelId(hit.id);
      pushUndo();
      dragRef.current = { dimId: hit.id, part: hit.part, start: p, moved: false };
    } else {
      setSelId(null);
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!activePage) return;
    const p = svgPoint(e);
    if (!p) return;

    if (draftRef.current) {
      const p1 = draftRef.current.p1;
      const snapped = e.altKey ? { x: p.x, y: p.y } : snapToAxis(p1.x, p1.y, p.x, p.y);
      draftRef.current = { p1, p2: snapped };
      setDraft(draftRef.current);
      return;
    }

    const drag = dragRef.current;
    if (!drag) return;
    // Dead zone: a jittery tap (touchscreens emit a move during most taps)
    // must not nudge a placed point.
    if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < Math.max(3, activePage.image_w / 400)) {
      return;
    }
    drag.moved = true;
    updatePage(activePage.id, pg => ({
      ...pg,
      dims: pg.dims.map(d => {
        if (d.id !== drag.dimId) return d;
        if (drag.part === 'offset' && d.kind === 'dim') {
          const dx = d.p2.x - d.p1.x;
          const dy = d.p2.y - d.p1.y;
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len;
          const ny = dx / len;
          return { ...d, offset: (p.x - d.p1.x) * nx + (p.y - d.p1.y) * ny };
        }
        if (drag.part === 'p1') {
          const np = d.kind === 'dim' && !e.altKey ? snapToAxis(d.p2.x, d.p2.y, p.x, p.y) : p;
          return { ...d, p1: np };
        }
        const np = d.kind === 'dim' && !e.altKey ? snapToAxis(d.p1.x, d.p1.y, p.x, p.y) : p;
        return { ...d, p2: np };
      }),
    }));
  };

  const onPointerUp = async () => {
    if (!activePage) return;
    const d = draftRef.current;
    if (d) {
      draftRef.current = null;
      setDraft(null);
      const lenPx = distancePx(d.p1.x, d.p1.y, d.p2.x, d.p2.y);
      if (lenPx < Math.max(6, activePage.image_w / 200)) return; // stray tap
      if (tool === 'calibrate') {
        const answer = await dialog.prompt(
          'Real-world length of the traced line, in inches (e.g. a 148" wheelbase, a 63" body line):',
          '',
          { title: 'Calibrate page', placeholder: 'inches' },
        );
        const inches = parseFloat(answer || '');
        if (!answer || !Number.isFinite(inches) || inches <= 0) return;
        pushUndo();
        updatePage(activePage.id, pg => ({ ...pg, px_per_in: lenPx / inches }));
        setTool('select');
        return;
      }
      pushUndo();
      const dim: DimAnnotation = {
        id: makeId(), kind: 'dim', p1: d.p1, p2: d.p2,
        offset: -Math.max(24, activePage.image_h * 0.05),
      };
      updatePage(activePage.id, pg => ({ ...pg, dims: [...pg.dims, dim] }));
      setSelId(dim.id);
      return;
    }
    // If a select-click never dragged, the pre-pushed undo snapshot is a
    // no-op duplicate — drop it so Cmd+Z stays meaningful.
    if (dragRef.current && !dragRef.current.moved) undoRef.current.pop();
    dragRef.current = null;
  };

  // ---- Page management ----
  const addImagePage = async (file: File) => {
    if (!guide) return;
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
      const path = `install-guides/${guide.id}/${Date.now()}-${makeId()}.${ext}`;
      const { error } = await storage.from(BUCKET).upload(path, file, { contentType: file.type || 'image/png' });
      if (error) throw new Error(error.message);
      const page: GuidePage = {
        id: makeId(),
        name: file.name.replace(/\.[^.]+$/, '') || `Page ${guide.pages.length + 1}`,
        image_path: path,
        image_w: img.naturalWidth,
        image_h: img.naturalHeight,
        px_per_in: null,
        dims: [],
      };
      mutate(g => ({ ...g, pages: [...g.pages, page] }));
      setActivePageId(page.id);
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const openPdfPicker = async (file: File) => {
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    pdfDocRef.current = pdf;
    pdfFileRef.current = file;
    const thumbs: { idx: number; dataUrl: string }[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 170 / vp0.width });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext('2d')!;
      await page.render({ canvasContext: ctx, viewport: vp, canvas } as any).promise;
      thumbs.push({ idx: i, dataUrl: canvas.toDataURL('image/jpeg', 0.7) });
    }
    setPdfImport({ fileName: file.name, thumbs, selected: new Set(pdf.numPages === 1 ? [1] : []) });
  };

  const importPdfPages = async () => {
    if (!guide || !pdfImport || !pdfDocRef.current) return;
    const pdf = pdfDocRef.current;
    const sourceFile = pdfFileRef.current;
    const indices = [...pdfImport.selected].sort((a, b) => a - b);
    setPdfImport(null);
    // Keep the original deck so the dimensioned-proof export can rebuild it
    // with these pages replaced in place. The path is deterministic per
    // guide + file name (upsert), so importing more pages from the same
    // deck later references the same stored copy and they merge back into
    // position. Import still works if this upload fails — only that export
    // is off the table for these pages.
    let sourcePath: string | null = null;
    if (sourceFile) {
      setUploading(`Storing ${sourceFile.name}…`);
      const safeName = sourceFile.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80);
      const path = `install-guides/${guide.id}/source-${safeName}`;
      const { error } = await storage.from(BUCKET).upload(path, sourceFile, { contentType: 'application/pdf', upsert: true });
      if (!error) sourcePath = path;
    }
    const pxPerIn = (72 * PDF_RENDER_SCALE) / parseGuideScale(guide.scale);
    for (const idx of indices) {
      setUploading(`Importing page ${idx} of ${pdfImport.fileName}…`);
      try {
        const page = await pdf.getPage(idx);
        const vp = page.getViewport({ scale: PDF_RENDER_SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvasContext: ctx, viewport: vp, canvas } as any).promise;
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) continue;
        const path = `install-guides/${guide.id}/${Date.now()}-${makeId()}.png`;
        const { error } = await storage.from(BUCKET).upload(path, blob, { contentType: 'image/png' });
        if (error) throw new Error(error.message);
        const newPage: GuidePage = {
          id: makeId(),
          name: `${pdfImport.fileName.replace(/\.pdf$/i, '')} p${idx}`,
          image_path: path,
          image_w: canvas.width,
          image_h: canvas.height,
          px_per_in: pxPerIn,
          dims: [],
          source_pdf_path: sourcePath,
          source_page: sourcePath ? idx : null,
        };
        mutate(g => ({ ...g, pages: [...g.pages, newPage] }));
        setActivePageId(newPage.id);
      } catch (err: any) {
        await dialog.alert(`Page ${idx}: ${err?.message || 'import failed'}`, { title: 'Import failed' });
      }
    }
    setUploading(null);
    pdfDocRef.current = null;
    pdfFileRef.current = null;
  };

  const onFilesChosen = async (files: FileList | null) => {
    if (!files || !guide) return;
    const list = Array.from(files);
    const pdfs = list.filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    for (const file of list) {
      if (pdfs.includes(file)) continue;
      try {
        if (file.type.startsWith('image/')) {
          setUploading(`Uploading ${file.name}…`);
          await addImagePage(file);
        } else {
          await dialog.alert(`${file.name}: upload an image (PNG/JPEG) or a PDF.`, { title: 'Unsupported file' });
        }
      } catch (err: any) {
        await dialog.alert(`${file.name}: ${err?.message || 'upload failed'}`, { title: 'Upload failed' });
      }
    }
    // The page picker holds one PDF at a time — import the first now, then
    // add the next one after this import finishes.
    if (pdfs.length > 0) {
      try {
        setUploading(`Reading ${pdfs[0].name}…`);
        await openPdfPicker(pdfs[0]);
        if (pdfs.length > 1) {
          await dialog.alert('One PDF at a time — add the next PDF after importing this one.', { title: 'Heads up' });
        }
      } catch (err: any) {
        await dialog.alert(`${pdfs[0].name}: ${err?.message || 'failed to read PDF'}`, { title: 'Import failed' });
      }
    }
    setUploading(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removePage = async (page: GuidePage) => {
    const ok = await dialog.confirm(
      `Remove "${page.name}" and its ${page.dims.length} annotation${page.dims.length === 1 ? '' : 's'}?`,
      { destructive: true, confirmLabel: 'Remove page' },
    );
    if (!ok) return;
    pushUndo();
    mutate(g => ({ ...g, pages: g.pages.filter(p => p.id !== page.id) }));
    storage.from(BUCKET).remove([page.image_path]).catch(() => {});
    setActivePageId(prev => (prev === page.id ? null : prev));
    setSelId(null);
  };

  const movePage = (page: GuidePage, dir: -1 | 1) => {
    pushUndo();
    mutate(g => {
      const i = g.pages.findIndex(p => p.id === page.id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= g.pages.length) return g;
      const pages = [...g.pages];
      [pages[i], pages[j]] = [pages[j], pages[i]];
      return { ...g, pages };
    });
  };

  const calibrateFromDpi = async () => {
    if (!activePage || !guide) return;
    const answer = await dialog.prompt(
      `Print resolution of this page in DPI (the raster's dots per template inch). At template scale ${guide.scale}, px/in = DPI ÷ ${parseGuideScale(guide.scale)}.`,
      '150',
      { title: 'Calibrate from DPI', placeholder: 'e.g. 150' },
    );
    const dpi = parseFloat(answer || '');
    if (!answer || !Number.isFinite(dpi) || dpi <= 0) return;
    pushUndo();
    updatePage(activePage.id, pg => ({ ...pg, px_per_in: pxPerRealInchFromDpi(dpi, parseGuideScale(guide.scale)) }));
  };

  // ---- Export ----
  // Shared checks + generation for downloads, CNI-job attach, and email.
  const confirmUncalibrated = async (): Promise<boolean> => {
    if (!guide) return false;
    const uncalibrated = guide.pages.filter(p => !p.px_per_in && p.dims.some(d => d.kind === 'dim'));
    if (uncalibrated.length === 0) return true;
    return dialog.confirm(
      `${uncalibrated.map(p => `"${p.name}"`).join(', ')} ${uncalibrated.length === 1 ? 'has' : 'have'} dimension lines but no calibration — those labels will export as "—". Export anyway?`,
      { confirmLabel: 'Export anyway' },
    );
  };

  const renderAllPages = async (): Promise<RenderedGuidePage[]> => {
    if (!guide) return [];
    const rendered: RenderedGuidePage[] = [];
    for (const page of guide.pages) {
      const r = await renderGuidePage(page, imgUrl(page.image_path), guide.units, guide.fraction_denominator);
      if (!r) throw new Error(`Couldn't render "${page.name}" — the page image failed to load.`);
      rendered.push({ page, dataUrl: r.dataUrl, w: r.w, h: r.h });
    }
    return rendered;
  };

  /**
   * Build one of the two deliverables as raw PDF bytes: 'proof' rebuilds
   * the original proof deck with the dimensioned pages in place; 'guide'
   * is the standalone BMG guide deck. Throws with a user-readable message.
   */
  const generatePdfBytes = async (kind: 'proof' | 'guide'): Promise<{ bytes: ArrayBuffer; fileName: string }> => {
    if (!guide) throw new Error('Guide not loaded.');
    if (guide.pages.length === 0) throw new Error('Add at least one template page first.');
    const rendered = await renderAllPages();
    if (kind === 'proof') {
      const sourcePath = baseSourcePath(guide.pages);
      if (!sourcePath) throw new Error('No pages were imported from a proof PDF.');
      const res = await fetch(imgUrl(sourcePath));
      if (!res.ok) throw new Error(`Couldn't load the stored proof PDF (${res.status}).`);
      const sourceBytes = await res.arrayBuffer();
      const bytes = await buildDimensionedProofPdf(guide, rendered, sourceBytes, sourcePath, proofMode);
      // Copy into a plain ArrayBuffer so Blob/File constructors take it as-is.
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      return { bytes: buf, fileName: dimensionedProofFileName(guide) };
    }
    const doc = buildInstallGuidePdf(guide, rendered, letterhead);
    return { bytes: doc.output('arraybuffer'), fileName: installGuideFileName(guide) };
  };

  const downloadBytes = (bytes: ArrayBuffer, fileName: string) => {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const exportPdf = async () => {
    if (!guide) return;
    if (guide.pages.length === 0) {
      await dialog.alert('Add at least one template page before exporting.', { title: 'Nothing to export' });
      return;
    }
    if (!(await confirmUncalibrated())) return;
    setExporting(true);
    try {
      const { bytes, fileName } = await generatePdfBytes('guide');
      downloadBytes(bytes, fileName);
    } catch (err: any) {
      await dialog.alert(err?.message || 'Export failed.', { title: 'Export failed' });
    }
    setExporting(false);
  };

  // Rebuild the ORIGINAL proof deck with the dimensioned pages swapped in
  // (or inserted after) the pages they were imported from.
  const exportProofPdf = async () => {
    if (!guide || !baseSourcePath(guide.pages)) return;
    if (!(await confirmUncalibrated())) return;
    setExportingProof(true);
    try {
      const { bytes, fileName } = await generatePdfBytes('proof');
      downloadBytes(bytes, fileName);
    } catch (err: any) {
      await dialog.alert(err?.message || 'Export failed.', { title: 'Export failed' });
    }
    setExportingProof(false);
  };

  // ---- Send to installers ----
  // Attach the generated PDF to a CNI job so it lands in the installer's
  // Job Files (same rails as JobAttachments), or stage it to storage and
  // email it through the standard compose screen.
  const startAttachToJob = async () => {
    if (!guide || !(await confirmUncalibrated())) return;
    setSendBusy('Building PDF…');
    try {
      const { bytes, fileName } = await generatePdfBytes(sendKind);
      attachFileRef.current = new File([bytes], fileName, { type: 'application/pdf' });
      setSendBusy('Loading CNI jobs…');
      const { data, error } = await supabase
        .from('cni_jobs')
        .select('id, job_number, title, customer_name, status, created_at')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      setJobPicker({ jobs: (data || []) as CniJobLite[], search: '' });
    } catch (err: any) {
      await dialog.alert(err?.message || 'Failed to prepare the PDF.', { title: 'Attach failed' });
    }
    setSendBusy(null);
  };

  const attachToJob = async (job: CniJobLite) => {
    const file = attachFileRef.current;
    if (!file) return;
    setJobPicker(null);
    setSendBusy(`Attaching to ${job.job_number}…`);
    try {
      const { uploaded, errors } = await uploadJobFiles(job.id, [file]);
      if (errors.length > 0 || uploaded.length === 0) {
        throw new Error(errors.join('; ') || 'Upload failed.');
      }
      const { data: cur, error: readErr } = await supabase
        .from('cni_jobs')
        .select('attachments')
        .eq('id', job.id)
        .single();
      if (readErr) throw new Error(readErr.message);
      const existing: JobFile[] = Array.isArray(cur?.attachments) ? cur.attachments : [];
      const { error: updErr } = await supabase
        .from('cni_jobs')
        .update({ attachments: [...existing, ...uploaded] })
        .eq('id', job.id);
      if (updErr) throw new Error(updErr.message);
      setSendOpen(false);
      attachFileRef.current = null;
      await dialog.alert(
        `"${file.name}" is attached to ${job.job_number} — the installer sees it under the job's files.`,
        { title: 'Attached' },
      );
    } catch (err: any) {
      await dialog.alert(err?.message || 'Attach failed.', { title: 'Attach failed' });
    }
    setSendBusy(null);
  };

  const startEmail = async () => {
    if (!guide || !(await confirmUncalibrated())) return;
    setSendBusy('Building PDF…');
    try {
      const { bytes, fileName } = await generatePdfBytes(sendKind);
      // Stage the export to storage; the send route pulls it from there so
      // the email request itself stays small.
      const safe = fileName.replace(/[^\w.\- ]+/g, '_');
      const path = `install-guides/${guide.id}/exports/${Date.now()}-${safe}`;
      const { error } = await storage
        .from(BUCKET)
        .upload(path, new Blob([bytes], { type: 'application/pdf' }), { contentType: 'application/pdf' });
      if (error) throw new Error(error.message);
      setEmailAttachment({ path, name: fileName, sizeBytes: bytes.byteLength });
      setSendOpen(false);
    } catch (err: any) {
      await dialog.alert(err?.message || 'Failed to prepare the PDF.', { title: 'Email failed' });
    }
    setSendBusy(null);
  };

  const postSend = async (fields: EmailComposeFields, preview: boolean) => {
    if (!guide || !emailAttachment) return { error: 'No attachment staged.' };
    if (!fields.attachmentIds.includes(emailAttachment.path)) {
      return { error: 'Keep the guide PDF attached — it is the whole point of this email.' };
    }
    try {
      const res = await apiFetch('/api/install-guides/send', {
        method: 'POST',
        body: JSON.stringify({
          guideId: guide.id,
          emails: fields.emails,
          bccSelf: fields.bccSelf,
          message: fields.message || undefined,
          attachments: [{ path: emailAttachment.path, name: emailAttachment.name }],
          preview,
        }),
      });
      const body = await res.json();
      if (!res.ok) return { error: body.error || `Request failed (${res.status})` };
      return body;
    } catch (err: any) {
      return { error: err?.message || 'Network error' };
    }
  };

  // ---- Render ----
  if (authLoading || (hasAccess && loading)) {
    return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;
  }
  if (!hasAccess) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
        You don&apos;t have access to Install Guides.
      </div>
    );
  }
  if (loadError || !guide) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--error)', fontSize: '13px', whiteSpace: 'pre-wrap' }}>
        {loadError || 'Guide not found.'}
      </div>
    );
  }

  const selected = activePage?.dims.find(d => d.id === selId) || null;
  const fontSize = activePage ? Math.max(12, activePage.image_w / 60) : 14;
  const handleR = activePage ? Math.max(6, activePage.image_w / 140) : 7;

  const toolBtn = (t: Tool, label: string, title: string) => (
    <button
      key={t}
      onClick={() => { setTool(t); setDraft(null); draftRef.current = null; }}
      title={title}
      style={{
        ...btnStyle(tool === t ? '#fff' : 'var(--text-secondary)', tool === t ? theme.orange : 'var(--subtle-bg)'),
        border: tool === t ? 'none' : '1px solid var(--border)',
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <button
            onClick={() => router.push('/graphics/install-guides')}
            style={btnStyle('var(--text-secondary)', 'var(--subtle-bg)')}
          >
            ← Guides
          </button>
          <div style={{ fontSize: '20px', fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {guide.title || 'Untitled guide'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '11px', color: saveState === 'error' ? 'var(--error)' : 'var(--text-muted)' }}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'dirty' ? 'Unsaved changes' : saveState === 'error' ? 'Save failed' : ''}
          </span>
          {baseSourcePath(guide.pages) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <select
                value={proofMode}
                onChange={e => setProofMode(e.target.value as ProofMode)}
                title="How the dimensioned pages go back into the original proof PDF"
                style={{ ...inputStyle, width: 'auto', padding: '7px 8px' }}
              >
                <option value="replace">Replace original proof pages</option>
                <option value="insert">Insert after original pages</option>
              </select>
              <button
                onClick={exportProofPdf}
                disabled={exportingProof}
                title="Rebuild the uploaded proof PDF with the dimensioned pages in the proof section"
                style={{
                  padding: '8px 14px', borderRadius: '10px', background: 'var(--navy)', color: '#fff',
                  fontWeight: 800, fontSize: '12px', border: 'none', cursor: 'pointer',
                  opacity: exportingProof ? 0.6 : 1,
                }}
              >
                {exportingProof ? 'Building…' : 'Download Dimensioned Proof PDF'}
              </button>
            </div>
          )}
          <button
            onClick={exportPdf}
            disabled={exporting}
            title="Build the standalone BMG install guide deck (cover, best practices, dimensioned pages, schedule)"
            style={{
              padding: '8px 14px', borderRadius: '10px', background: theme.orange, color: '#fff',
              fontWeight: 800, fontSize: '12px', border: 'none', cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(238,49,32,0.3)', opacity: exporting ? 0.6 : 1,
            }}
          >
            {exporting ? 'Building PDF…' : 'Download Install Guide PDF'}
          </button>
          <button
            onClick={() => {
              setSendKind(baseSourcePath(guide.pages) ? 'proof' : 'guide');
              setSendOpen(true);
            }}
            disabled={guide.pages.length === 0}
            title="Attach the guide to a CNI job or email it to installers"
            style={{
              padding: '8px 14px', borderRadius: '10px', background: '#16a34a', color: '#fff',
              fontWeight: 800, fontSize: '12px', border: 'none', cursor: 'pointer',
              opacity: guide.pages.length === 0 ? 0.5 : 1,
            }}
          >
            Send to Installers…
          </button>
        </div>
      </div>

      {saveState === 'error' && saveError && (
        <div style={{
          background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)',
          borderRadius: '10px', padding: '10px 14px', fontSize: '12px', marginBottom: '12px', whiteSpace: 'pre-wrap',
        }}>
          {saveError}
        </div>
      )}

      {/* Guide meta */}
      <div style={{ ...cardStyle, marginBottom: '12px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' }}>
          <div>
            <div style={labelStyle}>Guide title</div>
            <input
              style={inputStyle}
              value={guide.title}
              placeholder="e.g. Lightspeed Restoration — Transit fleet"
              onChange={e => mutate(g => ({ ...g, title: e.target.value }))}
            />
          </div>
          <div>
            <div style={labelStyle}>Customer</div>
            <input
              style={inputStyle}
              value={guide.customer_name || ''}
              onChange={e => mutate(g => ({ ...g, customer_name: e.target.value || null }))}
            />
          </div>
          <div>
            <div style={labelStyle}>Vehicle (year / make / model)</div>
            <input
              style={inputStyle}
              value={guide.vehicle_desc || ''}
              placeholder="2015 Ford Transit-350 148 WB Hi-Roof"
              onChange={e => mutate(g => ({ ...g, vehicle_desc: e.target.value || null }))}
            />
          </div>
          <div>
            <div style={labelStyle}>Template scale</div>
            <input
              style={inputStyle}
              value={guide.scale}
              onChange={e => mutate(g => ({ ...g, scale: e.target.value }))}
            />
          </div>
          <div>
            <div style={labelStyle}>Units</div>
            <select
              style={inputStyle}
              value={guide.units}
              onChange={e => mutate(g => ({ ...g, units: e.target.value as DimUnits }))}
            >
              <option value="in">Inches (63 1/2&quot;)</option>
              <option value="ft-in">Feet + inches (5&apos; 3 1/2&quot;)</option>
            </select>
          </div>
          <div>
            <div style={labelStyle}>Precision</div>
            <select
              style={inputStyle}
              value={guide.fraction_denominator}
              onChange={e => mutate(g => ({ ...g, fraction_denominator: parseInt(e.target.value, 10) || 8 }))}
            >
              <option value={4}>Nearest 1/4&quot;</option>
              <option value={8}>Nearest 1/8&quot;</option>
              <option value={16}>Nearest 1/16&quot;</option>
            </select>
          </div>
        </div>
      </div>

      {/* Page tabs */}
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' }}>
        {guide.pages.map(p => (
          <button
            key={p.id}
            onClick={() => { setActivePageId(p.id); setSelId(null); }}
            style={{
              ...btnStyle(
                p.id === activePage?.id ? '#fff' : 'var(--text-secondary)',
                p.id === activePage?.id ? 'var(--navy)' : 'var(--subtle-bg)',
              ),
              border: p.id === activePage?.id ? 'none' : '1px solid var(--border)',
            }}
          >
            {p.name || 'Page'} · {p.dims.length}
          </button>
        ))}
        <label style={{ ...btnStyle(theme.orange, 'transparent'), border: `1px dashed ${theme.orange}`, display: 'inline-block' }}>
          + Add page (image or PDF)
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            multiple
            style={{ display: 'none' }}
            onChange={e => onFilesChosen(e.target.files)}
          />
        </label>
        {uploading && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{uploading}</span>}
      </div>

      {activePage ? (
        <div style={{ ...cardStyle, padding: '10px' }}>
          {/* Toolbar */}
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
            {toolBtn('select', 'Select', 'Select / move dimensions')}
            {toolBtn('dim', '+ Dimension', 'Drag from point A to point B; hold Alt for a free angle')}
            {toolBtn('note', '+ Note', 'Click a spot to pin a note with a leader arrow')}
            {toolBtn('calibrate', 'Calibrate', 'Trace a feature of known real length')}
            <button onClick={undo} style={btnStyle('var(--text-secondary)', 'var(--subtle-bg)')} title="Undo (Ctrl/Cmd+Z)">
              Undo
            </button>
            <div style={{ flex: 1 }} />
            <span style={{
              fontSize: '11px', fontWeight: 700, padding: '4px 10px', borderRadius: '999px',
              background: activePage.px_per_in ? 'var(--success-bg)' : 'var(--warning-bg)',
              border: `1px solid ${activePage.px_per_in ? 'var(--success-border)' : 'var(--warning-border)'}`,
              color: activePage.px_per_in ? 'var(--success)' : 'var(--warning)',
            }}>
              {activePage.px_per_in
                ? `Calibrated · ${activePage.px_per_in.toFixed(2)} px/in`
                : 'Not calibrated — dimensions read “—”'}
            </span>
            <button onClick={calibrateFromDpi} style={btnStyle('var(--text-secondary)', 'var(--subtle-bg)')}>
              Set from DPI
            </button>
          </div>

          {/* Canvas */}
          <div style={{ position: 'relative', width: '100%', background: '#fff', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border)' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imgUrl(activePage.image_path)}
              alt={activePage.name}
              style={{ width: '100%', display: 'block', userSelect: 'none', pointerEvents: 'none' }}
              draggable={false}
            />
            <svg
              ref={svgRef}
              viewBox={`0 0 ${activePage.image_w} ${activePage.image_h}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none',
                cursor: tool === 'select' ? 'default' : 'crosshair',
              }}
            >
              {activePage.dims.map(d => {
                const isSel = d.id === selId;
                if (d.kind === 'note') {
                  const text = d.label || d.note || 'Note';
                  const dir = d.p2.x >= d.p1.x ? 1 : -1;
                  return (
                    <g key={d.id}>
                      <line x1={d.p2.x} y1={d.p2.y} x2={d.p1.x} y2={d.p1.y} stroke={NOTE_COLOR} strokeWidth={isSel ? 3 : 2} vectorEffect="non-scaling-stroke" />
                      <circle cx={d.p1.x} cy={d.p1.y} r={handleR / 2} fill={NOTE_COLOR} />
                      <text
                        x={d.p2.x + dir * fontSize * 0.4}
                        y={d.p2.y + fontSize * 0.35}
                        fontSize={fontSize}
                        fontWeight={700}
                        fill={NOTE_COLOR}
                        stroke="#fff"
                        strokeWidth={fontSize / 4}
                        paintOrder="stroke"
                        textAnchor={dir === 1 ? 'start' : 'end'}
                      >
                        {text}
                      </text>
                      {isSel && (
                        <>
                          <circle cx={d.p1.x} cy={d.p1.y} r={handleR} fill="#fff" stroke={NOTE_COLOR} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                          <circle cx={d.p2.x} cy={d.p2.y} r={handleR} fill="#fff" stroke={NOTE_COLOR} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                        </>
                      )}
                    </g>
                  );
                }
                const lay = layoutDimension(d.p1, d.p2, d.offset, {
                  gap: handleR / 2, overshoot: handleR, arrowLength: fontSize * 0.8, arrowWidth: fontSize * 0.55,
                });
                const text = dimLabelText(d, activePage.px_per_in, guide.units, guide.fraction_denominator);
                return (
                  <g key={d.id}>
                    {[lay.extA, lay.extB, lay.dim].map((seg, i) => (
                      <line
                        key={i}
                        x1={seg[0].x} y1={seg[0].y} x2={seg[1].x} y2={seg[1].y}
                        stroke={DIM_COLOR} strokeWidth={isSel ? 3 : 2} vectorEffect="non-scaling-stroke"
                      />
                    ))}
                    {[lay.arrowA, lay.arrowB].map((tri, i) => (
                      <polygon key={i} points={tri.map(pt => `${pt.x},${pt.y}`).join(' ')} fill={DIM_COLOR} />
                    ))}
                    <text
                      x={lay.label.x}
                      y={lay.label.y}
                      transform={`rotate(${lay.angleDeg} ${lay.label.x} ${lay.label.y})`}
                      dy={-fontSize * 0.5}
                      fontSize={fontSize}
                      fontWeight={700}
                      fill={DIM_COLOR}
                      stroke="#fff"
                      strokeWidth={fontSize / 4}
                      paintOrder="stroke"
                      textAnchor="middle"
                    >
                      {text}
                    </text>
                    {isSel && (
                      <>
                        <circle cx={d.p1.x} cy={d.p1.y} r={handleR} fill="#fff" stroke={DIM_COLOR} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                        <circle cx={d.p2.x} cy={d.p2.y} r={handleR} fill="#fff" stroke={DIM_COLOR} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                      </>
                    )}
                  </g>
                );
              })}
              {draft && (
                <g>
                  <line
                    x1={draft.p1.x} y1={draft.p1.y} x2={draft.p2.x} y2={draft.p2.y}
                    stroke={tool === 'calibrate' ? '#0891b2' : DIM_COLOR} strokeWidth={2}
                    strokeDasharray="6 4" vectorEffect="non-scaling-stroke"
                  />
                  {activePage.px_per_in && tool !== 'calibrate' && (
                    <text
                      x={(draft.p1.x + draft.p2.x) / 2}
                      y={(draft.p1.y + draft.p2.y) / 2 - fontSize * 0.5}
                      fontSize={fontSize} fontWeight={700} fill={DIM_COLOR}
                      stroke="#fff" strokeWidth={fontSize / 4} paintOrder="stroke" textAnchor="middle"
                    >
                      {formatDimension(
                        realInchesFromPx(distancePx(draft.p1.x, draft.p1.y, draft.p2.x, draft.p2.y), activePage.px_per_in),
                        guide.units,
                        guide.fraction_denominator,
                      )}
                    </text>
                  )}
                </g>
              )}
            </svg>
          </div>

          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px' }}>
            Dimension tool: drag point-to-point (snaps square — hold Alt for a free angle). Select tool: drag the
            dimension line to move it off the artwork, drag its endpoints to fine-tune, Delete removes it. Labels are
            actual vehicle inches.
          </div>

          {/* Selected annotation + page settings */}
          <div style={{ display: 'flex', gap: '10px', marginTop: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ minWidth: '160px', flex: 1 }}>
              <div style={labelStyle}>Page name</div>
              <input
                style={inputStyle}
                value={activePage.name}
                onChange={e => updatePage(activePage.id, p => ({ ...p, name: e.target.value }))}
              />
            </div>
            {selected && (
              <>
                <div style={{ minWidth: '180px', flex: 1 }}>
                  <div style={labelStyle}>{selected.kind === 'dim' ? 'Dimension label (optional)' : 'Note text'}</div>
                  <input
                    style={inputStyle}
                    value={selected.label || ''}
                    placeholder={selected.kind === 'dim' ? 'e.g. Logo to door seam' : 'Note text'}
                    onChange={e =>
                      updatePage(activePage.id, p => ({
                        ...p,
                        dims: p.dims.map(d => (d.id === selected.id ? { ...d, label: e.target.value } : d)),
                      }))
                    }
                  />
                </div>
                <div style={{ minWidth: '180px', flex: 1 }}>
                  <div style={labelStyle}>Schedule note (optional)</div>
                  <input
                    style={inputStyle}
                    value={selected.note || ''}
                    placeholder="Shows in the dimension schedule"
                    onChange={e =>
                      updatePage(activePage.id, p => ({
                        ...p,
                        dims: p.dims.map(d => (d.id === selected.id ? { ...d, note: e.target.value } : d)),
                      }))
                    }
                  />
                </div>
                <button
                  onClick={() => {
                    pushUndo();
                    updatePage(activePage.id, p => ({ ...p, dims: p.dims.filter(d => d.id !== selected.id) }));
                    setSelId(null);
                  }}
                  style={btnStyle('var(--error)', 'transparent')}
                >
                  Delete {selected.kind === 'dim' ? 'dimension' : 'note'}
                </button>
              </>
            )}
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={() => movePage(activePage, -1)} style={btnStyle('var(--text-secondary)', 'var(--subtle-bg)')} title="Move page earlier">←</button>
              <button onClick={() => movePage(activePage, 1)} style={btnStyle('var(--text-secondary)', 'var(--subtle-bg)')} title="Move page later">→</button>
              <button onClick={() => removePage(activePage)} style={btnStyle('var(--error)', 'transparent')}>
                Remove page
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ ...cardStyle, textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', padding: '40px 20px' }}>
          Upload your 1:20 scale template with the graphics placed on it — a PNG/JPEG export or the proof PDF itself
          (you&apos;ll pick which pages to import, and PDF pages calibrate automatically).
        </div>
      )}

      {/* Sections */}
      <div style={{ ...cardStyle, marginTop: '12px' }}>
        <button
          onClick={() => setShowSections(s => !s)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 0, width: '100%',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            color: 'var(--text-primary)', fontSize: '14px', fontWeight: 800,
          }}
        >
          <span>Guide text — best practices, expectations & FleetSuite scanning</span>
          <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
            {guide.sections.filter(s => s.include).length} of {guide.sections.length} included {showSections ? '▲' : '▼'}
          </span>
        </button>
        {showSections && (
          <div style={{ display: 'grid', gap: '12px', marginTop: '12px' }}>
            {guide.sections.map(s => (
              <div key={s.id} style={{ borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' }}>
                  <input
                    type="checkbox"
                    checked={s.include}
                    onChange={e =>
                      mutate(g => ({
                        ...g,
                        sections: g.sections.map(x => (x.id === s.id ? { ...x, include: e.target.checked } : x)),
                      }))
                    }
                  />
                  <input
                    style={{ ...inputStyle, fontWeight: 700 }}
                    value={s.title}
                    onChange={e =>
                      mutate(g => ({
                        ...g,
                        sections: g.sections.map(x => (x.id === s.id ? { ...x, title: e.target.value } : x)),
                      }))
                    }
                  />
                  <button
                    onClick={() => mutate(g => ({ ...g, sections: g.sections.filter(x => x.id !== s.id) }))}
                    style={btnStyle('var(--error)', 'transparent')}
                  >
                    Remove
                  </button>
                </div>
                <textarea
                  style={{ ...inputStyle, minHeight: '72px', resize: 'vertical', fontFamily: 'inherit' }}
                  value={s.body}
                  onChange={e =>
                    mutate(g => ({
                      ...g,
                      sections: g.sections.map(x => (x.id === s.id ? { ...x, body: e.target.value } : x)),
                    }))
                  }
                />
              </div>
            ))}
            <button
              onClick={() =>
                mutate(g => ({
                  ...g,
                  sections: [...g.sections, { id: makeId(), title: 'New section', body: '', include: true }],
                }))
              }
              style={{ ...btnStyle(theme.orange, 'transparent'), border: `1px dashed ${theme.orange}`, justifySelf: 'start' }}
            >
              + Add section
            </button>
          </div>
        )}
      </div>

      {/* Send-to-installers modal: pick the deliverable, then a destination */}
      {sendOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
          }}
          onClick={() => { if (!sendBusy) setSendOpen(false); }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--card)', borderRadius: '14px', border: '1px solid var(--border)',
              padding: '16px', maxWidth: '480px', width: '100%',
            }}
          >
            <div style={{ fontWeight: 800, fontSize: '15px', marginBottom: '10px' }}>Send to installers</div>
            <div style={labelStyle}>Which PDF</div>
            <div style={{ display: 'grid', gap: '6px', marginBottom: '14px' }}>
              {baseSourcePath(guide.pages) && (
                <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', cursor: 'pointer' }}>
                  <input type="radio" checked={sendKind === 'proof'} onChange={() => setSendKind('proof')} />
                  <span>
                    <b>Dimensioned proof PDF</b> — the original proof deck with the dimensioned pages{' '}
                    {proofMode === 'replace' ? 'replacing the originals' : 'inserted after the originals'}
                  </span>
                </label>
              )}
              <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', cursor: 'pointer' }}>
                <input type="radio" checked={sendKind === 'guide'} onChange={() => setSendKind('guide')} />
                <span><b>BMG install guide deck</b> — cover, best practices, dimensioned pages, dimension schedule</span>
              </label>
            </div>
            {sendBusy ? (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>{sendBusy}</div>
            ) : (
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button onClick={() => setSendOpen(false)} style={btnStyle('var(--text-secondary)', 'var(--subtle-bg)')}>
                  Cancel
                </button>
                {isAdmin && (
                  <button onClick={startAttachToJob} style={{ ...btnStyle('#fff', 'var(--navy)'), border: 'none' }}>
                    Attach to CNI job…
                  </button>
                )}
                <button onClick={startEmail} style={{ ...btnStyle('#fff', '#16a34a'), border: 'none' }}>
                  Email…
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* CNI job picker for the attach flow */}
      {jobPicker && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 210,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
          }}
          onClick={() => setJobPicker(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--card)', borderRadius: '14px', border: '1px solid var(--border)',
              padding: '16px', maxWidth: '560px', width: '100%', maxHeight: 'calc(80vh / var(--ts))',
              display: 'flex', flexDirection: 'column', gap: '10px',
            }}
          >
            <div style={{ fontWeight: 800, fontSize: '15px' }}>Attach to which CNI job?</div>
            <input
              style={inputStyle}
              placeholder="Search by job #, title, or customer…"
              value={jobPicker.search}
              onChange={e => setJobPicker(prev => (prev ? { ...prev, search: e.target.value } : prev))}
              autoFocus
            />
            <div style={{ overflowY: 'auto', display: 'grid', gap: '6px' }}>
              {jobPicker.jobs
                .filter(j => {
                  const q = jobPicker.search.trim().toLowerCase();
                  if (!q) return true;
                  return [j.job_number, j.title, j.customer_name || ''].some(s => s.toLowerCase().includes(q));
                })
                .slice(0, 40)
                .map(j => (
                  <button
                    key={j.id}
                    onClick={() => attachToJob(j)}
                    style={{
                      textAlign: 'left', padding: '10px 12px', borderRadius: '10px', cursor: 'pointer',
                      background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)',
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: '13px' }}>
                      {j.job_number} — {j.title}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {[j.customer_name, j.status.replace(/_/g, ' ')].filter(Boolean).join(' · ')}
                    </div>
                  </button>
                ))}
              {jobPicker.jobs.length === 0 && (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '10px 0' }}>
                  No CNI jobs found.
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setJobPicker(null)} style={btnStyle('var(--text-secondary)', 'var(--subtle-bg)')}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Standard compose screen (docs/customer-email-standard.md) */}
      {emailAttachment && (
        <EmailComposeModal
          title="Email Install Guide"
          initialTo=""
          attachments={[{ id: emailAttachment.path, name: emailAttachment.name, sizeBytes: emailAttachment.sizeBytes }]}
          initialAttachmentIds={[emailAttachment.path]}
          messagePlaceholder="Optional note to the installer…"
          sendLabel="Send Guide"
          fetchPreview={async fields => {
            const res = await postSend(fields, true);
            if (res.error) return { error: res.error };
            return { preview: { to: (res.to || []).join(', ') || null, subject: res.subject, html: res.html } };
          }}
          onSend={async fields => {
            const res = await postSend(fields, false);
            if (res.error) {
              await dialog.alert(res.error, { title: 'Send failed' });
              return { ok: false };
            }
            await dialog.alert('Install guide sent.', { title: 'Sent' });
            return { ok: true };
          }}
          onClose={() => setEmailAttachment(null)}
        />
      )}

      {/* PDF page picker modal */}
      {pdfImport && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
          }}
          onClick={() => { setPdfImport(null); pdfDocRef.current = null; pdfFileRef.current = null; }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--card)', borderRadius: '14px', border: '1px solid var(--border)',
              padding: '16px', maxWidth: '720px', width: '100%', maxHeight: 'calc(85vh / var(--ts))', overflowY: 'auto',
            }}
          >
            <div style={{ fontWeight: 800, fontSize: '15px', marginBottom: '4px' }}>
              Import pages from {pdfImport.fileName}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
              Pick the template pages you want to dimension (skip cover/disclaimer pages). Imported pages calibrate
              automatically at template scale {guide.scale}.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px' }}>
              {pdfImport.thumbs.map(t => {
                const on = pdfImport.selected.has(t.idx);
                return (
                  <button
                    key={t.idx}
                    onClick={() =>
                      setPdfImport(prev => {
                        if (!prev) return prev;
                        const selectedPages = new Set(prev.selected);
                        if (selectedPages.has(t.idx)) selectedPages.delete(t.idx);
                        else selectedPages.add(t.idx);
                        return { ...prev, selected: selectedPages };
                      })
                    }
                    style={{
                      border: on ? `2px solid ${theme.orange}` : '1px solid var(--border)',
                      borderRadius: '8px', padding: '4px', background: on ? 'var(--orange-soft)' : 'var(--subtle-bg)',
                      cursor: 'pointer',
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={t.dataUrl} alt={`Page ${t.idx}`} style={{ width: '100%', borderRadius: '4px', display: 'block' }} />
                    <div style={{ fontSize: '11px', fontWeight: 700, marginTop: '4px', color: on ? theme.orange : 'var(--text-secondary)' }}>
                      Page {t.idx} {on ? '✓' : ''}
                    </div>
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
              <button onClick={() => { setPdfImport(null); pdfDocRef.current = null; pdfFileRef.current = null; }} style={btnStyle('var(--text-secondary)', 'var(--subtle-bg)')}>
                Cancel
              </button>
              <button
                onClick={importPdfPages}
                disabled={pdfImport.selected.size === 0}
                style={{
                  ...btnStyle('#fff', theme.orange), border: 'none',
                  opacity: pdfImport.selected.size === 0 ? 0.5 : 1,
                }}
              >
                Import {pdfImport.selected.size || ''} page{pdfImport.selected.size === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
