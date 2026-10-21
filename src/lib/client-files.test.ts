import { describe, it, expect } from 'vitest';
import {
  extOf, kindOf, isCopyable, MAX_COPY_BYTES, locateUnderRoot, clientFolderPathLower,
  matchWords, folderNameVariants, prepareCustomers, matchFolder, nameSimilarity,
  copyKeyFor, thumbKeyFor, formatBytes, opensInGraphicsBuilder, MAX_BUILDER_BYTES,
} from './client-files';

describe('file kinds', () => {
  it('reads the extension', () => {
    expect(extOf('Home Depot Partition Stickers_PRINT.eps')).toBe('eps');
    expect(extOf('IMG_2304.JPG')).toBe('jpg');
    expect(extOf('README')).toBe('');
    expect(extOf('.DS_Store')).toBe('');
    expect(extOf('trailing.')).toBe('');
  });

  it('sorts files into the page chips', () => {
    expect(kindOf('Sign_Work Order.pdf')).toBe('pdf');
    expect(kindOf('install.jpeg')).toBe('photo');
    expect(kindOf('van.HEIC')).toBe('photo');
    expect(kindOf('Masterack_Numbers.ai')).toBe('print');
    expect(kindOf('USDOT.eps')).toBe('print');
    expect(kindOf('notes.docx')).toBe('other');
  });

  it('copies only PDFs and photos within the size cap', () => {
    expect(isCopyable('pdf', 840_000)).toBe(true);
    expect(isCopyable('photo', MAX_COPY_BYTES)).toBe(true);
    expect(isCopyable('photo', MAX_COPY_BYTES + 1)).toBe(false);
    expect(isCopyable('print', 1000)).toBe(false);
    expect(isCopyable('other', 1000)).toBe(false);
    expect(isCopyable('pdf', 0)).toBe(false);
  });

  it('keys copies by Dropbox id so a new revision overwrites the old', () => {
    expect(copyKeyFor('id:wyXkMIqtH1kAAAAAAAYH2Q', 'pdf')).toBe('wyXkMIqtH1kAAAAAAAYH2Q/file.pdf');
    expect(copyKeyFor('id:abc', '')).toBe('abc/file');
    expect(thumbKeyFor('id:abc')).toBe('abc/thumb.png');
  });

  it('formats sizes', () => {
    expect(formatBytes(6_810_894)).toBe('6.5 MB');
    expect(formatBytes(634_272)).toBe('619 KB');
    expect(formatBytes(570_415_202_967)).toBe('531.2 GB');
  });
});

describe('locateUnderRoot', () => {
  const root = '/OFFICE/Clients';
  it('finds the client folder and the path below the root', () => {
    expect(locateUnderRoot('/OFFICE/Clients/Home Depot/Unit Numbers/Masterack_Numbers.ai', root)).toEqual({
      relPath: 'Home Depot/Unit Numbers/Masterack_Numbers.ai', clientFolder: 'Home Depot',
    });
  });
  it('ignores case in the root, as Dropbox does', () => {
    expect(locateUnderRoot('/office/clients/Greenway/x.pdf', root)?.clientFolder).toBe('Greenway');
  });
  it('treats a file loose in the root as having no client folder', () => {
    expect(locateUnderRoot('/OFFICE/Clients/NY Unit Addressses.eps', root)).toEqual({ relPath: 'NY Unit Addressses.eps', clientFolder: null });
  });
  it('rejects paths outside the root and the root itself', () => {
    expect(locateUnderRoot('/OFFICE/ClientsOld/x.pdf', root)).toBeNull();
    expect(locateUnderRoot('/OFFICE/Clients', root)).toBeNull();
    expect(locateUnderRoot('/OFFICE/PRINT/x.pdf', root)).toBeNull();
  });
  it('builds the folder path', () => {
    expect(clientFolderPathLower('/OFFICE/Clients/', 'Home Depot')).toBe('/office/clients/home depot');
  });
});

describe('matchWords', () => {
  it('drops punctuation, The and business suffixes', () => {
    expect(matchWords('The Home Depot, Inc.')).toEqual(['home', 'depot']);
    expect(matchWords('Fischer MEchanical')).toEqual(['fischer', 'mechanical']);
    expect(matchWords('Spencer Towing L.L.C.')).toEqual(['spencer', 'towing']);
    expect(matchWords("O'Fallon Senior Center")).toEqual(['ofallon', 'senior', 'center']);
  });
  it('reads St as Saint and & as and', () => {
    expect(matchWords('St. Charles Plumbing & Electric')).toEqual(['saint', 'charles', 'plumbing', 'and', 'electric']);
  });
  it('keeps a lone initial', () => {
    expect(matchWords('C Bennett')).toEqual(['c', 'bennett']);
  });
  it('splits off a note after a dash', () => {
    expect(folderNameVariants('State Farm - Evan')).toEqual(['State Farm - Evan', 'State Farm']);
    expect(folderNameVariants('Home Depot')).toEqual(['Home Depot']);
  });
});

describe('matchFolder', () => {
  const customers = prepareCustomers([
    { id: 'hd', name: 'The Home Depot', active: true },
    { id: 'ht', name: 'Home Team Pest Defense', active: true },
    { id: 'hteam', name: 'HomeTeam', active: true },
    { id: 'fm', name: 'Fischer Mechanical, Inc.', active: true },
    { id: 'st', name: 'Spencer Towing & Recovery LLC', active: true },
    { id: 'sf1', name: 'State Farm - Evan Smith Agency', active: true },
    { id: 'orkin1', name: 'Orkin - St Louis', active: true },
    { id: 'orkin2', name: 'Orkin - Kansas City', active: true },
    { id: 'old', name: 'Greenway Lawn', active: false },
    { id: 'new', name: 'Greenway Lawn', active: true },
    { id: 'dup1', name: 'Carmedic', active: true },
    { id: 'dup2', name: 'Carmedic LLC', active: true },
    { id: 'cts', name: 'CTS Group', active: true },
  ]);

  it('links an exact name on its own', () => {
    expect(matchFolder('Home Depot', customers)).toMatchObject({ status: 'auto', customerId: 'hd', score: 1 });
    expect(matchFolder('Fischer MEchanical', customers)).toMatchObject({ status: 'auto', customerId: 'fm' });
    expect(matchFolder('HomeTeam', customers)).toMatchObject({ status: 'auto', customerId: 'hteam' });
  });

  it('prefers the active customer when two share a name', () => {
    expect(matchFolder('Greenway Lawn', customers)).toMatchObject({ status: 'auto', customerId: 'new' });
  });

  it('asks a person when two active customers have the same name', () => {
    const m = matchFolder('Carmedic', customers);
    expect(m.status).toBe('suggested');
    expect(m.candidates.map(c => c.customer_id).sort()).toEqual(['dup1', 'dup2']);
  });

  it('offers a longer customer name as a suggestion, not a link', () => {
    const m = matchFolder('Spencer Towing', customers);
    expect(m.status).toBe('suggested');
    expect(m.candidates[0].customer_id).toBe('st');
    expect(m.candidates[0].score).toBeGreaterThanOrEqual(0.8);
  });

  it('uses the part before a dash', () => {
    const m = matchFolder('State Farm - Evan', customers);
    expect(m.status).toBe('suggested');
    expect(m.candidates[0].customer_id).toBe('sf1');
  });

  it('lists every close branch rather than guessing', () => {
    const m = matchFolder('Orkin', customers);
    expect(m.status).toBe('suggested');
    expect(m.candidates.map(c => c.customer_id).sort()).toEqual(['orkin1', 'orkin2']);
  });

  it('does not call a short code inside a longer name a match', () => {
    expect(nameSimilarity(['cts'], { words: ['cts', 'group'], compact: 'ctsgroup' })).toBeLessThan(0.75);
  });

  it('leaves unknown folders unmatched', () => {
    expect(matchFolder('Lindenwood 2022 Hole Sponsor Signs', customers)).toMatchObject({ status: 'unmatched', customerId: null, candidates: [] });
  });
});

describe('opensInGraphicsBuilder', () => {
  it('takes PDFs, pictures and Illustrator files the browser can draw', () => {
    for (const ext of ['pdf', 'PDF', 'ai', 'jpg', 'png', 'heic']) expect(opensInGraphicsBuilder({ ext, size: 1000 })).toBe(true);
  });
  it('leaves out EPS and other print files, and files too big for a phone', () => {
    for (const ext of ['eps', 'tif', 'psd', 'zip', '']) expect(opensInGraphicsBuilder({ ext, size: 1000 })).toBe(false);
    expect(opensInGraphicsBuilder({ ext: 'pdf', size: MAX_BUILDER_BYTES + 1 })).toBe(false);
  });
});
