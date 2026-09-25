import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireAuth, requireAdmin, isAdminRole, getProfileRoles } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { GRAPHICS_ACTIVE_STATUSES } from '@/lib/graphics-status';
import {
  GRAPHICS_STATUS_LABELS, VEHICLE_STATUS_LABELS, IN_SHOP_STATUSES,
  type GraphicsJobStatus, type VehicleTrackingStatus,
} from '@/lib/types';
import { deepLinks } from '@/lib/deep-links';
import {
  orderPersonalList, compareGraphicsDefault, compareVehicleDefault, sanitizeOrder,
  type WorkListType, type WorkListItem,
} from '@/lib/personal-work-list';

export const dynamic = 'force-dynamic';

/**
 * /api/work-lists — per-person priority lists ("My List", migration 326).
 *
 * GET  ?type=graphics|vehicle              → the caller's own list
 * GET  ?type=…&userId=<id>                 → someone else's list (admin)
 * GET  ?type=…&people=1                    → who has jobs on this board, with counts (admin)
 * POST { type, userId, order: string[] }   → a manager saves that person's order (admin)
 *
 * A list is every job assigned to the person (job_assignments plus the job's
 * own assigned_to mirror) that can still be worked: graphics jobs on the
 * Active tab, vehicles on the ground and not archived. Only the order is
 * stored; see src/lib/personal-work-list.ts for how the two combine.
 */

const TypeEnum = z.enum(['graphics', 'vehicle']);

const GetSchema = z.object({
  type: TypeEnum,
  userId: z.string().uuid().optional(),
  people: z.string().optional(),
});

const PostSchema = z.object({
  type: TypeEnum,
  userId: z.string().uuid(),
  /** The person's COMPLETE list, top first. Jobs left out fall back to the default order. */
  order: z.array(z.string().uuid()).max(500),
});

const ASSIGNMENT_JOB_TYPE: Record<WorkListType, string> = {
  graphics: 'graphics_job',
  vehicle: 'scanned_vehicle',
};

type Db = SupabaseClient;

function service(): Db {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

interface GraphicsRow {
  id: string; title: string | null; job_number: string | null; customer: string | null;
  status: GraphicsJobStatus; due_date: string | null; created_at: string | null;
  work_rank: number | null; assigned_to: string | null;
}

interface VehicleRow {
  id: string; vin: string; vehicle_year: string | null; vehicle_make: string | null; vehicle_model: string | null;
  customer_name: string | null; sales_order_number: string | null; status: string;
  promised_back_date: string | null; created_at: string | null; assigned_to: string | null;
}

type ActiveRow = { kind: 'graphics'; row: GraphicsRow } | { kind: 'vehicle'; row: VehicleRow };

/** Every job on the board that can still be worked, keyed by id. */
async function loadActiveJobs(db: Db, type: WorkListType, includeFlagged: boolean): Promise<Map<string, ActiveRow>> {
  const out = new Map<string, ActiveRow>();
  if (type === 'graphics') {
    const statuses = GRAPHICS_ACTIVE_STATUSES.filter(s => includeFlagged || s !== 'flagged');
    const { data, error } = await db.from('graphics_jobs')
      .select('id, title, job_number, customer, status, due_date, created_at, work_rank, assigned_to')
      .in('status', statuses);
    if (error) throw new Error(`Could not read graphics jobs: ${error.message}`);
    for (const row of (data || []) as GraphicsRow[]) out.set(row.id, { kind: 'graphics', row });
  } else {
    const { data, error } = await db.from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, sales_order_number, status, promised_back_date, created_at, assigned_to')
      .in('status', IN_SHOP_STATUSES)
      .is('archived_at', null);
    if (error) throw new Error(`Could not read vehicles: ${error.message}`);
    for (const row of (data || []) as VehicleRow[]) out.set(row.id, { kind: 'vehicle', row });
  }
  return out;
}

/** userId → ids of active jobs assigned to them, from both assignment sources. */
async function loadAssignees(db: Db, type: WorkListType, active: Map<string, ActiveRow>, onlyUser?: string) {
  const byUser = new Map<string, Set<string>>();
  const add = (userId: string | null, jobId: string) => {
    if (!userId || (onlyUser && userId !== onlyUser)) return;
    let set = byUser.get(userId);
    if (!set) byUser.set(userId, set = new Set());
    set.add(jobId);
  };
  for (const [id, a] of active) add(a.row.assigned_to, id);

  const ids = [...active.keys()];
  // Chunked so the id filter stays well inside URL limits on a busy board.
  for (let i = 0; i < ids.length; i += 150) {
    let q = db.from('job_assignments').select('job_id, user_id')
      .eq('job_type', ASSIGNMENT_JOB_TYPE[type])
      .in('job_id', ids.slice(i, i + 150));
    if (onlyUser) q = q.eq('user_id', onlyUser);
    const { data, error } = await q;
    if (error) throw new Error(`Could not read assignments: ${error.message}`);
    for (const r of data || []) add(r.user_id, r.job_id);
  }
  return byUser;
}

function toItem(a: ActiveRow, ranked: boolean): WorkListItem {
  if (a.kind === 'graphics') {
    const j = a.row;
    return {
      id: j.id,
      title: j.title || 'Untitled job',
      subtitle: [j.job_number, j.customer].filter(Boolean).join(' · '),
      statusLabel: GRAPHICS_STATUS_LABELS[j.status] || j.status,
      due: j.due_date ? j.due_date.slice(0, 10) : null,
      href: deepLinks.graphicsJob(j.id),
      ranked,
    };
  }
  const v = a.row;
  const title = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ') || 'Vehicle';
  return {
    id: v.id,
    title,
    subtitle: [v.customer_name || v.sales_order_number, v.vin ? `…${v.vin.slice(-6)}` : null].filter(Boolean).join(' · '),
    statusLabel: VEHICLE_STATUS_LABELS[v.status as VehicleTrackingStatus] || (v.status === 'checked_in' ? 'Received' : v.status),
    due: v.promised_back_date ? v.promised_back_date.slice(0, 10) : null,
    href: deepLinks.vehicle(v.id),
    ranked,
  };
}

/** One person's list, in order. */
async function buildList(db: Db, type: WorkListType, userId: string, includeFlagged: boolean) {
  const active = await loadActiveJobs(db, type, includeFlagged);
  const mine = (await loadAssignees(db, type, active, userId)).get(userId) || new Set<string>();

  const { data: rankRows, error } = await db.from('personal_work_ranks')
    .select('job_id, rank')
    .eq('user_id', userId)
    .eq('list_type', type);
  if (error) throw new Error(`Could not read the saved order: ${error.message}`);
  const ranks = new Map((rankRows || []).map(r => [r.job_id as string, r.rank as number]));

  const rows = [...mine].map(id => active.get(id)!).filter(Boolean);
  const fallback = (a: ActiveRow, b: ActiveRow) =>
    a.kind === 'graphics' && b.kind === 'graphics' ? compareGraphicsDefault(a.row, b.row)
      : a.kind === 'vehicle' && b.kind === 'vehicle' ? compareVehicleDefault(a.row, b.row) : 0;
  const ordered = orderPersonalList(rows.map(r => ({ id: r.row.id, r })), ranks, (a, b) => fallback(a.r, b.r));
  return ordered.map(o => toItem(o.r, ranks.has(o.id)));
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  const parsed = validateSearchParams(req, GetSchema);
  if (parsed.error) return parsed.error;
  const { type, userId, people } = parsed.data;

  const me = auth.user!.id;
  const admin = isAdminRole(getProfileRoles(auth.profile));
  if ((people || (userId && userId !== me)) && !admin) {
    return NextResponse.json({ error: 'Forbidden: admin required' }, { status: 403 });
  }

  const db = service();
  try {
    if (people) {
      const active = await loadActiveJobs(db, type, true);
      const byUser = await loadAssignees(db, type, active);
      const ids = [...byUser.keys()];
      const { data: profiles } = ids.length
        ? await db.from('profiles').select('id, full_name, email').in('id', ids)
        : { data: [] as { id: string; full_name: string | null; email: string | null }[] };
      const name = new Map((profiles || []).map(p => [p.id, p.full_name || p.email || 'Unknown user']));
      const list = ids
        .map(id => ({ id, name: name.get(id) || 'Unknown user', count: byUser.get(id)!.size }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return NextResponse.json({ people: list });
    }

    // Flagged jobs are admin-only on the board, so they stay off lists a
    // non-admin reads — otherwise the numbering would skip a hidden row.
    const items = await buildList(db, type, userId || me, admin);
    return NextResponse.json({ items });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const { type, userId, order } = parsed.data;

  const db = service();
  try {
    const active = await loadActiveJobs(db, type, true);
    const onList = (await loadAssignees(db, type, active, userId)).get(userId) || new Set<string>();
    const finalOrder = sanitizeOrder(order, onList);
    const now = new Date().toISOString();
    const setBy = auth.user?.id ?? null;

    // Upsert the new block, then drop every other row for this person —
    // jobs they no longer hold and ones the manager left unordered.
    if (finalOrder.length > 0) {
      const { error } = await db.from('personal_work_ranks').upsert(
        finalOrder.map((jobId, i) => ({
          user_id: userId, list_type: type, job_id: jobId, rank: i + 1, set_by: setBy, set_at: now,
        })),
        { onConflict: 'user_id,list_type,job_id' },
      );
      if (error) throw new Error(`Could not save the list: ${error.message}`);
    }
    let del = db.from('personal_work_ranks').delete().eq('user_id', userId).eq('list_type', type);
    if (finalOrder.length > 0) del = del.not('job_id', 'in', `(${finalOrder.join(',')})`);
    const { error: delErr } = await del;
    if (delErr) throw new Error(`Could not save the list: ${delErr.message}`);

    const items = await buildList(db, type, userId, true);
    return NextResponse.json({ ok: true, items });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
