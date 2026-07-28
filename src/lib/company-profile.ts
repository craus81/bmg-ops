'use client';

/**
 * The company letterhead (name, address, phone, email, logo) that goes on
 * outgoing documents — statements, quotes. Sourced from the same settings
 * singleton the wrap-quote builder edits, so every document matches.
 *
 * Fetch it when a page loads (not when the user clicks Print/PDF): the
 * document renderers open a window inside the click gesture, and an await
 * there would hand the popup blocker a reason to intervene.
 */

export interface CompanyProfile {
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  email: string | null;
}

export interface CompanyLetterhead {
  company: CompanyProfile;
  /** Inline image for jsPDF / print windows; null when no logo is configured. */
  logoDataUrl: string | null;
  /** Remote URL form, for HTML that can load images over the network. */
  logoUrl: string | null;
}

export async function fetchCompanyLetterhead(): Promise<CompanyLetterhead | null> {
  try {
    const res = await fetch('/api/company-profile');
    const body = await res.json();
    if (!res.ok || !body.success) return null;
    return { company: body.company, logoDataUrl: body.logoDataUrl || null, logoUrl: body.logoUrl || null };
  } catch {
    return null;
  }
}

/** Letterhead address block, one entry per line, empties dropped. */
export function companyLines(c: CompanyProfile | null | undefined): string[] {
  if (!c) return [];
  return [
    c.address,
    [c.city, c.state, c.zip].filter(Boolean).join(', '),
    c.phone,
    c.email,
  ].filter((l): l is string => !!l && l.trim().length > 0);
}
