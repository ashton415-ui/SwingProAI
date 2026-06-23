import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SwingMaster — AI Golf Coach',
  description: 'Upload your swing. Get instant AI biomechanical coaching.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}