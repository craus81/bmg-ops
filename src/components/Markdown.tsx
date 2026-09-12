'use client';

/**
 * A small markdown renderer for the Help Center (R6-13).
 *
 * Everything becomes React elements — there is no dangerouslySetInnerHTML
 * anywhere in here. The guides come out of a database table an admin can
 * write to, so rendering them as HTML would turn "edit a help doc" into
 * "run script in every reader's session". Anything this renderer doesn't
 * understand falls through as plain text, which is the safe failure.
 *
 * Supports what docs/help actually uses: headings, bullet and numbered
 * lists, fenced code, blockquotes, tables, rules, and inline bold, code
 * and links.
 */

import React from 'react';
import { sectionsOf } from '@/lib/help-center';

/** http(s) and in-app paths only. Anything else (javascript:, data:) renders as text. */
function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('/') && !h.startsWith('//')) return h;
  if (h.startsWith('#')) return h;
  return null;
}

const code: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.9em', background: 'var(--input-bg)', padding: '1px 5px', borderRadius: '4px',
};

/** Inline **bold**, `code` and [text](href). */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith('**')) {
      out.push(<strong key={k} style={{ color: 'var(--text-primary)' }}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('`')) {
      out.push(<code key={k} style={code}>{tok.slice(1, -1)}</code>);
    } else {
      const cut = tok.indexOf('](');
      const label = tok.slice(1, cut);
      const href = safeHref(tok.slice(cut + 2, -1));
      out.push(href
        ? <a key={k} href={href} style={{ color: '#60a5fa' }} {...(href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{label}</a>
        : <span key={k}>{label}</span>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const splitRow = (line: string): string[] => {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
};

const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export default function Markdown({ content }: { content: string }) {
  const lines = String(content || '').split('\n');
  // Anchor ids come from the same function the table of contents uses, so a
  // deep link and the list of sections can never disagree.
  const anchors = sectionsOf(content).map(s => s.id);
  let anchorIdx = 0;

  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    if (/^\s*(```|~~~)/.test(line)) {
      const fence = line.trim().slice(0, 3);
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i++;
      out.push(
        <pre key={key++} style={{
          background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '8px',
          padding: '10px 12px', overflowX: 'auto', fontSize: '12px', lineHeight: 1.5,
        }}><code>{body.join('\n')}</code></pre>,
      );
      continue;
    }

    // Heading
    const h = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      const id = anchors[anchorIdx++] || undefined;
      const size = [21, 17, 15, 13][level - 1];
      out.push(
        <h2 key={key++} id={id} style={{
          fontSize: `${size}px`, fontWeight: 800, color: 'var(--text-primary)',
          margin: `${level === 1 ? 4 : 18}px 0 8px`, scrollMarginTop: '70px',
        }}>{h[2].replace(/\s*#+\s*$/, '')}</h2>,
      );
      i++;
      continue;
    }

    // Rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(<hr key={key++} style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '16px 0' }} />);
      i++;
      continue;
    }

    // Table
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const headers = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      out.push(
        <div key={key++} style={{ overflowX: 'auto', margin: '10px 0' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '12.5px', minWidth: '100%' }}>
            <thead>
              <tr>{headers.map((hd, n) => (
                <th key={n} style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--border)', color: 'var(--text-label)', fontWeight: 800, whiteSpace: 'nowrap' }}>{inline(hd, `th${n}`)}</th>
              ))}</tr>
            </thead>
            <tbody>{rows.map((r, rn) => (
              <tr key={rn}>{r.map((c, cn) => (
                <td key={cn} style={{ padding: '6px 10px', borderBottom: '1px solid rgba(var(--border-rgb),0.4)', color: 'var(--text-body)', verticalAlign: 'top' }}>{inline(c, `td${rn}-${cn}`)}</td>
              ))}</tr>
            ))}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(
        <blockquote key={key++} style={{
          borderLeft: '3px solid var(--border)', margin: '10px 0', padding: '2px 0 2px 12px',
          color: 'var(--text-secondary)', fontSize: '13px', lineHeight: 1.6,
        }}>{inline(body.join(' '), `bq${key}`)}</blockquote>,
      );
      continue;
    }

    // Lists
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      const items: string[] = [];
      while (i < lines.length) {
        const b = /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        const n = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]);
        if (ordered ? !n : !b) break;
        items.push((ordered ? n![1] : b![1]));
        i++;
      }
      const Tag = ordered ? 'ol' : 'ul';
      out.push(
        <Tag key={key++} style={{ margin: '8px 0', paddingLeft: '20px', fontSize: '13px', color: 'var(--text-body)', lineHeight: 1.6 }}>
          {items.map((it, n) => <li key={n} style={{ marginBottom: '4px' }}>{inline(it, `li${key}-${n}`)}</li>)}
        </Tag>,
      );
      continue;
    }

    // Paragraph
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,4}\s|\s*[-*+]\s|\s*\d+[.)]\s|\s*>|\s*(```|~~~)|\s*\|)/.test(lines[i])
      && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      para.push(lines[i++]);
    }
    if (para.length) {
      out.push(
        <p key={key++} style={{ fontSize: '13px', color: 'var(--text-body)', lineHeight: 1.65, margin: '8px 0' }}>
          {inline(para.join(' '), `p${key}`)}
        </p>,
      );
    } else {
      i++;
    }
  }

  return <div>{out}</div>;
}
