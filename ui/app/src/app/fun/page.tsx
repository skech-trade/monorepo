import type { Metadata, Viewport } from "next";
import { FunShell } from "@/components/app/ink/fun-shell";

/** skech's game: draw ahead of the Bitcoin price, and the ink it runs through pays. Practice money, no sign-in. */

export const metadata: Metadata = {
  title: "Draw",
  description: "Draw ahead of the Bitcoin price. The ink it runs through pays.",
};

/* Drawing gestures are scoped to the canvas; the surrounding UI remains zoomable. */
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

/*
  Rendered per request, as the trading page is: the app bar in it reads the
  signed-in wallet, and that exists only with the wallet's provider running,
  which a page built ahead of time does not have.
*/
export const dynamic = "force-dynamic";

export default function FunPage() {
  return <FunShell />;
}
