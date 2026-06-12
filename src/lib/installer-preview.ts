/**
 * Admin preview of the installer portal: an admin picks a CNI installer and
 * the installer-facing pages scope their data to that person (admin RLS
 * already permits the reads). Client-only, stored in localStorage — it never
 * changes who is authenticated, only which installer's data the pages load,
 * and the components ignore it for non-admin users.
 *
 * Writes performed while previewing (completing VINs, starting shifts) still
 * act as the admin account — the preview is for seeing what installers see
 * and exercising the flows, not impersonation.
 */

export interface InstallerPreview {
  profileId: string;          // profiles.id of the previewed installer
  name: string;               // display name for the banner
  companyId: string | null;   // their cni company (for job/invite scoping)
}

const KEY = 'installer_preview';

export function getInstallerPreview(): InstallerPreview | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p?.profileId ? p : null;
  } catch {
    return null;
  }
}

export function setInstallerPreview(p: InstallerPreview | null) {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {}
}
