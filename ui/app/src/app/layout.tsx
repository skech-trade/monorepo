import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
  axes: ["opsz"],
});

/* Figures are set in mono, the way coss pairs Inter with Geist Mono. */
const mono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "skech",
  description: "Draw where you think the price is going.",
  applicationName: "skech",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html className={`h-full ${inter.variable} ${mono.variable} antialiased`} lang="en">
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground text-sm">
        <ToastProvider position="bottom-right">
          <TooltipProvider delay={300}>{children}</TooltipProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
