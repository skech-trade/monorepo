import { type Pt, SAMPLES, type Shape, shapeOf } from "@skech/core/shape";
import type { Lighter, MarketInfo } from "./lighter";
import type { Trader } from "./round";

/**
 * A drawn round, run against the venue.
 *
 * The page sends the points it drew and nothing else. The shape, the legs and
 * therefore every order come from `@skech/core`, the same code the page quotes
 * with, so a client cannot claim it drew something it did not.
 *
 * The line is a target position over time, not a single trade. Every tick the
 * runner asks where the line is going at this moment and takes the position
 * there. `goTo` reads what is actually held before it sends anything, so a
 * missed tick, a rejected order or a partial fill all correct themselves on
 * the next one rather than compounding.
 */

export type RoundSpec = {
  pts: Pt[];
  stake: number;
  leverage: number;
  seconds: number;
  exits: { lose: number | null; gain: number | null };
};

export type Outcome = "time" | "stop" | "target" | "failed";

export type Round = {
  id: string;
  status: "running" | "done";
  outcome: Outcome | null;
  /** The mark when the round opened. Everything is measured from here. */
  entry: number;
  stake: number;
  leverage: number;
  seconds: number;
  startedAt: number;
  /** Collateral when the round opened, so realised is a difference the venue agrees with. */
  openedWith: number;
  /** The Lighter account this round traded on: the drawer's own. */
  accountIndex: number;
  /** Which way the position faces now, and how big, from the venue. */
  size: number;
  /** The venue's own mark-to-market on what is open. */
  unrealised: number;
  /**
   * What the round actually made, from the account's own collateral before
   * and after. Not our arithmetic over fills: the venue's figure includes
   * every fee and every bit of slippage, and it is the number the money is.
   */
  realised: number;
  /** Every order this round sent, in order. */
  orders: { at: number; want: number; hash: string }[];
  problem: string | null;
};

/** How often the runner reconsiders the position. A bar on the chart is a second. */
const TICK_MS = 1000;

/**
 * How long to let the venue book a fill before topping up towards a target.
 *
 * The venue takes a second or two to show an order as a position. The runner
 * asked every second, saw the old position, and sent the same order again, so
 * one target of 0.012 BTC became 0.17 held: every order passed the size cap on
 * its own and the pile did not.
 *
 * A reversal still goes out at once, because that is the drawing changing its
 * mind and waiting on it means trading the wrong way for another second. It is
 * only topping up in the direction already held that waits.
 */
const SETTLE_MS = 3000;

/** Where the line is at this moment, as one of the shape's samples. */
export function dirAt(shape: Shape, u: number): 1 | -1 {
  const i = Math.min(SAMPLES - 1, Math.max(0, Math.round(u * (SAMPLES - 1))));
  /*
    Between turns, not at them: the leg covering this sample says which way
    the position faces. Past the last leg the round is winding down, so it
    holds whatever the last leg asked for rather than flipping on the way out.
  */
  for (const leg of shape.legs) if (i >= leg.from && i <= leg.to) return leg.dir;
  const last = shape.legs.at(-1);
  return last ? last.dir : shape.long ? 1 : -1;
}

/** Who a round trades as: their account, and the key that speaks for it. */
export type Who = { trader: Trader; accountIndex: number };

export class Rounds {
  private readonly live = new Map<string, Round>();
  /** Which account each round is on, so finishing one closes the right position. */
  private readonly whose = new Map<string, Who>();

  constructor(
    private readonly venue: Lighter,
    private readonly marketId: number,
  ) {}

  get(id: string): Round | null {
    return this.live.get(id) ?? null;
  }

  /** Every round this process has run, newest first. Memory only, for now. */
  all(): Round[] {
    return [...this.live.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Open a round and return as soon as it is open, not when it ends.
   *
   * A round outlives the tab that drew it. Holding the request open for the
   * length of one would mean a closed laptop leaves a position running with
   * nobody watching it, which is the whole reason this is a server.
   */
  async open(spec: RoundSpec, who: Who): Promise<Round> {
    const market = await this.venue.market(this.marketId);
    const entry = market.last;
    const shape = shapeOf(spec.pts, entry);
    if (!shape) throw new Error("a line needs at least two points");
    if (shape.flat) throw new Error("that line does not say anything to trade");

    const id = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const round: Round = {
      id,
      status: "running",
      outcome: null,
      entry,
      stake: spec.stake,
      leverage: spec.leverage,
      seconds: spec.seconds,
      startedAt: Date.now(),
      accountIndex: who.accountIndex,
      openedWith: (await this.venue.account(who.accountIndex).catch(() => null))?.collateral ?? 0,
      size: 0,
      unrealised: 0,
      realised: 0,
      orders: [],
      problem: null,
    };
    this.live.set(id, round);
    this.whose.set(id, who);

    // Isolated margin at this round's boost, once, before any order.
    await who.trader.setLeverage(this.marketId, spec.leverage).catch((e) => {
      round.problem = `leverage: ${(e as Error).message.slice(0, 120)}`;
    });

    void this.run(round, shape, market, spec, who);
    return round;
  }

  /** Close a round early, at the reader's request. */
  async close(id: string): Promise<Round | null> {
    const round = this.live.get(id);
    const who = this.whose.get(id);
    if (!round || !who || round.status === "done") return round ?? null;
    round.outcome = "time";
    await this.finish(round, await this.venue.market(this.marketId), who);
    return round;
  }

  private async finish(round: Round, market: MarketInfo, who: Who, cap?: number) {
    const flat = await who.trader.flatten(market, cap).catch(() => null);
    if (flat) round.orders.push({ at: Date.now(), want: 0, hash: flat.hash });

    /*
      The venue books a fill a moment after it accepts the order, so reading
      the position straight back showed the round still holding what it had
      just closed. It is asked again until it agrees the position is gone, or
      until it has had five seconds to.
    */
    let after = null;
    for (let i = 0; i < 5; i++) {
      await Bun.sleep(1000);
      after = await this.venue.positionIn(who.accountIndex, this.marketId).catch(() => null);
      if (!after || after.size === 0) break;
    }
    round.size = after?.size ?? 0;
    round.unrealised = after?.unrealised ?? 0;
    const account = await this.venue.account(who.accountIndex).catch(() => null);
    if (account && round.openedWith) round.realised = account.collateral - round.openedWith;
    round.status = "done";
    if (!round.outcome) round.outcome = "time";
    // A position that survived the close is the one thing worth shouting about.
    if (round.size !== 0) round.problem = `still holding ${round.size.toFixed(5)} BTC after the close`;
  }

  private async run(round: Round, shape: Shape, market: MarketInfo, spec: RoundSpec, who: Who) {
    const full = (spec.stake * spec.leverage) / round.entry;
    const ends = round.startedAt + spec.seconds * 1000;

    try {
      /** What was last asked for, and when, so nothing is asked twice while it settles. */
      let asked: number | null = null;
      let askedAt = 0;

      while (Date.now() < ends && round.status === "running") {
        const u = (Date.now() - round.startedAt) / (spec.seconds * 1000);
        const want = dirAt(shape, u) * full;
        const turning = asked === null || Math.sign(want) !== Math.sign(asked);

        if (turning || Date.now() - askedAt > SETTLE_MS) {
          const sent = await who.trader.goTo(market, want, { cap: full }).catch((e) => {
            round.problem = (e as Error).message.slice(0, 160);
            return null;
          });
          asked = want;
          askedAt = Date.now();
          if (sent) round.orders.push({ at: Date.now(), want, hash: sent.hash });
        }

        const held = await this.venue.positionIn(who.accountIndex, this.marketId).catch(() => null);
        round.size = held?.size ?? 0;
        round.unrealised = held?.unrealised ?? 0;

        /*
          Whatever the reason, a position past twice the round's size is not
          this round doing what it was asked, so it stops rather than trading
          its way further into it.
        */
        if (Math.abs(round.size) > full * 2 + market.minBase) {
          round.problem = `held ${round.size.toFixed(5)} BTC against a target of ${full.toFixed(5)}`;
          round.outcome = "failed";
          break;
        }

        /*
          The exits are in dollars of the stake, because that is the sentence
          somebody can check: "close it if I lose fifty". They are watched here
          rather than placed as trigger orders, which is the next thing: a
          trigger survives this process dying and a loop does not.
        */
        if (spec.exits.lose !== null && round.unrealised <= -Math.abs(spec.exits.lose)) {
          round.outcome = "stop";
          break;
        }
        if (spec.exits.gain !== null && round.unrealised >= Math.abs(spec.exits.gain)) {
          round.outcome = "target";
          break;
        }
        await Bun.sleep(TICK_MS);
      }
      await this.finish(round, market, who, full);
    } catch (e) {
      round.problem = (e as Error).message.slice(0, 160);
      round.outcome = "failed";
      // Whatever went wrong, do not leave a position open behind it.
      await this.finish(round, market, who, full).catch(() => undefined);
    }
  }
}
