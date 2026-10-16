import { describe, it, expect } from 'vitest';
import { zipLimitProblem, zipFileName, MAX_ZIP_BYTES, MAX_ZIP_FILES } from './client-files-zip';

describe('zipLimitProblem', () => {
  it('needs at least one file and stays under the caps', () => {
    expect(zipLimitProblem([])).toMatch(/at least one/);
    expect(zipLimitProblem([{ size: 10 }])).toBeNull();
    expect(zipLimitProblem([{ size: MAX_ZIP_BYTES + 1 }])).toMatch(/MB/);
    expect(zipLimitProblem(Array.from({ length: MAX_ZIP_FILES + 1 }, () => ({ size: 1 })))).toMatch(/files/);
  });
});

describe('zipFileName', () => {
  it('cleans characters a file system refuses', () => {
    expect(zipFileName('ATCO / Chevy: Express')).toMatch(/^ATCO Chevy Express – \d{4}-\d{2}-\d{2}\.zip$/);
    expect(zipFileName('')).toMatch(/^Client files – /);
  });
});
