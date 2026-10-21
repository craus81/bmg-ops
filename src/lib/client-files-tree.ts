/**
 * A client folder's sub-folders, rolled up from its files' paths, for the
 * per-folder zip downloads on Client Files (Craig, 2026-10-16). Pure, so the
 * route and the tests share it.
 */

export interface TreeFile {
  id: string;
  name: string;
  size_bytes: number | string | null;
  /** Path under Clients, client folder first: "ATCO/Chevy Express/PRINT/x.eps". */
  rel_path: string;
}

export interface TreeNode {
  /** Path below the client folder: "Chevy Express/PRINT". */
  path: string;
  name: string;
  depth: number;
  files: number;
  bytes: number;
}

export interface FolderTree {
  /** Every file in the client folder (or under `sub`). */
  total: { files: number; bytes: number };
  /** Sub-folders two levels deep, in path order. */
  folders: TreeNode[];
  /** The files themselves, path inside the client folder kept for the zip. */
  files: { id: string; name: string; size: number; zipPath: string }[];
}

/** Levels of sub-folders shown; deeper files count toward their level-2 parent. */
export const TREE_DEPTH = 2;

/** The file's path below the client folder ("Chevy Express/PRINT/x.eps"). */
export function pathInFolder(relPath: string): string {
  const i = relPath.indexOf('/');
  return i >= 0 ? relPath.slice(i + 1) : relPath;
}

export function buildFolderTree(rows: TreeFile[], sub?: string | null): FolderTree {
  const prefix = (sub || '').replace(/^\/+|\/+$/g, '');
  const prefixLower = prefix.toLowerCase();
  const nodes = new Map<string, TreeNode>();
  const files: FolderTree['files'] = [];
  let totalBytes = 0;

  for (const r of rows) {
    const inner = pathInFolder(r.rel_path || '');
    if (prefix && !inner.toLowerCase().startsWith(prefixLower + '/')) continue;
    const size = Number(r.size_bytes) || 0;
    totalBytes += size;
    files.push({ id: r.id, name: r.name, size, zipPath: prefix ? inner.slice(prefix.length + 1) : inner });

    const segs = inner.split('/').slice(0, -1);
    for (let d = 1; d <= Math.min(TREE_DEPTH, segs.length); d++) {
      const path = segs.slice(0, d).join('/');
      const key = path.toLowerCase();
      let n = nodes.get(key);
      if (!n) { n = { path, name: segs[d - 1], depth: d, files: 0, bytes: 0 }; nodes.set(key, n); }
      n.files++;
      n.bytes += size;
    }
  }

  const folders = [...nodes.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base', numeric: true }));
  return { total: { files: files.length, bytes: totalBytes }, folders, files };
}

/** One folder directly inside the folder being browsed. */
export interface LevelFolder {
  /** Path below the client folder: "Chevy Express/PRINT". */
  path: string;
  name: string;
  /** Every file inside it, at any depth. */
  files: number;
  bytes: number;
  /** Folders directly inside it. */
  folders: number;
}

export interface FolderLevel {
  /** Every file in the folder being browsed, at any depth. */
  total: { files: number; bytes: number };
  /** Folders directly inside it, A to Z (numbers in order). */
  folders: LevelFolder[];
  /** Ids of the files directly inside it (not in a sub-folder). */
  fileIds: string[];
}

/**
 * One level of a client folder, the way Dropbox shows it (Craig, 2026-10-21:
 * "can we use the same file structure that dropbox does? Like subfolders"):
 * the folders directly inside `sub` with what each holds, and the files
 * sitting directly in it. Any depth; `sub` empty = the client folder itself.
 * Folders only show once they hold a file (empty ones aren't indexed).
 */
export function listFolderLevel(rows: TreeFile[], sub?: string | null): FolderLevel {
  const prefix = (sub || '').replace(/^\/+|\/+$/g, '');
  const prefixLower = prefix.toLowerCase();
  const nodes = new Map<string, LevelFolder & { kids: Set<string> }>();
  const fileIds: string[] = [];
  let files = 0;
  let bytes = 0;

  for (const r of rows) {
    const inner = pathInFolder(r.rel_path || '');
    if (prefix && !inner.toLowerCase().startsWith(prefixLower + '/')) continue;
    const rest = prefix ? inner.slice(prefix.length + 1) : inner;
    const size = Number(r.size_bytes) || 0;
    files++;
    bytes += size;
    const segs = rest.split('/');
    if (segs.length === 1) { fileIds.push(r.id); continue; }
    const key = segs[0].toLowerCase();
    let n = nodes.get(key);
    if (!n) {
      n = { path: prefix ? `${prefix}/${segs[0]}` : segs[0], name: segs[0], files: 0, bytes: 0, folders: 0, kids: new Set() };
      nodes.set(key, n);
    }
    n.files++;
    n.bytes += size;
    if (segs.length > 2) n.kids.add(segs[1].toLowerCase());
  }

  const folders = [...nodes.values()]
    .map(({ kids, ...n }) => ({ ...n, folders: kids.size }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  return { total: { files, bytes }, folders, fileIds };
}
