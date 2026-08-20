'use client';

/**
 * Install guide PDF for CNI installers. Landscape-letter deck modeled on
 * the design-proof format: branded cover, the guide's best-practice /
 * expectation sections, one dimensioned proof page per template page
 * (annotations pre-rendered by renderGuidePage in install-guide.ts), and
 * a dimension schedule for anything labeled or annotated. Built and
 * downloaded entirely client-side — see packing-list-pdf.ts for the
 * pattern this follows.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { CompanyLetterhead } from '@/lib/company-profile';
import { companyLines } from '@/lib/company-profile';
import type { GuidePage, InstallGuide } from '@/lib/install-guide';
import { dimLabelText } from '@/lib/install-guide';
import { distancePx, formatDimension, realInchesFromPx } from '@/lib/dimension-scale';

export interface RenderedGuidePage {
  page: GuidePage;
  dataUrl: string;
  w: number;
  h: number;
}

const NAVY = '#1b2a4a';
const ACCENT = '#ee3120';

export function buildInstallGuidePdf(
  guide: InstallGuide,
  renderedPages: RenderedGuidePage[],
  letterhead: CompanyLetterhead | null,
): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 46;
  const company = letterhead?.company || null;
  const companyName = company?.name || 'BMG';

  const addLogo = (x: number | 'right', y: number, h: number, opts?: { onDark?: boolean }): number => {
    if (!letterhead?.logoDataUrl) return 0;
    try {
      const props = doc.getImageProperties(letterhead.logoDataUrl);
      const fmt = /^data:image\/jpe?g/i.test(letterhead.logoDataUrl) ? 'JPEG' : 'PNG';
      const w = Math.min(180, (props.width / props.height) * h);
      const px = x === 'right' ? pageW - margin - w : x;
      // A dark logo disappears on the navy cover — give it a white chip.
      if (opts?.onDark) {
        doc.setFillColor('#ffffff');
        doc.roundedRect(px - 8, y - 8, w + 16, h + 16, 6, 6, 'F');
      }
      // 'FAST' (deflate) keeps repeated logos from bloating the file.
      doc.addImage(letterhead.logoDataUrl, fmt, px, y, w, h, undefined, 'FAST');
      return w;
    } catch {
      return 0;
    }
  };

  const footer = (text: string) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(130);
    doc.text(text, margin, pageH - 24);
    doc.setTextColor(0);
  };

  const pageHeader = (title: string) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(NAVY);
    doc.text(title, margin, margin + 6);
    const logoW = addLogo('right', margin - 14, 26);
    if (!logoW) {
      doc.setFontSize(11);
      doc.text(companyName, pageW - margin, margin + 2, { align: 'right' });
    }
    doc.setDrawColor(ACCENT);
    doc.setLineWidth(1.5);
    doc.line(margin, margin + 16, pageW - margin, margin + 16);
    doc.setTextColor(0);
  };

  // ---- Cover ----
  doc.setFillColor(NAVY);
  doc.rect(0, 0, pageW, pageH, 'F');
  addLogo(margin, margin, 40, { onDark: true });
  doc.setTextColor('#ffffff');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(40);
  doc.text('Graphics Install Guide', margin, pageH / 2 - 40);
  doc.setFontSize(18);
  doc.setTextColor('#f3b6ae');
  if (guide.title) doc.text(guide.title, margin, pageH / 2 - 4);
  doc.setFontSize(13);
  doc.setTextColor('#d8dee9');
  let cy = pageH / 2 + 30;
  const coverLine = (label: string, value: string | null | undefined) => {
    if (!value) return;
    doc.setFont('helvetica', 'bold');
    doc.text(label, margin, cy);
    doc.setFont('helvetica', 'normal');
    doc.text(value, margin + 90, cy);
    cy += 20;
  };
  coverLine('Customer', guide.customer_name);
  coverLine('Vehicle', guide.vehicle_desc);
  coverLine('Prepared', new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }));
  doc.setFontSize(11);
  doc.setTextColor('#9fb0c9');
  doc.text(
    `Prepared by ${companyName} for Certified Network Installers. Read every section before opening material.`,
    margin,
    pageH - 60,
  );
  doc.setTextColor(0);

  // ---- Sections ----
  const sections = guide.sections.filter(s => s.include && (s.title.trim() || s.body.trim()));
  if (sections.length > 0) {
    doc.addPage();
    pageHeader('Read First: Expectations & Best Practices');
    let y = margin + 42;
    const bottom = pageH - 50;
    for (const s of sections) {
      const bodyLines = doc.splitTextToSize(s.body, pageW - margin * 2) as string[];
      const blockH = 22 + bodyLines.length * 13;
      if (y + blockH > bottom) {
        footer(`${companyName} — Graphics Install Guide`);
        doc.addPage();
        pageHeader('Expectations & Best Practices (continued)');
        y = margin + 42;
      }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(ACCENT);
      doc.text(s.title, margin, y);
      y += 17;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.5);
      doc.setTextColor(40);
      doc.text(bodyLines, margin, y);
      y += bodyLines.length * 13 + 16;
      doc.setTextColor(0);
    }
    footer(`${companyName} — Graphics Install Guide`);
  }

  // ---- Dimensioned proof pages ----
  for (const rp of renderedPages) {
    doc.addPage();
    pageHeader(rp.page.name || 'Placement');
    if (guide.vehicle_desc) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(90);
      doc.text(guide.vehicle_desc, margin, margin + 32);
      doc.setTextColor(0);
    }
    const boxTop = margin + 42;
    const boxH = pageH - boxTop - 56;
    const boxW = pageW - margin * 2;
    const scale = Math.min(boxW / rp.w, boxH / rp.h);
    const w = rp.w * scale;
    const h = rp.h * scale;
    doc.addImage(rp.dataUrl, 'PNG', margin + (boxW - w) / 2, boxTop + (boxH - h) / 2, w, h, undefined, 'FAST');
    footer(
      `All dimensions are actual vehicle dimensions in inches (template scale ${guide.scale}), rounded to the nearest 1/${guide.fraction_denominator}". ` +
        'Verify placement against body features before removing liner.',
    );
  }

  // ---- Dimension schedule (only annotations worth listing) ----
  const rows: string[][] = [];
  for (const rp of renderedPages) {
    for (const d of rp.page.dims) {
      if (!d.label && !d.note) continue;
      const measured =
        d.kind === 'dim' && rp.page.px_per_in
          ? formatDimension(
              realInchesFromPx(distancePx(d.p1.x, d.p1.y, d.p2.x, d.p2.y), rp.page.px_per_in),
              guide.units,
              guide.fraction_denominator,
            )
          : d.kind === 'dim'
            ? '—'
            : '';
      rows.push([
        rp.page.name || 'Page',
        d.kind === 'dim' ? d.label || dimLabelText(d, rp.page.px_per_in, guide.units, guide.fraction_denominator) : `Note: ${d.label || d.note || ''}`,
        measured,
        d.kind === 'dim' ? d.note || '' : d.label ? d.note || '' : '',
      ]);
    }
  }
  if (rows.length > 0) {
    doc.addPage();
    pageHeader('Dimension Schedule');
    autoTable(doc, {
      startY: margin + 40,
      margin: { left: margin, right: margin },
      head: [['Page', 'Dimension', 'Measurement', 'Notes']],
      body: rows,
      styles: { fontSize: 10, cellPadding: 5 },
      headStyles: { fillColor: [27, 42, 74], fontSize: 10 },
      alternateRowStyles: { fillColor: [245, 246, 249] },
    });
    footer(`${companyName} — Graphics Install Guide`);
  }

  // ---- Back page ----
  doc.addPage();
  pageHeader('Questions Before You Install?');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  let by = margin + 60;
  doc.text(
    doc.splitTextToSize(
      'If a dimension does not match the vehicle in front of you, material is missing or damaged, or anything on this guide is unclear — stop and contact us through your job in the installer portal before installing.',
      pageW - margin * 2 - 120,
    ),
    margin,
    by,
  );
  by += 70;
  for (const line of companyLines(company)) {
    doc.text(line, margin, by);
    by += 16;
  }
  footer(`${companyName} — Graphics Install Guide`);

  return doc;
}

export function installGuideFileName(guide: InstallGuide): string {
  const base = (guide.title || guide.customer_name || 'Untitled').replace(/[\\/:*?"<>|]+/g, ' ').trim();
  return `Install Guide - ${base}.pdf`;
}
