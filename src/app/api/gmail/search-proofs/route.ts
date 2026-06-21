import { NextRequest, NextResponse } from 'next/server';
import { getGmailClient, getMessage, getProofAttachments, getHeader } from '@/lib/google';
import { requireStaff } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

// Walking the Gmail result set and fetching per-message details is slower than
// Vercel's default ~10s ceiling once an inbox has a real backlog.
export const maxDuration = 60;

// Cap how much of the inbox we scan per search so the route stays well under
// the function timeout even on a large mailbox. Proof searches are keyword-
// driven and narrow, so the most-recent matches are what matter.
const MAX_MESSAGES = 40;

// Search Gmail for proof attachments (PDFs + photo/design files) matching the
// caller's keywords. Returns one row per matching attachment so the picker can
// list them individually. Does NOT download attachment bytes — that happens at
// attach time via /api/parts/[id]/attach-proof.
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!q) return NextResponse.json({ files: [] });

  const daysRaw = parseInt(req.nextUrl.searchParams.get('days') || '365', 10);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 365;

  try {
    const gmail = await getGmailClient();

    // Bound the search by date and require an attachment; the user's keywords
    // (which may include Gmail operators like from:) go in as-is.
    const after = new Date();
    after.setDate(after.getDate() - days);
    const afterStr = `${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;
    const query = `has:attachment (${q}) after:${afterStr}`;

    const list = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: MAX_MESSAGES,
    });
    const messages = list.data.messages || [];

    const files: any[] = [];
    for (const m of messages) {
      const full = await getMessage(m.id!);
      const atts = getProofAttachments(full);
      if (atts.length === 0) continue;

      const subject = getHeader(full, 'Subject') || '(no subject)';
      const from = getHeader(full, 'From');
      const date = getHeader(full, 'Date');

      for (const a of atts) {
        files.push({
          id: `${m.id}:${a.attachmentId}`,
          messageId: m.id,
          attachmentId: a.attachmentId,
          filename: a.filename,
          size: a.size,
          mimeType: a.mimeType,
          subject,
          from,
          date,
        });
      }
    }

    return NextResponse.json({ files, query });
  } catch (err: any) {
    if (err.message === 'NO_GOOGLE_TOKEN') {
      return NextResponse.json({ error: 'Gmail not connected', needsAuth: true }, { status: 401 });
    }
    console.error('search-proofs error:', err);
    return NextResponse.json({ error: err.message || 'Search failed' }, { status: 500 });
  }
}
