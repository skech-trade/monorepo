import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { AuthProvider } from "@/components/app/auth";
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
const DESCRIPTION = "Draw ahead of the Bitcoin price. The ink it runs through pays.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: TITLE, template: "%s · skech" },
  description: DESCRIPTION,
  applicationName: "skech",
  keywords: ["skech", "draw", "bitcoin", "game", "prediction"],
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

/* Runs before paint, so the stored theme and palette are the first ones painted. */
const THEME_BOOT = `(function(){try{var r=document.documentElement;var t=localStorage.getItem("theme");r.classList.toggle("dark",t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches);var s=JSON.parse(localStorage.getItem("skech:settings")||"{}");r.dataset.palette=s.palette||"classic"}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html className={`h-full ${inter.variable} ${mono.variable} antialiased`} lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: must run before paint */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground text-sm">
        {/*
          Bottom right, not top right.

          The top right is where the screen keeps the thing you press: size,
          leverage, the button that opens a position and the button that closes
          one. A notification landing there covered "Close trade" for as
          long as it stayed up — so the app told you it had opened a trade by
          standing in front of the only control that ends it.
        */}
        <AuthProvider>
          <ToastProvider position="bottom-right">
            <TooltipProvider delay={300}>{children}</TooltipProvider>
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
