import crypto from 'crypto';
import { phoneDigits } from './dialpad';

/**
 * Retell AI phone agent primitives — the after-hours answering service.
 *
 * Retell answers the main line when the office is closed (Vonage forwards
 * the after-hours route to a Retell number), takes a message, and POSTs the
 * finished call to /api/webhooks/retell. Everything here is pure and
 * tested; the route just calls it.
 *
 * Webhook signing (retell-sdk lib/webhook_auth): header
 * `x-retell-signature: v=<ms timestamp>,d=<hex>` where the digest is
 * HMAC-SHA256(rawBody + timestamp) keyed with the Retell API key. Same
 * posture as the Dialpad route: a missing key REJECTS, never fails open.
 */

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export function verifyRetellSignature(
  rawBody: string,
  signature: string | null | undefined,
  apiKey: string | undefined,
  nowMs = Date.now(),
): boolean {
  if (!apiKey || !signature) return false;
  const match = /^v=(\d+),d=([0-9a-f]{64})$/i.exec(signature.trim());
  if (!match) return false;
  const stamp = Number(match[1]);
  if (!Number.isSafeInteger(stamp) || Math.abs(nowMs - stamp) > FIVE_MINUTES_MS) return false;
  const expected = crypto.createHmac('sha256', apiKey).update(rawBody + match[1]).digest();
  const given = Buffer.from(match[2], 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** The post-call fields set up in the agent (Retell → Post-Call Analysis). */
export interface RetellCall {
  callId: string;
  direction: 'inbound' | 'outbound';
  fromNumber: string | null;
  toNumber: string | null;
  externalDigits: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  callerName: string | null;
  callerCompany: string | null;
  callerEmail: string | null;
  callbackNumber: string | null;
  reason: string | null;
  reference: string | null;
  urgent: boolean;
  summary: string | null;
  transcript: string | null;
  recordingUrl: string | null;
}

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && !/^(n\/?a|none|unknown|null)$/i.test(s) ? s : null;
};

const truthy = (v: unknown): boolean =>
  v === true || /^(true|yes|y|1)$/i.test(String(v ?? '').trim());

const iso = (ms: unknown): string | null => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};

/**
 * Normalize a Retell webhook body ({ event, call }) into the fields we
 * store and email. Returns null when there is no call id to key on.
 */
export function parseRetellCall(body: Record<string, any>): RetellCall | null {
  const call = body?.call;
  const callId = str(call?.call_id);
  if (!callId) return null;
  const analysis = call.call_analysis || {};
  const custom = (analysis.custom_analysis_data && typeof analysis.custom_analysis_data === 'object')
    ? analysis.custom_analysis_data as Record<string, unknown>
    : {};
  const fromNumber = str(call.from_number);
  const durationMs = Number(call.duration_ms);
  const started = iso(call.start_timestamp);
  const ended = iso(call.end_timestamp);
  const durationSeconds = Number.isFinite(durationMs) && durationMs > 0
    ? Math.round(durationMs / 1000)
    : started && ended ? Math.round((Date.parse(ended) - Date.parse(started)) / 1000) : null;
  return {
    callId,
    direction: call.direction === 'outbound' ? 'outbound' : 'inbound',
    fromNumber,
    toNumber: str(call.to_number),
    externalDigits: phoneDigits(call.direction === 'outbound' ? call.to_number : fromNumber),
    startedAt: started,
    endedAt: ended,
    durationSeconds,
    callerName: str(custom.caller_name),
    callerCompany: str(custom.company),
    callerEmail: str(custom.email),
    callbackNumber: str(custom.callback_number) || fromNumber,
    reason: str(custom.reason),
    reference: str(custom.reference),
    urgent: truthy(custom.urgent),
    summary: str(analysis.call_summary),
    transcript: str(call.transcript),
    recordingUrl: str(call.recording_url),
  };
}

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** (636) 555-0142 for a 10-digit US number, else as given. */
export function prettyPhone(phone: string | null | undefined): string {
  const d = phoneDigits(phone);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(phone || '');
}

function centralTime(isoTs: string | null): string | null {
  if (!isoTs) return null;
  return new Date(isoTs).toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function duration(seconds: number | null): string | null {
  if (!seconds || seconds < 1) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m} min ${s} sec` : `${s} sec`;
}

const REASON_LABELS: Record<string, string> = {
  quote: 'Quote request', status: 'Job or estimate status', billing: 'Billing', other: 'Other',
};

export function reasonLabel(reason: string | null): string {
  if (!reason) return 'Message';
  return REASON_LABELS[reason.toLowerCase()] || reason.charAt(0).toUpperCase() + reason.slice(1);
}

export function afterHoursCallSubject(call: RetellCall): string {
  const who = [call.callerName, call.callerCompany].filter(Boolean).join(', ')
    || prettyPhone(call.callbackNumber) || 'Unknown caller';
  return `${call.urgent ? 'URGENT · ' : ''}After-hours call: ${who} · ${reasonLabel(call.reason)}`;
}

/**
 * The summary email for one after-hours call: who called, what they want, a
 * one-tap call back, the record in FleetSuite, the recording, and the full
 * transcript. Light, plain layout so it reads (and forwards) well on a
 * phone.
 */
export function buildAfterHoursCallEmail(call: RetellCall, recordUrl: string, recipientNames: string[] = []): string {
  const rows: Array<[string, string]> = [];
  const add = (label: string, html: string | null) => { if (html) rows.push([label, html]); };
  const callback = call.callbackNumber;
  add('Caller', call.callerName ? esc(call.callerName) : null);
  add('Company', call.callerCompany ? esc(call.callerCompany) : null);
  add('Call back', callback
    ? `<a href="tel:${esc(callback.replace(/[^\d+]/g, ''))}" style="color:#1d4ed8;text-decoration:none;font-weight:700;">${esc(prettyPhone(callback))}</a>`
    : null);
  add('Email', call.callerEmail
    ? `<a href="mailto:${esc(call.callerEmail)}" style="color:#1d4ed8;text-decoration:none;">${esc(call.callerEmail)}</a>`
    : null);
  add('Reason', esc(reasonLabel(call.reason)));
  add('SO / VIN', call.reference ? esc(call.reference) : null);
  add('Called', esc(centralTime(call.startedAt) || '') || null);
  add('Length', duration(call.durationSeconds));
  if (call.fromNumber && phoneDigits(call.fromNumber) !== phoneDigits(callback)) {
    add('Caller ID', esc(prettyPhone(call.fromNumber)));
  }

  const rowsHtml = rows.map(([label, value]) => `
          <tr>
            <td style="padding:7px 12px 7px 0;font-size:13px;color:#64748b;white-space:nowrap;vertical-align:top;">${label}</td>
            <td style="padding:7px 0;font-size:14px;color:#0f172a;">${value}</td>
          </tr>`).join('');

  const transcriptHtml = call.transcript
    ? call.transcript.split(/\r?\n/).filter(l => l.trim()).map(line => {
      const m = /^(Agent|User)\s*:\s*(.*)$/i.exec(line.trim());
      if (!m) return `<div style="margin:0 0 8px;">${esc(line.trim())}</div>`;
      const isAgent = m[1].toLowerCase() === 'agent';
      return `<div style="margin:0 0 8px;"><span style="font-weight:700;color:${isAgent ? '#64748b' : '#0f172a'};">${isAgent ? 'Assistant' : 'Caller'}:</span> ${esc(m[2])}</div>`;
    }).join('')
    : '';

  const button = (href: string, label: string, primary: boolean) =>
    `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:11px 18px;border-radius:8px;font-size:14px;font-weight:700;text-decoration:none;${primary ? 'background:#1d4ed8;color:#ffffff;' : 'background:#ffffff;color:#1d4ed8;border:1px solid #cbd5e1;'}">${label}</a>`;
  const buttons = [
    callback ? button(`tel:${callback.replace(/[^\d+]/g, '')}`, 'Call back', true) : '',
    button(recordUrl, 'Open in FleetSuite', !callback),
    call.recordingUrl ? button(call.recordingUrl, 'Listen to the call', false) : '',
  ].join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px 12px;">
    <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="padding:16px 20px;border-bottom:3px solid #ee3120;">
        <div style="font-size:12px;font-weight:800;color:#ee3120;letter-spacing:1.5px;text-transform:uppercase;">BMG Fleet · After-hours call</div>
      </div>
      <div style="padding:20px;">${call.urgent ? `
        <div style="margin:0 0 14px;padding:10px 12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:14px;font-weight:700;color:#b91c1c;">Caller says this is urgent.</div>` : ''}
        <div style="font-size:18px;font-weight:800;color:#0f172a;margin:0 0 8px;">${esc(reasonLabel(call.reason))}${call.callerName ? ` from ${esc(call.callerName)}` : ''}</div>
        <div style="font-size:15px;color:#334155;line-height:1.55;margin:0 0 16px;">${call.summary ? esc(call.summary) : 'The assistant did not write a summary for this call. The transcript is below.'}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 18px;">${rowsHtml}
        </table>
        <div>${buttons}</div>
        <div style="margin-top:8px;font-size:13px;color:#64748b;">Jessie makes the callback the next business morning.</div>${transcriptHtml ? `
        <div style="margin-top:22px;font-size:13px;font-weight:800;color:#0f172a;text-transform:uppercase;letter-spacing:1px;">Transcript</div>
        <div style="margin-top:8px;padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;color:#334155;line-height:1.5;">${transcriptHtml}</div>` : ''}
      </div>
      <div style="padding:14px 20px;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;text-align:center;">
        Answered by BMG's virtual assistant while the office was closed.${recipientNames.length ? `<br>Sent to ${esc(recipientNames.join(', '))}.` : ''}
      </div>
    </div>
  </div>
</body>
</html>`;
}
