import { sameOriginStorageUrl } from '@/lib/r2';
import { deepLinks } from '@/lib/deep-links';
import { CLIENT_FILES_R2_PREFIX } from '@/lib/client-files';

/** One Client Files file as the API hands it to pages (ClientFile in ClientFileRow). */
export interface ClientFileItem {
  id: string;
  name: string;
  ext: string;
  kind: string;
  size: number;
  modified: string | null;
  /** Folders between the client folder and the file ("New Folder With Items › PRINT"). */
  folderPath: string;
  client: { folderId: string; name: string } | null;
  customer: { id: string; name: string; link: string | null } | null;
  /** True when FleetSuite holds a current copy (opens instantly); false = fetched from Dropbox. */
  copied: boolean;
  thumbUrl: string | null;
}

/** dropbox_client_files columns toClientFileItem reads. */
export const CLIENT_FILE_ITEM_SELECT =
  'id, name, ext, kind, size_bytes, server_modified, rel_path, r2_path, copied_rev, rev, thumb_path, '
  + 'folder:dropbox_client_folders(id, name, customer:customers(id, company_name, netsuite_id))';

export function toClientFileItem(r: any): ClientFileItem {
  const segs = String(r.rel_path || '').split('/');
  const inFolder = !!r.folder;
  const middle = segs.slice(inFolder ? 1 : 0, -1);
  const cust = r.folder?.customer;
  return {
    id: r.id,
    name: r.name,
    ext: r.ext,
    kind: r.kind,
    size: Number(r.size_bytes) || 0,
    modified: r.server_modified,
    folderPath: middle.join(' › '),
    client: r.folder ? { folderId: r.folder.id, name: r.folder.name } : null,
    customer: cust ? {
      id: cust.id,
      name: cust.company_name,
      link: cust.netsuite_id ? deepLinks.customerByNetsuiteId(cust.netsuite_id) : null,
    } : null,
    copied: !!r.r2_path && !!r.copied_rev && r.copied_rev === r.rev,
    thumbUrl: r.thumb_path ? sameOriginStorageUrl(CLIENT_FILES_R2_PREFIX, r.thumb_path) : null,
  };
}
