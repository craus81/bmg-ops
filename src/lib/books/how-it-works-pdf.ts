/**
 * How FleetSuite's books work, as a dated PDF BMG's CPA can read and sign
 * (Books part 88, docs/books.md "How the books work"): everything Books →
 * How the books work shows (src/lib/books/how-it-works.ts and
 * how-it-works-data.ts), section by section, with a contents list, a box
 * for the CPA's name, signature and date, the fingerprint of the rules it
 * covers, and the chart of accounts at the end. One builder, so the PDF
 * and the page can't say different things.
 *
 * No tax IDs or bank numbers are on it: the view carries none.
 *
 * Pure: no window or DOM, so the server makes the bytes. Letter, in points.
 */

import jsPDF from 'jspdf';
import autoTable, { type RowInput } from 'jspdf-autotable';
import { pageText } from './own-invoice-pdf';
import { PART_TEXT, RULE_GROUPS, STEP_AREAS, type HowItWorksView, type RuleGroup, type StepArea } from './how-it-works';
import {
  andList, centralDay, centralWhen, countText, dayText, howItWorksFilename, monthText, peopleText, reviewText, ruleUseText, switchText,
} from './how-it-works-words';

type RGB = [number, number, number];

const MARGIN = 48;
const TOP = 56;
const FOOT = 56;
const INK: RGB = [17, 24, 39];
const BODY: RGB = [55, 65, 81];
const MUTED: RGB = [107, 114, 128];
const RED: RGB = [185, 28, 28];
const AMBER: RGB = [180, 83, 9];
const GREEN: RGB = [21, 128, 61];
const BLUE: RGB = [37, 99, 235];
const RULE_LINE: RGB = [229, 231, 235];

/** The sections, in order, as the contents lists them. */
export const PDF_SECTIONS = [
  'About this description',
  'What posts what',
  'Who can change what',
  'Two-step sign-in',
  "What the database won't let anyone do",
  'Controls',
  'The switches',
  'Jobs that run by themselves',
  'Backups',
  'Records kept',
  'What the IRS asks',
  "The CPA's review",
  'Chart of accounts',
] as const;

/** Text as helvetica draws it: a menu path's arrow as '>', then as pageText folds the rest. */
export const pdfText = (text: string): string => pageText(text.replace(/\s*→\s*/g, ' > '));

/** The whole description on letter pages, the contents on the first and the chart of accounts last. */
export function buildHowItWorksPdf(view: HowItWorksView): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const width = pageW - MARGIN * 2;
  const bottom = pageH - FOOT;
  let y = TOP;

  const room = (h: number) => {
    if (y + h > bottom) {
      doc.addPage();
      y = TOP;
    }
  };

  const write = (text: string, o: { size?: number; style?: 'normal' | 'bold' | 'italic'; color?: RGB; indent?: number; gap?: number } = {}) => {
    const size = o.size ?? 9.5;
    const indent = o.indent ?? 0;
    const lh = size * 1.32;
    doc.setFont('helvetica', o.style ?? 'normal').setFontSize(size).setTextColor(...(o.color ?? BODY));
    for (const line of doc.splitTextToSize(pdfText(text), width - indent) as string[]) {
      room(lh);
      doc.text(line, MARGIN + indent, y + size);
      y += lh;
    }
    y += o.gap ?? 5;
  };

  const bullet = (text: string, color: RGB = BODY) => {
    const size = 9.5;
    const lh = size * 1.32;
    doc.setFont('helvetica', 'normal').setFontSize(size).setTextColor(...color);
    (doc.splitTextToSize(pdfText(text), width - 14) as string[]).forEach((line, i) => {
      room(lh);
      if (i === 0) doc.text('-', MARGIN + 3, y + size);
      doc.text(line, MARGIN + 14, y + size);
      y += lh;
    });
    y += 2;
  };

  /** Where each section starts, for the contents. */
  const starts: number[] = [];
  const section = (title: (typeof PDF_SECTIONS)[number]) => {
    const n = PDF_SECTIONS.indexOf(title) + 1;
    room(82);
    if (y > TOP) y += 12;
    starts[n - 1] = doc.getNumberOfPages();
    doc.setFont('helvetica', 'bold').setFontSize(13).setTextColor(...INK);
    doc.text(pdfText(`${n}. ${title}`), MARGIN, y + 13);
    y += 19;
    doc.setDrawColor(...BLUE).setLineWidth(1).line(MARGIN, y, MARGIN + width, y);
    y += 9;
  };

  const sub = (title: string) => {
    room(48);
    y += 3;
    write(title, { size: 10.5, style: 'bold', color: INK, gap: 3 });
  };

  const table = (head: string[], body: RowInput[], columnStyles: Record<number, { cellWidth?: number; fontStyle?: 'bold' }> = {}) => {
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN, top: TOP, bottom: FOOT },
      head: [head.map(pdfText)],
      body,
      theme: 'grid',
      // A row stays on one page: a step and who takes it read together.
      rowPageBreak: 'avoid',
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 4, textColor: BODY, lineColor: RULE_LINE, lineWidth: 0.5, valign: 'top', overflow: 'linebreak' },
      headStyles: { fillColor: [243, 244, 246], textColor: INK, fontStyle: 'bold' },
      columnStyles,
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
  };

  /** A cell of a line or more, each folded for helvetica. */
  const cell = (...lines: Array<string | null | undefined | false>) =>
    lines.filter((l): l is string => !!l && !!l.trim()).map(pdfText).join('\n');

  // ── The title, the date, the review and what couldn't be read ──
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(...INK);
  doc.text("How FleetSuite's books work", MARGIN, y + 18);
  y += 30;
  write(`As of ${centralWhen(view.asOf)}`, { size: 10.5, color: MUTED, gap: 2 });
  if (view.companies.length) {
    write(`For ${andList(view.companies.map((c) => `${c.name} (${c.code})`))}`, { size: 10.5, color: MUTED, gap: 8 });
  }
  const review = reviewText(view.review);
  write(review.text, { size: 10, style: 'bold', color: review.tone === 'good' ? GREEN : review.tone === 'changed' ? AMBER : MUTED, gap: 8 });
  if (view.problems.length) {
    write("Some of what the books hold today couldn't be read, so it's left out below:", { color: RED, style: 'bold', gap: 2 });
    for (const p of view.problems) bullet(p, RED);
    y += 4;
  }

  // The contents, filled in at the end once each section's page is known.
  y += 4;
  write('Contents', { size: 10.5, style: 'bold', color: INK, gap: 2 });
  const contentsY = y;
  y += PDF_SECTIONS.length * 13 + 8;

  // ── 1. About this description ──
  section('About this description');
  write(view.about);
  write(`${PART_TEXT.written} Section 11 says what the IRS asks of records kept in software and where this answers it.`);
  table(
    ['Company', 'Books live from', 'Months closed through', 'Years closed'],
    view.companies.map((c) => [
      cell(`${c.name} (${c.code})`),
      c.liveFrom ? dayText(c.liveFrom) : 'Not live yet',
      c.closedThrough ? monthText(c.closedThrough) : 'None yet',
      c.yearsClosed.length ? c.yearsClosed.join(', ') : 'None yet',
    ]),
  );

  // ── 2. What posts what ──
  section('What posts what');
  write(PART_TEXT.rules);
  for (const group of Object.keys(RULE_GROUPS) as RuleGroup[]) {
    sub(RULE_GROUPS[group].name);
    write(RULE_GROUPS[group].about, { color: MUTED });
    for (const r of view.rules.filter((x) => x.group === group)) {
      room(60);
      write(`${r.name} (${r.id})`, { style: 'bold', color: INK, gap: 1 });
      write(r.from, { gap: 2 });
      for (const p of r.posts) bullet(p);
      if (r.note) write(r.note, { style: 'italic', color: MUTED, gap: 2 });
      write(`Posted so far: ${ruleUseText(r.use)}`, { size: 8.5, color: MUTED, gap: 7 });
    }
  }
  sub('Reversals');
  write(view.reversals);
  if (view.unwritten.length) {
    write(
      `The journal holds entries posted by a rule that isn't written down here: ${view.unwritten.map((u) => `${u.rule} (${u.company}, ${countText(u.entries, 'entry', 'entries')})`).join(', ')}. FleetSuite's code has to say what it is before this description is complete.`,
      { color: RED, style: 'bold' },
    );
  }
  sub("Rules that work out what's sent");
  write(PART_TEXT.workedOut, { color: MUTED });
  for (const r of view.workedOut) {
    room(48);
    write(`${r.name} (${r.id})`, { style: 'bold', color: INK, gap: 1 });
    write(r.what, { gap: 2 });
    const waits = switchText(r.switchName, r.switchOn);
    write(waits ?? 'In use now.', { size: 8.5, color: MUTED, gap: 7 });
  }

  // ── 3. Who can change what ──
  section('Who can change what');
  write(PART_TEXT.steps);
  sub('Levels in the books');
  table(
    ['Level', 'Who', 'What they can do', 'People now'],
    view.levels.map((l) => [cell(l.name), cell(l.who), cell(l.can), cell(peopleText(l.people))]),
    { 0: { cellWidth: 62, fontStyle: 'bold' }, 1: { cellWidth: 80 }, 3: { cellWidth: 110 } },
  );
  for (const area of Object.keys(STEP_AREAS) as StepArea[]) {
    const steps = view.steps.filter((s) => s.area === area);
    if (!steps.length) continue;
    sub(STEP_AREAS[area]);
    table(
      ['Step', 'Who can take it', 'People now'],
      steps.map((s) => [
        cell(s.step, `Where: ${s.where}`, s.note, s.posts.length ? `Posts by ${s.posts.join(', ')}` : null),
        cell(s.who, s.approval ? `Second person: ${s.approval}` : null, switchText(s.switchName, s.switchOn)),
        cell(peopleText(s.people)),
      ]),
      { 0: { cellWidth: 210 }, 1: { cellWidth: 170 } },
    );
  }

  // ── 4. Two-step sign-in ──
  section('Two-step sign-in');
  write(view.twoStep.on === null
    ? "Whether two-step sign-in for money roles is switched on couldn't be read."
    : view.twoStep.on
      ? 'Switched on: everyone with a money role gives a code from an authenticator app when they sign in.'
      : "Switched off: only people who set up an authenticator themselves give a code when they sign in. It's switched on in Books > Switches.");
  if (view.twoStep.people === null) write("Who has an authenticator set up couldn't be read.", { color: RED });
  else if (!view.twoStep.people.length) write('Nobody holds a money role.');
  else {
    table(
      ['Name', 'Money roles', 'Authenticator set up'],
      view.twoStep.people.map((p) => [cell(p.name), cell(p.roles), p.setUp === null ? "Couldn't be read" : p.setUp ? 'Yes' : 'Not yet']),
    );
  }

  // ── 5. What the database won't let anyone do ──
  section("What the database won't let anyone do");
  write(PART_TEXT.database);
  for (const rule of view.database) bullet(rule);
  y += 3;
  write(view.databaseAccess);

  // ── 6. Controls ──
  section('Controls');
  table(
    ['Control', 'What it does', 'Where'],
    view.controls.map((c) => [cell(c.name), cell(c.text), cell(c.where)]),
    { 0: { cellWidth: 90, fontStyle: 'bold' }, 2: { cellWidth: 110 } },
  );

  // ── 7. The switches ──
  section('The switches');
  write(PART_TEXT.switches);
  if (view.switches === null) write("The switches couldn't be read.", { color: RED });
  else {
    table(
      ['Switch', 'What it does', 'Now', 'When it goes on'],
      view.switches.map((s) => [
        cell(s.name),
        cell(s.what),
        cell(s.on ? `On${s.changedAt ? ` since ${centralDay(s.changedAt)}` : ''}` : `Off${s.changedAt ? ` since ${centralDay(s.changedAt)}` : ''}`),
        cell(s.later ?? ''),
      ]),
      { 0: { cellWidth: 100, fontStyle: 'bold' }, 2: { cellWidth: 84 }, 3: { cellWidth: 120 } },
    );
  }

  // ── 8. Jobs that run by themselves ──
  section('Jobs that run by themselves');
  table(
    ['Job', 'When', 'What it does'],
    view.jobs.map((j) => [cell(j.name), cell(j.when), cell(j.what)]),
    { 0: { cellWidth: 110, fontStyle: 'bold' }, 1: { cellWidth: 120 } },
  );
  write(view.lastPosting ? `The posting run last ran ${centralWhen(view.lastPosting)}.` : "The posting run hasn't run yet.", { gap: 1 });
  write(view.lastCopy ? `NetSuite's general ledger was last copied ${centralWhen(view.lastCopy)}.` : "NetSuite's general ledger hasn't been copied yet.");

  // ── 9. Backups ──
  section('Backups');
  for (const p of view.backups.text) write(p);
  write(view.backups.lastMade ? `The last good backup was made ${centralWhen(view.backups.lastMade)}.` : 'No good backup has been made yet.', { gap: 1 });
  write(view.backups.lastDrillPassed ? `The last restore drill passed ${centralWhen(view.backups.lastDrillPassed)}.` : 'No restore drill has passed yet.');
  if (view.backups.problem) write(view.backups.problem, { color: RED, style: 'bold' });

  // ── 10. Records kept ──
  section('Records kept');
  for (const r of view.records) bullet(r);

  // ── 11. What the IRS asks ──
  section('What the IRS asks');
  write(view.irs.intro);
  table(
    ['What it asks for', 'Where this description answers it'],
    view.irs.asks.map((a) => [cell(a.ask), cell(a.answer)]),
    { 0: { cellWidth: 190, fontStyle: 'bold' } },
  );

  // ── 12. The CPA's review ──
  section("The CPA's review");
  write(review.text, { style: 'bold', color: review.tone === 'good' ? GREEN : review.tone === 'changed' ? AMBER : MUTED });
  if (view.review.last?.note) write(`Their note: ${view.review.last.note}`, { style: 'italic' });
  write(PART_TEXT.review);
  room(190);
  y += 6;
  doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(...BODY);
  doc.text(pdfText(`I have read this description of how FleetSuite's books work, as of ${centralDay(view.asOf)}.`), MARGIN, y + 9.5);
  y += 36;
  const third = (width - 40) / 3;
  doc.setDrawColor(150).setLineWidth(0.75);
  for (let i = 0; i < 3; i++) doc.line(MARGIN + i * (third + 20), y, MARGIN + i * (third + 20) + third, y);
  doc.setFontSize(8).setTextColor(...MUTED);
  ['Name', 'Signature', 'Date'].forEach((label, i) => doc.text(label, MARGIN + i * (third + 20), y + 11));
  y += 26;
  doc.text('Notes', MARGIN, y + 8);
  y += 12;
  doc.setDrawColor(190).rect(MARGIN, y, width, 64);
  y += 76;
  doc.setFontSize(7.5).setTextColor(...MUTED);
  doc.text(pdfText(`Rules covered: ${countText(view.rules.length + view.workedOut.length, 'rule')}. Their fingerprint:`), MARGIN, y + 7.5);
  doc.setFont('courier', 'normal').text(view.review.fingerprint, MARGIN, y + 18);
  y += 26;

  // ── 13. Chart of accounts ──
  section('Chart of accounts');
  if (view.accounts === null) write("The chart of accounts couldn't be read.", { color: RED });
  else if (!view.accounts.length) write('No accounts yet.');
  else {
    write('Every account in FleetSuite\'s books, as of the date above. "Both" is an account either company posts to.', { color: MUTED });
    table(
      ['Number', 'Name', 'Type', 'Company', 'Notes'],
      view.accounts.map((a) => [
        cell(a.number),
        cell(a.name),
        cell(a.type),
        cell(a.company),
        cell(andList([
          ...(a.active ? [] : ['Inactive']),
          ...(a.heading ? ['A heading, which takes no postings'] : []),
          ...(a.control ? ['Posted only by its documents'] : []),
        ])),
      ]),
      { 0: { cellWidth: 52 }, 2: { cellWidth: 100 }, 3: { cellWidth: 52 }, 4: { cellWidth: 120 } },
    );
  }

  // ── The contents on the first page, and a footer on every page ──
  const pages = doc.getNumberOfPages();
  doc.setPage(1);
  doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(...BODY);
  PDF_SECTIONS.forEach((title, i) => {
    const lineY = contentsY + i * 13 + 9.5;
    doc.text(pdfText(`${i + 1}. ${title}`), MARGIN + 6, lineY);
    doc.text(String(starts[i] ?? ''), MARGIN + width, lineY, { align: 'right' });
  });
  const footer = pdfText(`How FleetSuite's books work, as of ${centralDay(view.asOf)}`);
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(140);
    doc.text(footer, MARGIN, pageH - 30);
    doc.text(`Page ${p} of ${pages}`, pageW - MARGIN, pageH - 30, { align: 'right' });
  }
  doc.setTextColor(0);
  return doc;
}

/** The PDF's bytes and name, for the download route. */
export function howItWorksPdf(view: HowItWorksView): { bytes: Buffer; name: string; type: string } {
  return {
    bytes: Buffer.from(buildHowItWorksPdf(view).output('arraybuffer')),
    name: howItWorksFilename(view.asOf),
    type: 'application/pdf',
  };
}
