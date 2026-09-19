import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Terminal } from "@/components/app/terminal";
import { marketFor, positionsFor } from "@/lib/market";

/**
 * The full terminal, at `/app/<token address>/desk`.
 *
 * Book, tape, ticket and margin, one segment in from the market's own page.
 * It is not offered in the bar: a screen whose pitch is "draw a line" should
 * not open by asking whether you would rather have a professional order entry
 * screen instead. Anyone who wants it can be sent this link, and it is the
 * same screen it always was.
 */

type Props = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const market = marketFor(token);
  if (!market) return { title: "Not found" };
  return { title: `${market.name} desk`, description: `Trade ${market.name} on skech.` };
}

export default async function DeskPage({ params }: Props) {
  const { token } = await params;
  const market = marketFor(token);
  if (!market) notFound();

  return <Terminal market={market} mode="desk" positions={positionsFor(market)} />;
}
