import type { Metadata, Viewport } from 'next';
import './globals.css';

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: 'BMG FleetSuite',
  description: 'BMG Fleet Installations Operations',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/icon-192.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'BMG FleetSuite',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Allow user zoom — fixed scale fails WCAG 2.1 SC 1.4.4 (Resize Text) and is
  // the primary accommodation for low-vision users on mobile. The Capacitor
  // wrapper also no longer needs userScalable: false on iOS 14+.
  themeColor: '#0f1720',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the pre-paint script below stamps
    // data-textsize on <html> before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <script dangerouslySetInnerHTML={{ __html: `
          // Apply the saved text size before first paint so the page doesn't
          // visibly re-zoom on load. ThemeProvider takes over after mount.
          try {
            var ts = localStorage.getItem('bmg-text-size');
            if (ts === 'large' || ts === 'xl') {
              document.documentElement.setAttribute('data-textsize', ts);
            }
          } catch (e) {}
          if ('serviceWorker' in navigator) {
            window.addEventListener('load', function() {
              navigator.serviceWorker.register('/sw.js').catch(function(err) {
                console.error('Service worker registration failed:', err);
              });
              // Safari WindowClient lacks .navigate(), so the service worker
              // posts NOTIFICATION_NAVIGATE for notification clicks instead.
              // Route here on the main thread.
              navigator.serviceWorker.addEventListener('message', function(event) {
                var data = event && event.data;
                if (data && data.type === 'NOTIFICATION_NAVIGATE' && typeof data.url === 'string') {
                  try { window.location.assign(data.url); } catch (e) {}
                }
              });
            });
          }
        `}} />
      </head>
      <body>
        {/* Skip link: visible only on keyboard focus, lets screen-reader and
            keyboard users bypass the global header/nav. Targets the #main
            anchor that ClientProviders renders around the page content. */}
        <a href="#main" className="skip-to-main">Skip to main content</a>
        {children}
      </body>
    </html>
  );
}
