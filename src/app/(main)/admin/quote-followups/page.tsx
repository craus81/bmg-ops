'use client';

/**
 * Legacy URL — the Quote Follow-Ups queue became the Quotes list, which is
 * now the Estimates tab ("Waiting on customer"). Follow-up nudge and
 * reminder notifications STORED before the moves carry
 * /admin/quote-followups?item=… URLs; they still land on the exact row.
 * New producers build URLs via deepLinks.quoteFollowUps.
 */

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { legacyQuotesTarget } from '@/lib/legacy-quotes-url';

export default function LegacyQuoteFollowUpsRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    router.replace(legacyQuotesTarget(searchParams));
  }, [router, searchParams]);
  return null;
}
