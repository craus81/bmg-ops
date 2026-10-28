// Pure Dropbox path rules, safe to import from the browser.

/** Keep a path part safe for Dropbox (no slashes, no trailing dots or spaces). */
export function dropboxPathPart(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || 'file';
}
