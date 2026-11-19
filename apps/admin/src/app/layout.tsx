import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { ApiProvider } from '@/lib/api';
import { Shell } from '@/components/shell';

export const metadata: Metadata = {
  title: 'Hoppo Admin',
  description: 'Verification queues, escalations and college settings',
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
