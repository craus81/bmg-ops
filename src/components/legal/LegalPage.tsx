import { LEGAL } from '@/lib/legal';

export type LegalSection = { heading: string; body: (string | string[])[] };

/**
 * Plain, public, unauthenticated document page for /privacy and /terms.
 * A string in `body` is a paragraph; a string[] is a bullet list.
 */
export default function LegalPage({ title, intro, sections }: { title: string; intro: string; sections: LegalSection[] }) {
  return (
    <main id="main" style={{ background: '#fff', color: '#1a2b36', minHeight: '100vh', padding: '32px 16px' }}>
      <article style={{ maxWidth: 760, margin: '0 auto', fontSize: 15, lineHeight: 1.6 }}>
        <img src="/bmg-logo-color.png" alt="BMG" style={{ height: 40, marginBottom: 24 }} />
        <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 4 }}>{title}</h1>
        <p style={{ color: '#5b6b76', marginTop: 0 }}>Effective date: {LEGAL.effectiveDate}</p>
        <p>{intro}</p>
        {sections.map((s, i) => (
          <section key={s.heading}>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 28 }}>{i + 1}. {s.heading}</h2>
            {s.body.map((b, j) => Array.isArray(b)
              ? <ul key={j}>{b.map(li => <li key={li}>{li}</li>)}</ul>
              : <p key={j}>{b}</p>)}
          </section>
        ))}
      </article>
    </main>
  );
}

export function contactBlock(email: string): string[] {
  return [LEGAL.entityName, LEGAL.address, email];
}
