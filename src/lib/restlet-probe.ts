import { callRestlet } from '@/lib/netsuite';
import type { RestletProbe } from '@/lib/integration-checkup';

/**
 * Ask one hand-deployed NetSuite RESTlet which version of itself is running.
 *
 * Lifted out of `src/app/api/system-health/connections/route.ts` (where it
 * was a local helper) the moment a SECOND caller needed it: the ledger's
 * NetSuite mirror gates credit-memo PDFs on the PDF RESTlet being current,
 * and a background job cannot import a route module. One implementation, so
 * "is the deployment current?" can never be answered two different ways.
 *
 * GET for financials/PDF, POST for the item RESTlet — the entry points those
 * scripts actually expose.
 */
export async function pingRestlet(key: string, url: string): Promise<RestletProbe> {
  try {
    const result = key === 'item'
      ? await callRestlet(url, 'POST', undefined, { action: 'ping' })
      : await callRestlet(url, 'GET', { action: 'ping' });
    // A deployment older than the ping action still answers 200 — with
    // whatever its real entry point does with an unknown action. No version
    // field is the tell, and classifyRestlet treats it as stale, not OK.
    const version = result && typeof result.version === 'string' ? result.version : null;
    return { reachable: true, version };
  } catch (e: any) {
    return { reachable: false, error: e?.message ? String(e.message).slice(0, 200) : 'request failed' };
  }
}
