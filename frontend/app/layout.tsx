import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dropkanzi",
  description: "Amazon sourcing, repricing, and eBay listing management",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="tr" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="font-sans antialiased min-h-screen">
        {children}
        <Toaster
          position="top-right"
          toastOptions={{
            className:
              "!rounded-[7px] !bg-accent !text-white !border-none !shadow-md !text-[13px]",
          }}
        />
      </body>
    </html>
  );
}
