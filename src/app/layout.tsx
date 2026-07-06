import type { Metadata } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Display: an engineered grotesk for headings and the instrument readouts.
const display = Space_Grotesk({
  variable: "--ff-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

// Body: a workhorse for dense trade information.
const body = Inter({
  variable: "--ff-body",
  subsets: ["latin"],
});

// Data: every number — price, bid, odometer, countdown — sits in this mono,
// so the app reads like an instrument cluster.
const mono = JetBrains_Mono({
  variable: "--ff-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Wholesale Dealer Auctions",
  description: "Live B2B wholesale vehicle auctions for licensed NZ dealers",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-ink text-chalk">{children}</body>
    </html>
  );
}
