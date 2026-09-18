import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

/*
 * One face: Inter, everywhere, same as the landing.
 *
 * It carries the figures too. A trading screen is mostly numbers, and Inter has
 * real tabular figures, so `font-variant-numeric: tabular-nums` — the `figures`
 * utility — holds a column of prices still while it ticks. That is the only
 * thing a monospace was ever needed for here, and a second face would mean a
 * second set of metrics to keep in agreement with the first.
 */
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
  // Inter's optical size axis, so large text gets the tighter drawing and small
  // text keeps its open apertures. The type scale leans on this:
  // `font-optical-sizing: auto` has nothing to act on without the axis present.
  axes: ["opsz"],
});

export const metadata: Metadata = {
  title: "skech",
  description: "Draw where you think the price is going.",
  applicationName: "skech",
};

export const viewport: Viewport = {
  themeColor: "#eeeae3",
  colorScheme: "light",
};

/*
 * Paper, like the landing.
 *
 * Dark mode is defined in globals.css and deliberately not switched on: the
 * landing has it held back too, and a product whose marketing page is warm
 * paper and whose app is a black terminal is two products. The tokens are
 * there, so turning it on later is a class on <html> and a toggle, not a
 * rewrite.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html className={`h-full ${inter.variable} antialiased`} lang="en">
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        <ToastProvider position="bottom-right">
          <TooltipProvider delay={300}>{children}</TooltipProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
