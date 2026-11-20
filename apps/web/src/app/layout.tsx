import type { Metadata } from 'next';
import { Alexandria, IBM_Plex_Sans_Arabic } from 'next/font/google';
import './globals.css';

const alexandria = Alexandria({ subsets: ['arabic', 'latin'], weight: ['600', '700'], variable: '--font-alexandria', display: 'swap' });
const plex = IBM_Plex_Sans_Arabic({ subsets: ['arabic', 'latin'], weight: ['400', '500', '600'], variable: '--font-plex', display: 'swap' });

export const metadata: Metadata = { title: { default: 'دوسلي', template: '%s · دوسلي' }, description: 'كل عملاء الوكالة في مكان واحد: واتساب، والبوستات، والفريق.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" className={`${alexandria.variable} ${plex.variable}`}>
      <body>{children}</body>
    </html>
  );
}
