import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { uploadSessionAppend, uploadSessionFinish, uploadSessionStart } from '@/lib/dropbox';
import { applyEntries } from '@/lib/client-files-sync';
import { DEFAULT_CLIENT_FILES_ROOT } from '@/lib/client-files';
import { CLIENT_FILE_ITEM_SELECT, toClientFileItem } from '@/lib/client-file-item';
import { MAX_UPLOAD_BYTES, UPLOAD_PIECE_BYTES, uploadTargetPath } from '@/lib/client-files-upload';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/client-files/upload — put a file into a Dropbox client folder
 * (Craig, 2026-10-28; src/lib/client-files-upload.ts). All internal staff,
 * the same people who see Client Files.
 *
 *   ?step=piece[&session=<id>&offset=<n>]   body: the next piece's bytes
 *     → { session }   (no session starts one with this piece)
 *   ?step=finish   { session, size, folderId, sub, name }
 *     → { file }      saved (a taken name gets Dropbox's "(1)") and listed
 *                     in Client Files straight away; the next sync copies it
 *                     into FleetSuite and makes its thumbnail.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const step = req.nextUrl.searchParams.get('step');
  try {
    if (step === 'piece') return await piece(req);
    if (step === 'finish') return await finish(req);
    return NextResponse.json({ error: 'Unknown step' }, { status: 400 });
  } catch (e: any) {
    console.error('[client-files/upload]', e?.message || e);
    return NextResponse.json({ error: e?.message || 'Upload failed' }, { status: 502 });
  }
}

async function piece(req: NextRequest) {
  const session = req.nextUrl.searchParams.get('session') || '';
  const offset = Number(req.nextUrl.searchParams.get('offset') || 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'Bad offset' }, { status: 400 });
  }
  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length > UPLOAD_PIECE_BYTES) return NextResponse.json({ error: 'Piece too big' }, { status: 413 });
  if (!session) {
    if (offset !== 0) return NextResponse.json({ error: 'Start at the beginning' }, { status: 400 });
    return NextResponse.json({ session: await uploadSessionStart(bytes) });
  }
  if (!/^[\w:-]{4,200}$/.test(session)) return NextResponse.json({ error: 'Bad session' }, { status: 400 });
  await uploadSessionAppend(session, offset, bytes);
  return NextResponse.json({ session });
}

const FinishSchema = z.object({
  session: z.string().regex(/^[\w:-]{4,200}$/),
  size: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
  folderId: z.string().uuid(),
  sub: z.string().max(1000).default(''),
  name: z.string().min(1).max(255),
});

async function finish(req: NextRequest) {
  const parsed = await validateBody(req, FinishSchema);
  if (parsed.error) return parsed.error;
  const { session, size, folderId, sub, name } = parsed.data;

  const service = createServiceClient();
  const { data: folder } = await service.from('dropbox_client_folders')
    .select('id, path_lower').eq('id', folderId).is('deleted_at', null).maybeSingle();
  if (!folder) return NextResponse.json({ error: 'That client folder is no longer in Dropbox' }, { status: 404 });
  const path = uploadTargetPath(folder.path_lower, sub, name);
  if (!path) return NextResponse.json({ error: 'Bad folder' }, { status: 400 });

  const entry = await uploadSessionFinish(session, size, path);

  // List it now rather than at the next sync, so it shows when the page reloads.
  const root = (process.env.DROPBOX_CLIENT_FILES_PATH || '').trim() || DEFAULT_CLIENT_FILES_ROOT;
  await applyEntries(service, [entry], {
    root, rootLower: root.replace(/\/+$/, '').toLowerCase(),
    folderByPath: new Map([[folder.path_lower, folder.id]]), runId: null,
  });
  const { data: row } = await service.from('dropbox_client_files')
    .select(CLIENT_FILE_ITEM_SELECT).eq('dropbox_id', (entry as { id: string }).id).maybeSingle();
  return NextResponse.json({ file: row ? toClientFileItem(row) : null, savedAs: entry.name });
}
