import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SwingMaster — AI Golf Coach',
  description: 'Upload your swing. Get instant AI biomechanical coaching.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full overflow-x-hidden">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0" />
      </head>
      <body className="h-full w-full bg-slate-950 text-slate-100 antialiased overflow-x-hidden">
        {children}
      </body>
    </html>
  );
}