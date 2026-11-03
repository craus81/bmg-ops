// For the SQL tests that run the books' migrations in PGlite.
//
// PGlite's clock moves in whole milliseconds: its now() reads 16:34:09.269
// where Postgres's reads 16:34:09.269512. Back to back, two saves a test makes
// can land in the same millisecond and get the same updated_at, which two
// saves from the pages never do. A test that a save "as the page saw it"
// refuses the older one then fails now and then, as the saved reports' did on
// GitHub on 11-02 and 11-03. So the tests that use updated_at as what the page
// saw wait for the clock to move on before each call.

/** Waits until a whole millisecond has gone by, so the next statement's now() is later than the last one's. */
export async function nextMillisecond(): Promise<void> {
  const from = Date.now();
  while (Date.now() <= from + 1) await new Promise((resolve) => setTimeout(resolve, 1));
}
