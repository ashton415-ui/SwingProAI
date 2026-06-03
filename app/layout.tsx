import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space-grotesk",
});

export const metadata: Metadata = {
  title: "SwingProAI — AI-Powered Golf Analysis",
  description: "Professional-grade golf analytics powered by AI. Fix your swing in real-time.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={spaceGrotesk.variable}>
      <body className="bg-golf-dark text-gray-100 font-display antialiased">
        {children}
      </body>
    </html>
  );
}
