import { callAnthropicWithRetry } from './anthropic';
import { LEGAL } from './legal';

/**
 * Outreach drafts (migration 439): Claude reads a company's website and what
 * the DOT or Google listing said, and writes a short first email in the
 * rep's name. A draft only ever fills the compose screen; the rep reads it,
 * edits it and presses Send (CLAUDE.md, "No customer email sends itself").
 *
 * The website read is deliberately small: the home page plus a contact and
 * an about page, text only, capped. Enough to find an email address and one
 * specific thing worth mentioning, not a crawl.
 */

export const OUTREACH_MODEL = process.env.OUTREACH_MODEL || 'claude-sonnet-5-5';

export interface DraftInput {
  companyName: string;
  kind: 'fleet' | 'trade';
  trade: string | null;
  city: string | null;
  state: string | null;
  miles: number | null;
  fleetSize: number | null;
  facts: Record<string, any>;
  website: string | null;
  knownEmail: string | null;
  repName: string;
}

export interface Draft {
  subject: string;
  body: string;
  reasons: string[];
  contactName: string | null;
  email: string | null;
}

// ── Website read ─────────────────────────────────────────────────────────

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|\[|::)/i;

/** Only ordinary public http(s) sites: no IPs, no private names. */
export function safeSiteUrl(raw: string | null | undefined): URL | null {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase();
    if (!host.includes('.') || PRIVATE_HOST.test(host) || /^\d+(\.\d+){3}$/.test(host)) return null;
    return u;
  } catch {
    return null;
  }
}

export function htmlToPlain(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const JUNK_EMAIL = /(noreply|no-reply|donotreply|example\.|sentry|wixpress|godaddy|squarespace|@2x|\.png|\.jpg|\.gif|\.webp|domain\.com|email\.com|yourname)/i;

/** Email addresses on the page, the company's own domain first. */
export function findEmails(text: string, siteHost: string | null): string[] {
  const found = [...new Set((text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(e => e.toLowerCase()))]
    .filter(e => !JUNK_EMAIL.test(e));
  const base = (siteHost || '').replace(/^www\./, '');
  return found.sort((a, b) => Number(!!base && b.endsWith(`@${base}`)) - Number(!!base && a.endsWith(`@${base}`)));
}

async function fetchPage(url: URL, fetchImpl: typeof fetch): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchImpl(url.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BMG-FleetSuite/1.0)', Accept: 'text/html' },
      signal: ctrl.signal,
      redirect: 'follow',
      cache: 'no-store',
    });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('html')) return '';
    // Redirects can land anywhere; only read what lands somewhere ordinary.
    if (res.url && !safeSiteUrl(res.url)) return '';
    const html = (await res.text()).slice(0, 400_000);
    // mailto: links carry the address even when the visible text doesn't.
    const mailtos = (html.match(/mailto:([^"'?>\s]+)/gi) || []).map(m => m.slice(7)).join(' ');
    return `${htmlToPlain(html)}\n${mailtos}`;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

export interface SiteRead { text: string; emails: string[] }

export async function readWebsite(raw: string | null, fetchImpl: typeof fetch = fetch): Promise<SiteRead> {
  const site = safeSiteUrl(raw);
  if (!site) return { text: '', emails: [] };
  const pages = [site, new URL('/contact', site), new URL('/about', site)];
  const texts = await Promise.all(pages.map(p => fetchPage(p, fetchImpl)));
  const all = texts.join('\n');
  return { text: all.slice(0, 9000), emails: findEmails(all, site.hostname) };
}

// ── The draft ────────────────────────────────────────────────────────────

export function buildPrompt(input: DraftInput, site: SiteRead): string {
  const where = [input.city, input.state].filter(Boolean).join(', ');
  const listing = input.kind === 'fleet'
    ? `Federal DOT carrier record: ${input.fleetSize ?? '?'} power units (trucks/tractors)` +
      `${input.facts?.drivers ? `, ${input.facts.drivers} drivers` : ''}` +
      `${input.facts?.legalName && input.facts.legalName !== input.companyName ? `, legal name ${input.facts.legalName}` : ''}.`
    : `Google business listing: ${input.trade || 'trade contractor'}` +
      `${input.facts?.reviews ? `, ${input.facts.reviews} Google reviews` : ''}.`;
  return `You write first-contact sales emails for ${LEGAL.entityName} ("BMG Fleet"), a fleet upfitter in O'Fallon, Missouri.
BMG installs truck and van shelving and bins, ladder racks, lighting, cameras, hitches and other equipment on work vehicles, and does vehicle lettering, graphics and wraps. Vehicles usually turn in about a day.

Write one short email from ${input.repName} at BMG to this company:
- Company: ${input.companyName}${where ? ` (${where}${input.miles != null ? `, about ${input.miles} miles from the shop` : ''})` : ''}
- ${listing}
${site.text ? `- What their website says (excerpt, may be partial):\n"""\n${site.text}\n"""` : '- No website text was available.'}

Rules:
- 90 to 140 words in the body. Plain, friendly, specific. No hype, no exclamation marks, no buzzwords, no em dashes.
- Mention one or two concrete things about THIS company (fleet size, the work they do, their area) and connect them to something BMG does.
- Never invent facts. Use only what is given above. If unsure, stay general.
- Greet the contact by first name only if the website clearly names the owner or a fleet/office manager; otherwise "Hi there,".
- End by asking for a short call. Two buttons are added under your text automatically ("Pick a time to talk" and "Have ${input.repName.split(' ')[0]} call me"), so say they can pick a time or ask for a call below, or just reply. Do not include a signature, phone number or links.
- Subject: under 60 characters, specific to them, no clickbait.

Reply with ONLY a JSON object:
{"subject": "...", "body": "...", "reasons": ["2-3 short lines on why this company is a fit, each under 70 characters"], "contactName": "name or null"}`;
}

/** Bare JSON, or JSON inside fences or with a sentence around it. */
export function parseDraftJson(text: string): Omit<Draft, 'email'> | null {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const subject = String(j.subject || '').trim().slice(0, 150);
    const body = String(j.body || '').trim().replace(/\r\n/g, '\n');
    if (!subject || body.length < 40) return null;
    const reasons = Array.isArray(j.reasons) ? j.reasons.map((r: any) => String(r).trim()).filter(Boolean).slice(0, 4) : [];
    const contact = j.contactName && String(j.contactName).trim().toLowerCase() !== 'null' ? String(j.contactName).trim().slice(0, 80) : null;
    return { subject, body, reasons, contactName: contact };
  } catch {
    return null;
  }
}

export async function writeDraft(input: DraftInput, fetchImpl: typeof fetch = fetch): Promise<Draft> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Email drafts need the Claude key (ANTHROPIC_API_KEY in Vercel)');
  const site = await readWebsite(input.website, fetchImpl);
  const res = await callAnthropicWithRetry({
    model: OUTREACH_MODEL,
    max_tokens: 1200,
    messages: [{ role: 'user', content: buildPrompt(input, site) }],
  }, apiKey);
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok) throw new Error(`Claude couldn't write this one: ${data?.error?.message || `status ${res.status}`}`);
  const text = (data.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  const parsed = parseDraftJson(text);
  if (!parsed) throw new Error('Claude\'s draft came back in a shape FleetSuite couldn\'t read. Try Rewrite.');
  return { ...parsed, email: input.knownEmail || site.emails[0] || null };
}
