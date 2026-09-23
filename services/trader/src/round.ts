import { type Lighter, type MarketInfo, TX } from "./lighter";
import type { Signed, Signer } from "./signer";

/**
 * Order sizes and prices in the venue's units, and the REST path that came
 * before the executor.
 *
 * Rounds trade through `executor.ts` now. `Trader` is kept for `prove.ts`, the
 * by-hand check that a key can open and close a position over plain HTTP.
 */

/** Round a size down to the market's step, the way the venue will. */
export const sizeStep = (m: MarketInfo, btc: number) => Math.floor(btc * 10 ** m.sizeDecimals) / 10 ** m.sizeDecimals;
/** The integer the venue actually receives. */
export const sizeUnits = (m: MarketInfo, btc: number) => BigInt(Math.round(sizeStep(m, btc) * 10 ** m.sizeDecimals));
export const priceUnits = (m: MarketInfo, usd: number) => Math.round(usd * 10 ** m.priceDecimals);

/** Whether the venue would take an order of this size at this price. */
export const tradeable = (m: MarketInfo, btc: number, price: number) => sizeStep(m, btc) >= m.minBase && sizeStep(m, btc) * price >= m.minQuote;

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

  /**
   * Take the position to `want` BTC, signed as one order for the difference.
   * A reversal is one order on this venue, not a close and an open.
   */
  async goTo(m: MarketInfo, want: number, opts: { cap?: number; slippage?: number; clientOrderIndex?: bigint } = {}) {
    const { cap, slippage = 0.01, clientOrderIndex = BigInt(Date.now() % 2 ** 31) } = opts;
    const [position, currentMarket] = await Promise.all([
      this.venue.positionIn(this.accountIndex, m.id),
      this.venue.market(m.id),
    ]);
    const have = position?.size ?? 0;
    const delta = sizeStep(m, Math.abs(want - have)) * Math.sign(want - have);
    if (delta === 0) return null;
    /*
      Nothing this round sends can be larger than going from its full
      position to the opposite one, which is twice its size. The cap comes
      from the round rather than from what is held, so a position read wrong
      cannot raise its own ceiling.

      Not a tidiness rule. Reading a short as a long made `have` the wrong
      sign, so every tick computed a delta twice the position and sent it,
      and a testnet account went from flat to 3.565 BTC short in twelve
      seconds. That was one field misread; the next one will be something
      else, and this is what stops it turning into a runaway either way.
    */
    if (cap !== undefined) {
      const ceiling = Math.abs(cap) * 2 + m.minBase;
      if (Math.abs(delta) > ceiling) {
        throw new Error(`refusing ${delta.toFixed(5)} BTC: this round trades ${Math.abs(cap).toFixed(5)} at most`);
      }
    }
    const isAsk = delta < 0;
    const mark = currentMarket.last;
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

  /** Close whatever is open, reduce-only so it can never flip by accident. */
  async flatten(m: MarketInfo, cap?: number, clientOrderIndex?: bigint) {
    return this.goTo(m, 0, { cap, clientOrderIndex });
  }
}
