'use client';

// The Shop Board merged into the In-Shop page — the arrival schedule and
// calendar now live at the top of /tracking. This stub keeps old links
// working.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function ShopBoardRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/tracking'); }, [router]);
  return null;
}
