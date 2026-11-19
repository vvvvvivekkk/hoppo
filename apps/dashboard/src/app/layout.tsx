import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { ApiProvider } from '@/lib/api';
import { Shell } from '@/components/shell';

export const metadata: Metadata = {
  title: 'Hoppo Shop',
  description: 'Order queue and catalog for shops on Hoppo',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // A counter tablet gets propped at an angle and nudged; letting the page
  // zoom on a stray pinch is worse than fixing the scale. Zoom is left
  // *enabled* (maximumScale is not 1) because disabling it breaks the browser
  // zoom that a partially sighted operator depends on.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ApiProvider>
          <Shell>{children}</Shell>
        </ApiProvider>
      </body>
    </html>
  );
}
