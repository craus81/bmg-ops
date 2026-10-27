'use client';

/**
 * Legacy URL — the Quotes list was folded into the Estimates tab (Craig,
 * 2026-10-27: two pages listed every estimate). Notifications and bookmarks
 * STORED before the move carry /quotes?item=… and /quotes?status=… URLs;
 * this sends them to the same row or filter on /estimates. New producers
 * build URLs via deepLinks.quoteFollowUps.
 */

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { legacyQuotesTarget } from '@/lib/legacy-quotes-url';

export default function LegacyQuotesRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    router.replace(legacyQuotesTarget(searchParams));
  }, [router, searchParams]);
  return null;
}
