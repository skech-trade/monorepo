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

const SITE = "https://app.skech.trade";
const TITLE = "skech";
const DESCRIPTION = "Draw where you think the price is going. That drawing is the trade.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: TITLE, template: "%s · skech" },
  description: DESCRIPTION,
  applicationName: "skech",
  keywords: ["skech", "draw to trade", "bitcoin", "trading", "charting"],
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", url: "/", siteName: "skech" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, site: "@skechtrade", creator: "@skechtrade" },
  // og:image and the icon come from src/app/opengraph-image.tsx and
  // src/app/icon.png, the landing's artwork.
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0c0c" },
  ],
  colorScheme: "light dark",
};

/* Runs before paint so the stored theme is the first one painted. */
const THEME_BOOT = `(function(){try{var t=localStorage.getItem("theme");var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html className={`h-full ${inter.variable} ${mono.variable} antialiased`} lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: must run before paint */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground text-sm">
        <ToastProvider position="top-right">
          <TooltipProvider delay={300}>{children}</TooltipProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
