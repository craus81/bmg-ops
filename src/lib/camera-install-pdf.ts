'use client';

/**
 * The paper camera install form, filled in (owner ask 2026-10-06): one page
 * per install with the same three sections as the shop's sheet — Customer
 * Information, Vehicle Information, Device Identifiers — each value printed
 * on its line. The sheet's checklist is left off for now (owner's call).
 * Several installs (e.g. every van for one customer) print as one PDF.
 */

import jsPDF from 'jspdf';
import type { CameraInstall } from '@/lib/camera-install';

// Preloaded at module load so the click handler never awaits before
// window.open() (popup blockers) — same pattern as packing-list-pdf.ts.
let logoDataUrl: string | null = null;
let logoFetch: Promise<void> | null = null;

function ensureLogoLoaded(): void {
  if (logoDataUrl || logoFetch || typeof window === 'undefined') return;
  logoFetch = fetch('/bmg-logo-color.png')
    .then(res => { if (!res.ok) throw new Error(String(res.status)); return res.blob(); })
    .then(blob => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }))
    .then(url => { logoDataUrl = url; })
    .catch(() => { logoFetch = null; });
}
ensureLogoLoaded();

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric' });

function drawInstall(doc: jsPDF, r: CameraInstall, logo: string | null) {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 60;
  let y = 50;

  // ─── Logo + title ──────────────────────────────────────────
  let logoBottom = 0;
  if (logo) {
    try {
      const props = doc.getImageProperties(logo);
      const h = 54;
      const w = Math.min(200, (props.width / props.height) * h);
      doc.addImage(logo, 'PNG', (pageW - w) / 2, y, w, h, undefined, 'FAST');
      logoBottom = y + h;
    } catch { /* unreadable image — use the text wordmark */ }
  }
  if (!logoBottom) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.text('BMG Fleet', pageW / 2, y + 30, { align: 'center' });
    logoBottom = y + 40;
  }
  y = logoBottom + 36;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(0);
  doc.text('Installation Checklist', pageW / 2, y, { align: 'center' });
  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(`Installed ${fmtDate(r.installed_at)}${r.installed_by_name ? ` by ${r.installed_by_name}` : ''}`, pageW / 2, y, { align: 'center' });
  doc.setTextColor(0);
  y += 34;

  // ─── Sections: label on the left, value written on its line ─
  const labelX = margin + 30;
  const lineX = margin + 170;
  const lineEnd = pageW - margin;

  const section = (title: string) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(title, margin, y);
    y += 26;
  };
  const field = (label: string, value: string | number | null | undefined, mono = false) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.text(`${label}:`, labelX, y);
    const v = value === null || value === undefined ? '' : String(value);
    if (v) {
      doc.setFont(mono ? 'courier' : 'helvetica', mono ? 'bold' : 'normal');
      doc.setFontSize(mono ? 12 : 11);
      doc.text(v, lineX + 4, y - 2, { maxWidth: lineEnd - lineX - 8 });
    }
    doc.setDrawColor(60);
    doc.setLineWidth(0.6);
    doc.line(lineX, y + 3, lineEnd, y + 3);
    y += 24;
  };

  section('Customer Information');
  field('Customer Name', r.customer_name);
  field('Contact Name', r.contact_name);
  field('Phone Number', r.contact_phone);
  field('Email Address', r.contact_email);
  y += 14;

  section('Vehicle Information');
  field('Year', r.vehicle_year);
  field('Make', r.vehicle_make);
  field('Model', r.vehicle_model);
  field('VIN', r.vin, true);
  field('Odometer', r.odometer !== null && r.odometer !== undefined ? r.odometer.toLocaleString('en-US') : null);
  field('License Plate', r.license_plate);
  y += 14;

  section('Device Identifiers');
  field('Camera IMEI', r.camera_imei, true);
  field('GO9B IMEI', r.go9b_imei, true);

  if (r.notes) {
    y += 14;
    section('Notes');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const lines = doc.splitTextToSize(r.notes, pageW - margin * 2 - 30);
    doc.text(lines, labelX, y - 8);
  }

  // ─── Footer ────────────────────────────────────────────────
  const pageH = doc.internal.pageSize.getHeight();
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(140);
  doc.text('BMG Fleet Installations LLC · 1082 Cool Springs Industrial Dr., O’Fallon, MO 63366', margin, pageH - 28);
  doc.setTextColor(0);
}

/** Build the PDF: one page per install. `logo` is a PNG data URL. */
export function buildCameraInstallPDF(installs: CameraInstall[], logo: string | null = logoDataUrl): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  installs.forEach((r, i) => {
    if (i > 0) doc.addPage();
    drawInstall(doc, r, logo);
  });
  return doc;
}

/** Download (or print) the filled-in install form: one page per install. */
export function exportCameraInstallPDF(installs: CameraInstall[], opts?: { print?: boolean; fileName?: string }) {
  ensureLogoLoaded(); // retry for the next click if the load-time fetch failed
  if (installs.length === 0) return;
  const doc = buildCameraInstallPDF(installs);

  const fileName = opts?.fileName || (installs.length === 1
    ? `camera-install-${installs[0].vin}.pdf`
    : `camera-installs-${installs.length}.pdf`);

  if (opts?.print) {
    doc.autoPrint();
    const url = doc.output('bloburl');
    const win = window.open(url as any, '_blank');
    if (!win) doc.save(fileName);
  } else {
    doc.save(fileName);
  }
}
