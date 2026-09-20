import { Lighter, type MarketInfo, TX } from "./lighter";
import { type Signed, Signer } from "./signer";

/**
 * A round, as the venue sees it: one position, opened at the start, reversed
 * at every turn the line takes, closed when the clock runs out.
 *
 * The drawn shape is compiled to legs by the same code the browser uses, so
 * the client cannot lie about what it drew; this only turns legs into orders.
 */

export type Leg = { dir: 1 | -1 };

/** Round a size down to the market's step, the way the venue will. */
export const sizeStep = (m: MarketInfo, btc: number) => Math.floor(btc * 10 ** m.sizeDecimals) / 10 ** m.sizeDecimals;
/** The integer the venue actually receives. */
export const sizeUnits = (m: MarketInfo, btc: number) => BigInt(Math.round(sizeStep(m, btc) * 10 ** m.sizeDecimals));
export const priceUnits = (m: MarketInfo, usd: number) => Math.round(usd * 10 ** m.priceDecimals);

/** Whether the venue would take an order of this size at this price. */
export const tradeable = (m: MarketInfo, btc: number, price: number) => sizeStep(m, btc) >= m.minBase && sizeStep(m, btc) * price >= m.minQuote;

export type Ticket = { stake: number; leverage: number; marketId: number };

export class Trader {
  constructor(
    private readonly venue: Lighter,
    private readonly signer: Signer,
    private readonly accountIndex: number | bigint,
  ) {}

  /** Send a signed thing and hand back the venue's hash. */
  private async send(tx: Signed, type: number) {
    return this.venue.send(type, tx.txInfo);
  }

  /** Isolated margin at the round's leverage. A signed transaction, so do it once, not per order. */
  async setLeverage(marketId: number, leverage: number) {
    return this.send(this.signer.updateLeverage(marketId, leverage), TX.updateLeverage);
  }

  /**
   * Take the position to `want` BTC, signed as one order for the difference.
   * A reversal is one order on this venue, not a close and an open.
   */
  async goTo(m: MarketInfo, want: number, slippage = 0.01, clientOrderIndex = BigInt(Date.now() % 2 ** 31)) {
    const have = (await this.venue.positionIn(this.accountIndex, m.id))?.size ?? 0;
    const delta = sizeStep(m, Math.abs(want - have)) * Math.sign(want - have);
    if (delta === 0) return null;
    const isAsk = delta < 0;
    const mark = (await this.venue.market(m.id)).last;
    if (!tradeable(m, Math.abs(delta), mark)) return null;
    const worst = priceUnits(m, mark * (isAsk ? 1 - slippage : 1 + slippage));
    const tx = this.signer.createOrder({
      marketIndex: m.id,
      clientOrderIndex,
      baseAmount: sizeUnits(m, Math.abs(delta)),
      price: worst,
      isAsk,
      reduceOnly: want === 0,
    });
    return this.send(tx, TX.createOrder);
  }

  /** The size a round opens at: the stake, boosted, in BTC at the mark. */
  sizeFor(t: Ticket, mark: number) {
    return (t.stake * t.leverage) / mark;
  }

  /** Close whatever is open, reduce-only so it can never flip by accident. */
  async flatten(m: MarketInfo) {
    return this.goTo(m, 0);
  }
}
