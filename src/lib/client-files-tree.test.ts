import { describe, it, expect } from 'vitest';
import { buildFolderTree, listFolderLevel, pathInFolder } from './client-files-tree';

const rows = [
  { id: '1', name: 'a.eps', size_bytes: 100, rel_path: 'ATCO/Chevy Express/PRINT/a.eps' },
  { id: '2', name: 'b.eps', size_bytes: '200', rel_path: 'ATCO/Chevy Express/PRINT/Master/b.eps' },
  { id: '3', name: 'p.pdf', size_bytes: 50, rel_path: 'ATCO/Chevy Express/Proofs/p.pdf' },
  { id: '4', name: 'loose.pdf', size_bytes: 5, rel_path: 'ATCO/loose.pdf' },
  { id: '5', name: 'a.eps', size_bytes: 7, rel_path: 'ATCO/New Folder/a.eps' },
];

describe('pathInFolder', () => {
  it('drops the client folder', () => {
    expect(pathInFolder('ATCO/Chevy Express/x.ai')).toBe('Chevy Express/x.ai');
    expect(pathInFolder('loose.pdf')).toBe('loose.pdf');
  });
});

describe('buildFolderTree', () => {
  it('totals the folder and rolls deep files into their level-2 parent', () => {
    const t = buildFolderTree(rows);
    expect(t.total).toEqual({ files: 5, bytes: 362 });
    expect(t.folders.map(n => [n.path, n.depth, n.files, n.bytes])).toEqual([
      ['Chevy Express', 1, 3, 350],
      ['Chevy Express/PRINT', 2, 2, 300],
      ['Chevy Express/Proofs', 2, 1, 50],
      ['New Folder', 1, 1, 7],
    ]);
    expect(t.files.find(f => f.id === '2')?.zipPath).toBe('Chevy Express/PRINT/Master/b.eps');
  });

  it('keeps only files under a sub-folder, with paths relative to it', () => {
    const t = buildFolderTree(rows, 'chevy express/print');
    expect(t.files.map(f => [f.id, f.zipPath])).toEqual([['1', 'a.eps'], ['2', 'Master/b.eps']]);
    expect(t.total).toEqual({ files: 2, bytes: 300 });
  });

  it('does not treat a folder with the same prefix as a sub-folder', () => {
    const t = buildFolderTree([{ id: '9', name: 'x', size_bytes: 1, rel_path: 'ATCO/Chevy Express 2/x' }], 'Chevy Express');
    expect(t.files).toEqual([]);
  });
});

describe('listFolderLevel', () => {
  it('lists the folders and loose files directly in the client folder', () => {
    const l = listFolderLevel(rows);
    expect(l.total).toEqual({ files: 5, bytes: 362 });
    expect(l.folders.map(n => [n.path, n.files, n.bytes, n.folders])).toEqual([
      ['Chevy Express', 3, 350, 2],
      ['New Folder', 1, 7, 0],
    ]);
    expect(l.fileIds).toEqual(['4']);
  });

  it('goes any depth, matching the folder names case-insensitively', () => {
    const l = listFolderLevel(rows, 'chevy express/PRINT');
    expect(l.folders.map(n => [n.path, n.files])).toEqual([['chevy express/PRINT/Master', 1]]);
    expect(l.fileIds).toEqual(['1']);
    expect(listFolderLevel(rows, 'Chevy Express/PRINT/Master').fileIds).toEqual(['2']);
  });

  it('sorts numbers in order and ignores a look-alike sibling', () => {
    const l = listFolderLevel([
      { id: 'a', name: 'x', size_bytes: 1, rel_path: 'C/Unit 10/x' },
      { id: 'b', name: 'x', size_bytes: 1, rel_path: 'C/Unit 9/x' },
      { id: 'c', name: 'x', size_bytes: 1, rel_path: 'C/Unit 9b/x' },
    ], 'Unit 9');
    expect(l.fileIds).toEqual(['b']);
    expect(listFolderLevel([
      { id: 'a', name: 'x', size_bytes: 1, rel_path: 'C/Unit 10/x' },
      { id: 'b', name: 'x', size_bytes: 1, rel_path: 'C/Unit 9/x' },
    ]).folders.map(f => f.name)).toEqual(['Unit 9', 'Unit 10']);
  });
});
