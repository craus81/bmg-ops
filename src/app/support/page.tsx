import type { CSSProperties } from 'react';
import type { Metadata } from 'next';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = { title: 'Support — BMG FleetSuite' };

const h2: CSSProperties = { fontSize: 18, fontWeight: 700, marginTop: 28 };

/**
 * The App Store listing's Support URL (docs/ios-app-store-checklist.md).
 * Public like /privacy and /terms, so it stays outside the (main) route
 * group. It matches their look but not their component: LegalPage bodies
 * are plain text, and this page needs links.
 */
export default function SupportPage() {
  const email = LEGAL.contactEmail;
  return (
    <main id="main" style={{ background: '#fff', color: '#1a2b36', minHeight: '100vh', padding: '32px 16px' }}>
      <article style={{ maxWidth: 760, margin: '0 auto', fontSize: 15, lineHeight: 1.6 }}>
        <img src="/bmg-logo-color.png" alt="BMG" style={{ height: 40, marginBottom: 24 }} />
        <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 4 }}>FleetSuite Support</h1>
        <p>
          FleetSuite is the operations app {LEGAL.entityName} uses for its vehicle upfit, graphics,
          scheduling, estimating and invoicing work, on the web at go.bmgfleet.com and in the
          BMG FleetSuite mobile app.
        </p>

        <h2 style={h2}>Getting an account</h2>
        <p>
          BMG administrators create FleetSuite accounts. If you work with BMG and need access, ask a
          BMG administrator or email us at the address below.
        </p>

        <h2 style={h2}>Signing in</h2>
        <p>
          Sign in with your work email and password, or choose Magic Link to get a sign-in link by
          email. If you forgot your password, choose &ldquo;Forgot password?&rdquo; on the sign-in screen.
          Once you&apos;re signed in, More &rarr; Help has guides for every part of the app.
        </p>

        <h2 style={h2}>Contact us</h2>
        <p>
          Email <a href={`mailto:${email}`}>{email}</a>. Tell us the email address you sign in with
          and what you were doing when the problem happened.
        </p>
        <p style={{ marginTop: 12 }}>
          {LEGAL.entityName}<br />
          {LEGAL.address}
        </p>

        <h2 style={h2}>Privacy and your data</h2>
        <p>
          Read our <a href="/privacy">Privacy Policy</a>. To see, correct or delete your personal
          information, or to close your account, email us at the address above.
        </p>
      </article>
    </main>
  );
}
