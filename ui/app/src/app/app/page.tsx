import { redirect } from "next/navigation";
import { DEFAULT_MARKET } from "@/lib/market";

/** One market for now, so `/app` is the market rather than a list of one. */
export default function AppIndex() {
  redirect(`/app/${DEFAULT_MARKET}`);
}
