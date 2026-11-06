/**
 * FleetSuite AI hands things off to Craig (Craig, 2026-11-06, option C):
 * when someone tells the chat assistant about a problem or an idea, or asks
 * something it can't settle from FleetSuite's data, it files an in-app
 * Request for them (migration 453). The Request's own alert reaches Craig
 * at once (bell, push, email through "Copy me on new alerts"), and the
 * Requests pickup turns it into a project thread.
 *
 * Any role that has the chat can file, installers included (Craig: "yes").
 * The request is always the caller's own, so installers and customers keep
 * seeing only their own requests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { REQUEST_KINDS, excerpt, type AppRequestKind } from './app-requests';
import { REQUEST_SELECT, alertNewRequest, alertRequestUpdate, type RequestRow } from './app-requests-server';
import { notify } from './notify';
import { newAlertWatcherIds } from './new-alert-watchers';

/** Shown on the request row and in Craig's alert. */
export const AI_REQUEST_DEVICE = 'via FleetSuite AI';

/** Actions every chat role may take, even ones blocked from other actions. */
export const ANY_ROLE_ACTIONS = new Set(['file_request', 'add_to_request']);

export interface ChatCaller {
  id: string;
  name: string | null;
  pagePath: string | null;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface FiledRequest { id: string; number: number }

/** How many recent chat turns go onto the request, and how long each may be. */
const TRANSCRIPT_TURNS = 12;
const TRANSCRIPT_TURN_CHARS = 600;

export function chatTranscript(messages: ChatCaller['messages'], name: string | null): string {
  return messages
    .slice(-TRANSCRIPT_TURNS)
    .map(m => `${m.role === 'user' ? (name || 'Them') : 'FleetSuite AI'}: ${excerpt(m.content, TRANSCRIPT_TURN_CHARS)}`)
    .join('\n');
}

/** The request's text: their words first, then what the AI found, then the chat. */
export function requestBody(opts: { summary: string; findings?: string | null; transcript: string }): string {
  const parts = [opts.summary.trim()];
  if (opts.findings && opts.findings.trim()) parts.push(`What FleetSuite AI found:\n${opts.findings.trim()}`);
  if (opts.transcript) parts.push(`Chat:\n${opts.transcript}`);
  return parts.join('\n\n').slice(0, 10000);
}

export function normalizeKind(kind: unknown): AppRequestKind {
  const k = String(kind || '').toLowerCase().trim();
  if (k === 'bug') return 'problem';
  return (REQUEST_KINDS as string[]).includes(k) ? (k as AppRequestKind) : 'question';
}

/** file_request: a new Request in the caller's name. */
export async function fileRequestFromChat(
  service: SupabaseClient,
  caller: ChatCaller,
  params: Record<string, any>,
): Promise<{ success: true; message: string; request: FiledRequest }> {
  const summary = String(params.summary || '').trim();
  if (!summary) throw new Error('summary required: the person\'s problem, idea or question in their own words');
  const kind = normalizeKind(params.kind);
  const body = requestBody({
    summary,
    findings: params.findings ? String(params.findings) : null,
    transcript: chatTranscript(caller.messages, caller.name),
  });

  const { data, error } = await service.from('app_requests').insert({
    kind,
    body,
    from_page: caller.pagePath ? caller.pagePath.slice(0, 300) : null,
    device: AI_REQUEST_DEVICE,
    created_by: caller.id,
  }).select(REQUEST_SELECT).single();
  if (error || !data) throw new Error(`Could not file the request: ${error?.message || 'no row'}`);

  const row = data as RequestRow;
  await alertNewRequest(service, row, `${caller.name || 'Someone'} (${AI_REQUEST_DEVICE})`);
  return {
    success: true,
    message: `Filed request #${row.number} (${kind}) for them and Craig has been alerted. Tell them it went to Craig as request #${row.number} and that replies will show on the request.`,
    request: { id: row.id, number: row.number },
  };
}

/** add_to_request: more detail on a request the caller already sent. */
export async function addToRequestFromChat(
  service: SupabaseClient,
  caller: ChatCaller,
  params: Record<string, any>,
): Promise<{ success: true; message: string; request: FiledRequest }> {
  const number = Number(params.number);
  const text = String(params.body || '').trim();
  if (!Number.isInteger(number) || number <= 0 || !text) throw new Error('number and body required');

  const { data: found } = await service.from('app_requests').select(REQUEST_SELECT)
    .eq('number', number).eq('created_by', caller.id).maybeSingle();
  const request = found as RequestRow | null;
  if (!request) throw new Error(`Request #${number} isn't one this person sent. File a new one instead.`);

  const { error } = await service.from('app_request_messages').insert({
    request_id: request.id, author_kind: 'person', author_id: caller.id, body: text.slice(0, 10000),
  });
  if (error) throw new Error(`Could not add to the request: ${error.message}`);

  const reopened = request.status === 'done' || request.status === 'wont';
  const { data: updated } = await service.from('app_requests').update({
    needs_claude: true,
    updated_at: new Date().toISOString(),
    ...(reopened ? { status: 'new' } : {}),
  }).eq('id', request.id).select(REQUEST_SELECT).single();

  await alertRequestUpdate(service, {
    request: (updated as RequestRow) || request,
    authorName: `${caller.name || 'Someone'} (${AI_REQUEST_DEVICE})`,
    actorId: caller.id,
    message: text,
    status: reopened ? 'new' : request.status,
    statusChanged: reopened,
  });
  return {
    success: true,
    message: `Added to request #${number}; Craig has been alerted.`,
    request: { id: request.id, number: request.number },
  };
}

/**
 * create_notification: a real alert (bell, push, email per the person's own
 * settings) rather than a bare bell row, with everyone on "Copy me on new
 * alerts" copied (Craig's standing rule, 2026-10-28).
 */
export async function notifyFromChat(
  service: SupabaseClient,
  caller: Pick<ChatCaller, 'id' | 'name'>,
  params: { user_id: string; type?: string; title: string; body: string; url: string | null },
): Promise<string[]> {
  const watchers = (await newAlertWatcherIds(service))
    .filter(id => id !== params.user_id && id !== caller.id);
  const type = params.type || 'ai_agent';
  await notify({ userId: params.user_id, type, title: params.title, body: params.body, url: params.url ?? undefined });
  await Promise.allSettled(watchers.map(userId => notify({
    userId,
    type,
    title: `Copy: ${params.title}`,
    body: `FleetSuite AI sent this for ${caller.name || 'someone'}: ${params.body}`,
    url: params.url ?? undefined,
  })));
  return [params.user_id, ...watchers];
}
