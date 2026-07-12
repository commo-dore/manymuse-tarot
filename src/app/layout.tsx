import type { Metadata } from "next";
import { Cormorant_Garamond, Inter } from "next/font/google";
import "./globals.css";

const serif = Cormorant_Garamond({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-serif",
});
const sans = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "ManyMuse Tarot",
  description: "Hand-pulled Osho Zen tarot readings by a real reader.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-[#131020] text-[#e9e4f5] font-[family-name:var(--font-sans)]">
        {children}
      </body>
    </html>
  );
}
