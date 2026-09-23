import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { marketFor } from "@/lib/market";
import { Terminal } from "@/components/app/terminal";

/**
 * The trading screen, at `/app/<token address>`.
 *
 * The address is the route, so a link pasted from a block explorer opens the
 * market. Bitcoin and Ethereum are listed, and an address that is neither is
 * a 404 rather than a generated placeholder: inventing a ticker and a price
 * for an unknown token would make it look like a market we run.
 */

type Props = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const market = marketFor(token);
  if (!market) return { title: "Not found" };
  return {
    title: market.name,
    description: `Trade ${market.name} on skech.`,
  };
}

export default async function TokenPage({ params }: Props) {
  const { token } = await params;
  const market = marketFor(token);
  if (!market) notFound();

  // Keyed by market, so switching one starts a fresh chart, feed and drawing rather than carrying the last.
  return <Terminal key={market.address} market={market} />;
}
