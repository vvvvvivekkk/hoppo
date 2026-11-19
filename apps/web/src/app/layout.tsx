import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ApiProvider } from '@/lib/api';
import { CartProvider } from '@/lib/cart';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hoppo',
  description: 'Order from shops near your college, delivered by other students.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Not `maximumScale: 1`. Locking zoom is the usual way to stop iOS Safari
  // zooming on input focus, and it also stops a partially-sighted student
  // pinching to read anything. The 16px font floor in globals.css solves the
  // zoom problem without taking zoom away.
  themeColor: '#0f766e',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ApiProvider>
          <CartProvider>{children}</CartProvider>
        </ApiProvider>
      </body>
    </html>
  );
}
