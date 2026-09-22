/**
 * Company details shown on the public /privacy and /terms pages.
 *
 * Intuit's production-key review requires a privacy policy URL and an
 * EULA URL for the QuickBooks Online app (docs/quickbooks-connect.md), so
 * these pages must stay reachable without a login: keep them outside the
 * (main) route group, whose ClientProviders sends signed-out visitors to
 * the login screen.
 */
export const LEGAL = {
  entityName: 'BMG Fleet Installations LLC',
  address: "1082 Cool Springs Industrial Dr., O'Fallon, MO 63366",
  privacyEmail: 'inquiry@bmgfleet.com',
  contactEmail: 'inquiry@bmgfleet.com',
  governingState: 'Missouri',
  venue: 'St. Charles County, Missouri',
  effectiveDate: 'September 22, 2026',
};
