'use client';

/**
 * Legacy URL — the Quote Follow-Ups queue is now the "Waiting" filter of
 * the combined /quotes list. This redirect exists because follow-up nudge
 * and reminder notifications STORED before the move carry
 * /admin/quote-followups?item=… URLs; params pass through so those still
 * land on the exact row. New producers build /quotes URLs via
 * deepLinks.quoteFollowUps.
 */

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LegacyQuoteFollowUpsRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const qs = searchParams.toString();
    router.replace(`/quotes${qs ? `?${qs}` : ''}`);
  }, [router, searchParams]);
  return null;
}
