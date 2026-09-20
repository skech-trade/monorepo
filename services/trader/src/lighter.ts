/** Lighter's REST surface, only the parts a round needs. */

export type MarketInfo = { id: number; symbol: string; sizeDecimals: number; priceDecimals: number; minBase: number; minQuote: number; last: number };
export type PositionInfo = { marketId: number; size: number; avgEntry: number; value: number; unrealised: number };

const asNum = (v: unknown, fallback = 0) => {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};

export class Lighter {
  constructor(private readonly base: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) throw new Error(`lighter ${path}: ${res.status} ${(await res.text()).slice(0, 160)}`);
    return (await res.json()) as T;
  }

  /** Every market the venue lists, with the constraints an order has to satisfy. */
  async markets(): Promise<MarketInfo[]> {
    const d = await this.get<{ order_book_details: Record<string, unknown>[] }>("/api/v1/orderBookDetails");
    return d.order_book_details.map((m) => ({
      id: Number(m.market_id),
      symbol: String(m.symbol),
      sizeDecimals: Number(m.supported_size_decimals),
      priceDecimals: Number(m.supported_price_decimals),
      minBase: asNum(m.min_base_amount),
      minQuote: asNum(m.min_quote_amount),
      last: asNum(m.last_trade_price),
    }));
  }

  async market(id: number): Promise<MarketInfo> {
    const found = (await this.markets()).find((m) => m.id === id);
    if (!found) throw new Error(`lighter: no market ${id}`);
    return found;
  }

  async account(index: number | bigint): Promise<{ collateral: number; positions: PositionInfo[] }> {
    const d = await this.get<{ accounts: Record<string, unknown>[] }>(`/api/v1/account?by=index&value=${index}`);
    const a = d.accounts?.[0] ?? {};
    const raw = (a.positions ?? []) as Record<string, unknown>[];
    return {
      collateral: asNum(a.collateral),
      positions: raw
        .map((p) => ({
          marketId: Number(p.market_id),
          /*
            Lighter reports the size and its direction in two fields: a short
            of 3.565 BTC comes back as `position: "3.56500"` with `sign: -1`.
            Reading only the first made every short look like a long, so
            `goTo` saw a position the opposite way round from the one it held
            and sold the difference again on every tick. It took a testnet
            account from flat to 3.565 BTC short in twelve seconds.
          */
          size: asNum(p.position) * (Number(p.sign) < 0 ? -1 : 1),
          avgEntry: asNum(p.avg_entry_price),
          value: asNum(p.position_value),
          unrealised: asNum(p.unrealized_pnl),
        }))
        .filter((p) => p.size !== 0),
    };
  }

  async positionIn(index: number | bigint, marketId: number): Promise<PositionInfo | null> {
    return (await this.account(index)).positions.find((p) => p.marketId === marketId) ?? null;
  }

  /**
   * Send a signed transaction. `txInfo` is what the signer produced; the type
   * says which transaction it is, and 14 is an order.
   */
  async send(txType: number, txInfo: string): Promise<{ hash: string }> {
    const body = new URLSearchParams({ tx_type: String(txType), tx_info: txInfo });
    const res = await fetch(`${this.base}/api/v1/sendTx`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`lighter sendTx: ${res.status} ${text.slice(0, 200)}`);
    const out = JSON.parse(text) as { code?: number; message?: string; tx_hash?: string };
    if (out.code !== undefined && out.code !== 200) throw new Error(`lighter sendTx: ${out.code} ${out.message ?? ""}`);
    return { hash: out.tx_hash ?? "" };
  }
}

/** Transaction types, as the venue numbers them. */
/*
  The venue's own numbers. `updateLeverage` was 23, which testnet answers with
  "unsupported tx type"; it is 20, and the way to tell is that 20 rejects an
  empty body with "invalid initial margin fraction", meaning it parsed it as
  an update-leverage transaction, and every other number nearby does not.
*/
export const TX = { changePubKey: 8, createOrder: 14, cancelOrder: 15, cancelAllOrders: 16, updateLeverage: 20 } as const;
