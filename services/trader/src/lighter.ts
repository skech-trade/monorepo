import type { Fill } from "./pnl";

/** Lighter's REST surface, only the parts a round needs. */

export type MarketInfo = { id: number; symbol: string; sizeDecimals: number; priceDecimals: number; minBase: number; minQuote: number; last: number };
export type PositionInfo = { marketId: number; size: number; avgEntry: number; value: number; unrealised: number };

/** A venue number, which arrives as a string or a number. Anything unreadable is `fallback`. */
export const asNum = (v: unknown, fallback = 0) => {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};

export class Lighter {
  constructor(private readonly base: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(10000) });
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
    const a = d.accounts?.[0];
    if (!a || !Number.isFinite(Number(a.collateral))) throw Error("Account data unavailable");
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

  /** The Lighter account a wallet owns, or null if it has never had one. */
  async accountForAddress(l1: string): Promise<number | null> {
    const d = await this.get<{ sub_accounts?: { index: number }[] }>(`/api/v1/accountsByL1Address?l1_address=${l1}`).catch(() => null);
    const first = d?.sub_accounts?.[0];
    return first ? Number(first.index) : null;
  }

  async positionIn(index: number | bigint, marketId: number): Promise<PositionInfo | null> {
    return (await this.account(index)).positions.find((p) => p.marketId === marketId) ?? null;
  }

  /** The wallet that owns a Lighter account. */
  async addressForAccount(index: number) {
    const data = await this.get<{ accounts: { l1_address: string }[] }>(`/api/v1/account?by=index&value=${index}`);
    const address = data.accounts?.[0]?.l1_address;
    if (!address) throw Error("Account unavailable");
    return address;
  }

  /** This account's fills on one market, newest first, paged back until they are older than `since`. */
  async fills(index: number, market: number, authorization: string, since: number): Promise<Fill[]> {
    const all: Fill[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ account_index: String(index), market_id: String(market), sort_by: "timestamp", sort_dir: "desc", limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${this.base}/api/v1/trades?${query}`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(10000) });
      const data = (await response.json()) as { code: number; trades?: Fill[]; next_cursor?: string };
      if (!response.ok || data.code !== 200 || !Array.isArray(data.trades)) throw Error("Fill history unavailable");
      all.push(...data.trades);
      if (!data.next_cursor || !data.trades.length || data.trades.at(-1)!.timestamp < since) return all;
      cursor = data.next_cursor;
    }
    throw Error("Fill history incomplete; reconciliation pending");
  }

  /** The nonce the venue expects next from this key. Read once, then counted locally. */
  async nextNonce(account: number, apiKeyIndex: number): Promise<bigint> {
    const d = await this.get<{ nonce?: number }>(`/api/v1/nextNonce?account_index=${account}&api_key_index=${apiKeyIndex}`);
    if (typeof d.nonce !== "number") throw Error("nonce unavailable");
    return BigInt(d.nonce);
  }

  /** The HTTP fallback for a batch, for when the socket is down. Same formats as the socket. */
  async sendBatch(txTypes: number[], txInfos: string[]): Promise<{ hashes: string[] }> {
    const body = new URLSearchParams({ tx_types: JSON.stringify(txTypes), tx_infos: JSON.stringify(txInfos) });
    const res = await fetch(`${this.base}/api/v1/sendTxBatch`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    const out = JSON.parse(text || "{}") as { code?: number; message?: string; tx_hash?: string[] };
    if (!res.ok || (out.code !== undefined && out.code !== 200)) throw Object.assign(new Error(`lighter sendTxBatch: ${out.code ?? res.status} ${out.message ?? text.slice(0, 160)}`), { code: out.code ?? null });
    return { hashes: out.tx_hash ?? [] };
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
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    const out = JSON.parse(text || "{}") as { code?: number; message?: string; tx_hash?: string };
    if (!res.ok || (out.code !== undefined && out.code !== 200)) throw Object.assign(new Error(`lighter sendTx: ${out.code ?? res.status} ${out.message ?? text.slice(0, 200)}`), { code: out.code ?? null });
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
