/** Venue-reported fill P&L only. Funding an account is never trade profit. */
export type Fill = {
  price?: string;
  size?: string;
  trade_id: number;
  trade_id_str?: string;
  tx_hash: string;
  timestamp: number;
  ask_account_id: number;
  bid_account_id: number;
  ask_id_str?: string;
  bid_id_str?: string;
  ask_id?: number;
  bid_id?: number;
  ask_client_id_str?: string;
  bid_client_id_str?: string;
  ask_client_id?: number;
  bid_client_id?: number;
  ask_account_pnl?: string;
  bid_account_pnl?: string;
};

export type Side = "ask" | "bid";

/** A fill's own id. A fill is pushed once and listed again in the history under the same one. */
export const fillId = (f: Fill) => String(f.trade_id_str ?? f.trade_id);

/** Which side of a fill an account was on, if either. */
export const sideOf = (f: Fill, account: number): Side | null =>
  f.ask_account_id === account ? "ask" : f.bid_account_id === account ? "bid" : null;

/** The client order index that side's order was sent under, or "" when the venue did not say. */
export const clientIdOf = (f: Fill, side: Side) => String(f[`${side}_client_id_str`] ?? f[`${side}_client_id`] ?? "");

export type SentOrder = { hash: string; clientOrderIndex?: string };

export function pnlFromFills(fills: Fill[], orders: SentOrder[], account: number) {
  const hashes = new Set(orders.map((o) => o.hash));
  const clients = new Set(orders.flatMap((o) => (o.clientOrderIndex ? [o.clientOrderIndex] : [])));
  const side = (f: Fill): Side => sideOf(f, account) ?? "bid";
  const own = fills.filter((f) => sideOf(f, account) !== null);
  const orderId = (f: Fill) => String(f[`${side(f)}_id_str`] ?? f[`${side(f)}_id`]);
  // Partial fills can carry a different transaction hash, but retain order identity.
  const ids = new Set(own.filter((f) => hashes.has(f.tx_hash) || clients.has(clientIdOf(f, side(f)))).map(orderId));
  const seen = new Set<string>();
  let realised = 0;
  let count = 0;
  const matched: Fill[] = [];
  for (const f of own) {
    const id = fillId(f);
    if (!ids.has(orderId(f)) || seen.has(id)) continue;
    seen.add(id);
    const raw = f[`${side(f)}_account_pnl`];
    // Missing P&L is zero for an opening fill; it does not book a closed position.
    const value = raw === undefined ? 0 : Number(raw);
    if (!Number.isFinite(value)) throw Error("Invalid venue fill P&L");
    realised += value;
    count++;
    matched.push(f);
  }
  return { realised, count, matched };
}
