import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";

const space = Space_Grotesk({ subsets: ["latin"], variable: "--font-space", display: "swap" });

export const metadata: Metadata = {
  title: { default: "JENAI", template: "%s · JENAI" },
  description: "AI calling for Indian businesses, by Diigoo Tech",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={space.variable}>
      <body>{children}</body>
    </html>
  );
}
