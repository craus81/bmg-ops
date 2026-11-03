// How FleetSuite's books work as a dated PDF the CPA can sign (Books part 88,
// src/lib/books/how-it-works-pdf.ts): every section in order with the page it
// starts on, each posting rule and money step, what couldn't be read, the
// CPA's review as it stands, the sign-off box with the rules' fingerprint, and
// the chart of accounts. Made-up data.
import { describe, it, expect } from 'vitest';
import {
  ABOUT_TEXT, BACKUP_TEXT, BOOKS_JOBS, BOOKS_LEVELS, CONTROLS, DATABASE_ACCESS, DATABASE_RULES, IRS_RECORDS, MONEY_STEPS,
  POSTING_RULES, RECORDS_KEPT, REVERSAL_TEXT, WORKED_OUT_RULES, scheduleText, whoText, type HowItWorksView,
} from './how-it-works';
import { PDF_SECTIONS, buildHowItWorksPdf, howItWorksPdf, pdfText } from './how-it-works-pdf';
import { SWITCHES } from './switches';

const AS_OF = '2026-11-03T15:00:00Z';
const FINGERPRINT = 'ab12'.repeat(16);

function sampleView(over: Partial<HowItWorksView> = {}): HowItWorksView {
  return {
    asOf: AS_OF,
    about: ABOUT_TEXT,
    companies: [
      { code: 'BMG', name: 'Made-up Fleet Co', liveFrom: null, closedThrough: '2026-09', yearsClosed: [2025] },
      { code: '1084', name: 'Made-up Holdings', liveFrom: '2027-01-01', closedThrough: null, yearsClosed: [] },
    ],
    rules: POSTING_RULES.map((r) => ({
      ...r,
      use: r.id === 'invoice@1' ? [{ company: 'BMG', entries: 1234, reversed: 3, firstDate: '2025-01-02', lastDate: '2026-10-31' }] : [],
    })),
    unwritten: [],
    workedOut: WORKED_OUT_RULES.map((r) => ({ ...r, switchName: r.switch ? SWITCHES[r.switch].name : null, switchOn: r.switch ? false : null })),
    reversals: REVERSAL_TEXT,
    steps: MONEY_STEPS.map((s) => ({
      key: s.key, area: s.area, step: s.step, where: s.where, who: whoText(s), note: s.note ?? null, approval: s.approval?.text ?? null,
      posts: [...(s.posts ?? [])], switchName: s.switch ? SWITCHES[s.switch].name : null, switchOn: s.switch ? false : null,
      people: ['Pat Owner'],
    })),
    levels: (['owner', 'keep', 'read'] as const).map((level) => ({ level, ...BOOKS_LEVELS[level], people: level === 'owner' ? ['Pat Owner'] : [] })),
    twoStep: {
      on: false,
      people: [
        { name: 'Pat Owner', roles: 'Super Admin', setUp: true },
        { name: 'Kim Books', roles: 'Bookkeeper', setUp: false },
        { name: 'Lee Exec', roles: 'Executive', setUp: null },
      ],
    },
    database: DATABASE_RULES.map((r) => r.text),
    databaseAccess: DATABASE_ACCESS,
    controls: [...CONTROLS],
    switches: [
      { name: SWITCHES.credit_memos.name, what: SWITCHES.credit_memos.what, on: true, changedAt: '2026-11-01T12:00:00Z', later: null },
      { name: SWITCHES.customer_payments.name, what: SWITCHES.customer_payments.what, on: false, changedAt: null, later: SWITCHES.customer_payments.later ?? null },
    ],
    jobs: BOOKS_JOBS.map((j) => ({ name: j.name, what: j.what, when: scheduleText(j.schedule, new Date(AS_OF)) })),
    lastPosting: '2026-11-03T14:48:00Z',
    lastCopy: '2026-11-03T14:26:00Z',
    backups: { text: [...BACKUP_TEXT], lastMade: '2026-11-03T08:14:00Z', lastDrillPassed: '2026-11-03T08:55:00Z', problem: null },
    records: [...RECORDS_KEPT],
    irs: IRS_RECORDS,
    review: { state: 'never', last: null, added: [], gone: [], reworded: false, fingerprint: FINGERPRINT, canMark: true },
    accounts: [
      { number: '10100', name: 'Made-up Operating', type: 'Bank', company: 'Both', active: true, heading: false, control: false },
      { number: '11000', name: 'Accounts Receivable', type: 'Accounts receivable', company: 'Both', active: true, heading: false, control: true },
      { number: '40000', name: 'Upfit Sales', type: 'Income', company: 'BMG', active: true, heading: true, control: false },
      { number: '69999', name: 'Old Expense', type: 'Expense', company: '1084', active: false, heading: false, control: false },
    ],
    problems: [],
    ...over,
  };
}

const text = (view: HowItWorksView) => buildHowItWorksPdf(view).output();

describe('buildHowItWorksPdf', () => {
  it('draws a dated letter PDF with the contents, every section in order with its page, and a numbered footer', () => {
    const doc = buildHowItWorksPdf(sampleView());
    const out = doc.output();
    expect(out.startsWith('%PDF')).toBe(true);
    expect(out).toContain("How FleetSuite's books work");
    expect(out).toContain('As of November 3, 2026, 9:00 AM Central');
    expect(out).toContain('Contents');
    const pages = doc.getNumberOfPages();
    expect(pages).toBeGreaterThan(4);
    expect(out).toContain(`Page 1 of ${pages}`);
    expect(out).toContain(`Page ${pages} of ${pages}`);
    // Each section is in the contents and then heads its own part, in order.
    let at = out.indexOf('Contents');
    for (const [i, title] of PDF_SECTIONS.entries()) {
      const heading = `${i + 1}. ${pdfText(title)}`;
      expect(out.split(heading).length - 1, heading).toBe(2);
      const next = out.indexOf(heading, at + 1);
      expect(next, heading).toBeGreaterThan(at);
      at = next;
    }
  });

  it('numbers each section in the contents with the page it starts on', () => {
    const doc = buildHowItWorksPdf(sampleView());
    // jsPDF keeps each page's drawing as it was written, pages counted from 1.
    const pages = (doc.internal as unknown as { pages: Array<string[] | undefined> }).pages;
    const times = (ops: readonly string[] | undefined, text: string) => (ops ?? []).filter((op) => op.includes(`(${text}) Tj`)).length;
    const first = (pages[1] ?? []).join('\n');
    const numbers: number[] = [];
    for (const [i, title] of PDF_SECTIONS.entries()) {
      const heading = pdfText(`${i + 1}. ${title}`);
      // The contents are on the first page, so a section starting there has its heading on it twice.
      const startsOn = pages.findIndex((ops, p) => p >= 1 && times(ops, heading) >= (p === 1 ? 2 : 1));
      // The contents are drawn last, once every section's page is known.
      const at = first.lastIndexOf(`(${heading}) Tj`);
      const number = Number(/\((\d+)\) Tj/.exec(first.slice(at + heading.length))?.[1]);
      expect(startsOn, heading).toBeGreaterThan(0);
      expect(number, heading).toBe(startsOn);
      numbers.push(number);
    }
    expect(numbers.at(-1)).toBeGreaterThan(numbers[0]);
  });

  it('writes every posting rule with what it has posted, the reversals, the worked-out rules and their switches', () => {
    const out = text(sampleView());
    for (const r of POSTING_RULES) expect(out, r.id).toContain(r.id);
    for (const r of WORKED_OUT_RULES) expect(out, r.id).toContain(r.id);
    expect(out).toContain('BMG: 1,234 entries dated from January 2, 2025 to October 31, 2026, 3 of them reversed.');
    expect(out).toContain('Nothing posted by it yet.');
    expect(out).toContain('Waits on Credit memos, switched off.');
    expect(out).toContain('Reversals');
    expect(out).not.toContain("isn't written down here");
  });

  it('names a rule the journal holds that nobody wrote down, in red', () => {
    const red = '0.725 0.11 0.11 rg';
    expect(text(sampleView())).not.toContain(red);
    const out = text(sampleView({ unwritten: [{ company: 'BMG', rule: 'made_up@3', entries: 2 }] }));
    expect(out).toContain('made_up@3');
    expect(out).toContain(red);
  });

  it('lists each money step with who can take it, the second person and its switch, and who holds it now', () => {
    const out = text(sampleView());
    for (const s of MONEY_STEPS) expect(out, s.key).toContain(pdfText(s.step).slice(0, 30));
    expect(out).toContain('Levels in the books');
    expect(out).toContain('Second person:');
    expect(out).toContain('Pat Owner');
  });

  it("says who has two-step sign-in set up, and what couldn't be read", () => {
    const out = text(sampleView());
    expect(out).toContain('Kim Books');
    expect(out).toContain('Not yet');
    expect(out).toContain("Couldn't be read");
    expect(out).toContain('Switched off: only people who set up an authenticator themselves');
    expect(text(sampleView({ twoStep: { on: true, people: [] } }))).toContain('Nobody holds a money role.');
    expect(text(sampleView({ twoStep: { on: null, people: null } }))).toContain("Who has an authenticator set up couldn't be read.");
  });

  it('shows the switches, the jobs and the last runs, backup and drill', () => {
    const out = text(sampleView());
    expect(out).toContain('On since');
    expect(out).toContain('Stays off on January 1');
    expect(out).toContain('The posting run');
    expect(out).toContain('Every two hours, at 48 past');
    expect(out).toContain('The posting run last ran November 3, 2026, 8:48 AM Central.');
    expect(out).toContain('The last good backup was made November 3, 2026, 2:14 AM Central.');
    expect(out).toContain('The last restore drill passed November 3, 2026, 2:55 AM Central.');
    const none = text(sampleView({ lastPosting: null, lastCopy: null, backups: { text: [], lastMade: null, lastDrillPassed: null, problem: 'Storage is not set up.' } }));
    expect(none).toContain("The posting run hasn't run yet.");
    expect(none).toContain('No good backup has been made yet.');
    expect(none).toContain('No restore drill has passed yet.');
    expect(none).toContain('Storage is not set up.');
  });

  it("puts the sign-off box and the rules' fingerprint on it", () => {
    const out = text(sampleView());
    expect(out).toContain("I have read this description of how FleetSuite's books work, as of November 3, 2026.");
    for (const label of ['Name', 'Signature', 'Date', 'Notes']) expect(out).toContain(`(${label}) Tj`);
    expect(out).toContain(`Rules covered: ${POSTING_RULES.length + WORKED_OUT_RULES.length} rules. Their fingerprint:`);
    expect(out).toContain(FINGERPRINT);
  });

  it('lists the chart of accounts with what each is', () => {
    const out = text(sampleView());
    expect(out).toContain('Made-up Operating');
    expect(out).toContain('Posted only by its documents');
    expect(out).toContain('A heading, which takes');
    expect(out).toContain('Inactive');
    expect(text(sampleView({ accounts: null }))).toContain("The chart of accounts couldn't be read.");
    expect(text(sampleView({ accounts: [] }))).toContain('No accounts yet.');
  });

  it("leads with what couldn't be read, in red, and still draws the rest", () => {
    const out = text(sampleView({ problems: ["The switches: switches are down."], switches: null }));
    expect(out).toContain("Some of what the books hold today couldn't be read");
    expect(out).toContain('The switches: switches are down.');
    expect(out).toContain("The switches couldn't be read.");
    expect(out).toContain('Chart of accounts');
  });

  it("folds menu arrows and the typographic characters for helvetica, so nothing draws as '?'", () => {
    const out = text(sampleView());
    expect(out).toContain('Books > Switches');
    expect(out).not.toContain('→');
    expect(out).not.toMatch(/Books \? /);
  });
});

describe('pdfText', () => {
  it('folds a menu path for helvetica', () => {
    expect(pdfText('Books → How the books work')).toBe('Books > How the books work');
    expect(pdfText('More → Admin → Users')).toBe('More > Admin > Users');
  });
});

describe('howItWorksPdf', () => {
  it('hands the route the bytes, the dated name and the type', () => {
    const file = howItWorksPdf(sampleView());
    expect(file.name).toBe('How-the-books-work-2026-11-03.pdf');
    expect(file.type).toBe('application/pdf');
    expect(file.bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });
});
