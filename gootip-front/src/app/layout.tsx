import type { Metadata } from 'next';
import { Geist, Geist_Mono, Inter } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';
import { cn } from '@/lib/utils';

const interHeading = Inter({ subsets: ['latin'], variable: '--font-heading' });

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Gootip Store',
  description:
    'Gootip Store - A platform for buying and selling digital products.',
};

type RootLayoutProps = {
  children: ReactNode;
};

const RootLayout = ({ children }: RootLayoutProps) => {
  return (
    <html
      lang="en"
      className={cn(
        geistSans.variable,
        geistMono.variable,
        'font-sans',
        inter.variable,
        interHeading.variable,
      )}
    >
      <body>{children}</body>
    </html>
  );
};

export default RootLayout;
