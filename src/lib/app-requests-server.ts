/**
 * Server side of in-app Requests (migration 453): loading a request with
 * its conversation, the alerts, and the token Claude's scheduled check uses.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { notify, type NotifyChannel } from './notify';
export { authenticateRequestsAgent } from './app-requests-agent';
import { deepLinks } from './deep-links';
import { newAlertWatcherIds } from './new-alert-watchers';
import { isInternalStaffRole, getProfileRoles } from './api-auth';
import { fetchAllRows } from './fetch-all';
import {
  REQUESTS_OWNER_EMAIL, KIND_LABEL, STATUS_LABEL, excerpt, pageName, updateRecipients,
  type AppRequestKind, type AppRequestStatus,
} from './app-requests';

export const REQUEST_SELECT = 'id, number, kind, body, status, from_page, device, created_by, needs_claude, submitter_unread, created_at, updated_at';

export interface RequestRow {
  id: string;
  number: number;
  kind: AppRequestKind;
  body: string;
  status: AppRequestStatus;
  from_page: string | null;
  device: string | null;
  created_by: string | null;
  needs_claude: boolean;
  submitter_unread: boolean;
  created_at: string;
  updated_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

/** Craig, and only Craig, closes a request as Won't do. */
export async function isRequestsOwner(service: SupabaseClient, profile: any): Promise<boolean> {
  if (!profile?.id || !getProfileRoles(profile).includes('super_admin')) return false;
  const { data } = await service.from('profiles').select('email').eq('id', profile.id).maybeSingle();
  const owner = REQUESTS_OWNER_EMAIL;
  return (data?.email || '').trim().toLowerCase() === owner;
}

interface Person { id: string; full_name: string | null; email: string | null; staff: boolean; roles: string[] }

async function loadPeople(service: SupabaseClient, ids: (string | null)[]): Promise<Map<string, Person>> {
  const unique = [...new Set(ids.filter(Boolean) as string[])];
  const map = new Map<string, Person>();
  for (let i = 0; i < unique.length; i += 200) {
    const { data } = await service.from('profiles').select('id, full_name, email, role, roles').in('id', unique.slice(i, i + 200));
    for (const p of (data || []) as any[]) {
      map.set(p.id, { id: p.id, full_name: p.full_name, email: p.email, staff: isInternalStaffRole(p), roles: getProfileRoles(p) });
    }
  }
  return map;
}

export interface RequestListItem {
  id: string;
  number: number;
  kind: AppRequestKind;
  body: string;
  status: AppRequestStatus;
  from_page: string | null;
  submitter_name: string | null;
  mine: boolean;
  unread: boolean;
  me_too_count: number;
  i_me_too: boolean;
  created_at: string;
  updated_at: string;
}

/** The Requests list: everything for staff, their own for everyone else. */
export async function listRequests(service: SupabaseClient, viewer: { id: string; staff: boolean }): Promise<RequestListItem[]> {
  const { data, error } = await fetchAllRows<RequestRow>((from, to) => {
    let q = service.from('app_requests').select(REQUEST_SELECT);
    if (!viewer.staff) q = q.eq('created_by', viewer.id);
    return q.order('updated_at', { ascending: false }).order('id').range(from, to) as any;
  });
  if (error) throw new Error(error.message);
  const rows = data || [];
  const ids = rows.map(r => r.id);
  const meToo = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: mt } = await service.from('app_request_me_too').select('request_id, user_id').in('request_id', ids.slice(i, i + 200));
    for (const m of (mt || []) as any[]) meToo.set(m.request_id, [...(meToo.get(m.request_id) || []), m.user_id]);
  }
  const people = await loadPeople(service, rows.map(r => r.created_by));
  return rows.map(r => {
    const backers = meToo.get(r.id) || [];
    const mine = r.created_by === viewer.id;
    return {
      id: r.id, number: r.number, kind: r.kind, body: r.body, status: r.status, from_page: r.from_page,
      submitter_name: r.created_by ? people.get(r.created_by)?.full_name || null : null,
      mine, unread: mine && r.submitter_unread,
      me_too_count: backers.length, i_me_too: backers.includes(viewer.id),
      created_at: r.created_at, updated_at: r.updated_at,
    };
  });
}

export interface RequestDetail {
  request: RequestRow & { submitter_name: string | null; submitter_staff: boolean | null; submitter_email?: string | null; submitter_roles?: string[] };
  messages: Array<{ id: string; author_kind: 'person' | 'claude'; author_id: string | null; author_name: string; body: string; created_at: string }>;
  files: Array<{ id: string; file_name: string | null; content_type: string | null; url: string; created_at: string }>;
  me_too: Array<{ user_id: string; name: string | null }>;
}

/** One request with its conversation, screenshots and Me too list. */
export async function loadRequestDetail(
  service: SupabaseClient,
  id: string,
  opts: { fileUrl: (fileId: string) => string; withContact?: boolean },
): Promise<RequestDetail | null> {
  const { data: request } = await service.from('app_requests').select(REQUEST_SELECT).eq('id', id).maybeSingle();
  if (!request) return null;
  const r = request as RequestRow;
  const [{ data: msgs }, { data: files }, { data: mt }] = await Promise.all([
    service.from('app_request_messages').select('id, author_kind, author_id, body, created_at').eq('request_id', id).order('created_at').order('id'),
    service.from('app_request_files').select('id, file_name, content_type, created_at').eq('request_id', id).order('created_at').order('id'),
    service.from('app_request_me_too').select('user_id, created_at').eq('request_id', id).order('created_at'),
  ]);
  const people = await loadPeople(service, [
    r.created_by, ...((msgs || []) as any[]).map(m => m.author_id), ...((mt || []) as any[]).map(m => m.user_id),
  ]);
  const submitter = r.created_by ? people.get(r.created_by) : undefined;
  return {
    request: {
      ...r,
      submitter_name: submitter?.full_name || null,
      submitter_staff: submitter ? submitter.staff : null,
      ...(opts.withContact ? { submitter_email: submitter?.email || null, submitter_roles: submitter?.roles || [] } : {}),
    },
    messages: ((msgs || []) as any[]).map(m => ({
      id: m.id, author_kind: m.author_kind, author_id: m.author_id, body: m.body, created_at: m.created_at,
      author_name: m.author_kind === 'claude' ? 'Claude' : (m.author_id ? people.get(m.author_id)?.full_name : null) || 'Someone',
    })),
    files: ((files || []) as any[]).map(f => ({ id: f.id, file_name: f.file_name, content_type: f.content_type, created_at: f.created_at, url: opts.fileUrl(f.id) })),
    me_too: ((mt || []) as any[]).map(m => ({ user_id: m.user_id, name: people.get(m.user_id)?.full_name || null })),
  };
}

/** Customer and installer accounts hear in the app only: no email to customers. */
function channelsFor(person: Person | undefined): NotifyChannel[] | undefined {
  return person && !person.staff ? ['in_app', 'push'] : undefined;
}

/** A new request: the watchers (Craig) hear about it on every channel. */
export async function alertNewRequest(service: SupabaseClient, r: RequestRow, submitterName: string | null) {
  try {
    const watchers = (await newAlertWatcherIds(service)).filter(id => id !== r.created_by);
    if (watchers.length === 0) return;
    const who = submitterName || 'Someone';
    const where = pageName(r.from_page);
    const kind = KIND_LABEL[r.kind].toLowerCase();
    await Promise.allSettled(watchers.map(userId => notify({
      userId,
      type: 'app_request_new',
      title: `New ${kind} from ${who}: ${excerpt(r.body, 60)}`,
      body: `${who} sent request #${r.number}${where ? ` from ${where}` : ''}: "${excerpt(r.body, 400)}". Claude picks it up on the next check.`,
      url: deepLinks.appRequest(r.id),
    })));
  } catch (err) {
    console.error('app request new alert failed:', err);
  }
}

/**
 * Someone answered on a request (Claude, Craig, or the person adding more):
 * the submitter, the Me too people and the watchers hear, less whoever wrote.
 */
export async function alertRequestUpdate(service: SupabaseClient, opts: {
  request: RequestRow;
  authorName: string;
  actorId: string | null;
  message: string | null;
  status: AppRequestStatus;
  statusChanged: boolean;
}) {
  try {
    const { request: r } = opts;
    const [{ data: mt }, watchers] = await Promise.all([
      service.from('app_request_me_too').select('user_id').eq('request_id', r.id),
      newAlertWatcherIds(service),
    ]);
    const ids = updateRecipients({
      submitter: r.created_by,
      meToo: ((mt || []) as any[]).map(m => m.user_id),
      watchers,
      actor: opts.actorId,
    });
    if (ids.length === 0) return;
    const people = await loadPeople(service, [...ids, r.created_by]);
    const submitterName = r.created_by ? people.get(r.created_by)?.full_name || 'Someone' : 'Someone';
    const subject = excerpt(r.body, 60);
    const statusLine = opts.statusChanged ? STATUS_LABEL[opts.status] : null;
    const said = opts.message ? `${opts.authorName}: "${excerpt(opts.message, 600)}"` : `${opts.authorName} marked it ${STATUS_LABEL[opts.status]}.`;

    await Promise.allSettled(ids.map(userId => {
      const own = userId === r.created_by;
      const whose = own ? 'your request' : `${submitterName}'s request`;
      const title = statusLine && (opts.status === 'done' || opts.status === 'wont')
        ? `${statusLine}: ${subject}`
        : `${opts.authorName} replied on ${whose}: ${subject}`;
      return notify({
        userId,
        type: 'app_request_update',
        title,
        body: `${said}${statusLine ? ` Status: ${statusLine}.` : ''} Not quite right? Reply under the request and it reopens.`,
        url: deepLinks.appRequest(r.id),
        channels: channelsFor(people.get(userId)),
      });
    }));
  } catch (err) {
    console.error('app request update alert failed:', err);
  }
}
