'use client';

/**
 * The letterhead the shop's printed forms (job order, packing slip) draw
 * with, preloaded when the module loads: the forms open a tab inside the
 * click, and an await there invites the popup blocker. Settings → Company
 * first (fetchCompanyLetterhead); until that arrives, or without a logo
 * there, the bundled BMG logo with the company's name.
 */

import { fetchCompanyLetterhead } from './company-profile';
import type { CompanyProfile } from './statement-pdf-doc';

export interface FormLetterhead {
  company: CompanyProfile | null;
  logoDataUrl: string | null;
}

let company: CompanyProfile | null = null;
let settingsLogo: string | null = null;
let bundledLogo: string | null = null;
let loading = false;

function readBundledLogo(): Promise<string | null> {
  return fetch('/bmg-logo-color.png')
    .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.blob(); })
    .then((blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }))
    .catch(() => null);
}

/** Start loading (again, if a load failed). Safe to call on every click. */
export function ensureFormLetterhead(): void {
  if (loading || typeof window === 'undefined' || (company && bundledLogo)) return;
  loading = true;
  Promise.all([
    fetchCompanyLetterhead().then((lh) => {
      if (lh) { company = lh.company; settingsLogo = lh.logoDataUrl; }
    }),
    bundledLogo ? Promise.resolve() : readBundledLogo().then((l) => { bundledLogo = l; }),
  ]).finally(() => { loading = false; });
}

/** What's loaded so far. */
export function formLetterhead(): FormLetterhead {
  return { company, logoDataUrl: settingsLogo || bundledLogo };
}

ensureFormLetterhead();
