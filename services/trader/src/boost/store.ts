import { SQL } from "bun";
import type { Settlement } from "./money";

/**
 * Boost's books, in Postgres.
 *
 * A double-entry ledger in micro-USDC: every movement is two rows that sum to
 * zero, and every movement carries a `ref` that is unique per account, so a
 * step retried after a crash books nothing twice. The accounts are:
 *
 *   user:<address>   a user's Boost balance
 *   hold:<boost id>  a round's stake and boost while it runs
 *   treasury         skech's own money, which boosts come out of
 *   fees             the 30% and the 1%, skech's income
 *   venue            the outside world: deposits in, withdrawals out, and a
 *                    round's profit or loss as the venue booked it
 *
 * Summed, everything but `venue` is what the treasury's accounts on Lighter
 * should hold, which is what the reconciliation checks.
 */

export type BoostStatus = "reserved" | "funding" | "running" | "settling" | "done" | "refunded";
export const OPEN: BoostStatus[] = ["reserved", "funding", "running", "settling"];

export type BoostRow = {
  id: string;
  address: string;
  accountIndex: number;
  market: string;
  lane: number;
  stake: bigint;
  boost: bigint;
  roundId: string | null;
  status: BoostStatus;
  problem: string | null;
  equity: bigint | null;
  userOut: bigint | null;
  fee: bigint | null;
  cut: bigint | null;
  gap: bigint | null;
  /** What the lane held when the round leased it: skech's float, of which the round trades stake plus boost. */
  laneBefore: bigint | null;
  createdAt: number;
};

type Tx = SQL;

const big = (v: unknown) => (v === null || v === undefined ? null : BigInt(v as string | number | bigint));
const rowOf = (r: Record<string, unknown>): BoostRow => ({
  id: String(r.id),
  address: String(r.address),
  accountIndex: Number(r.account_index),
  market: String(r.market),
  lane: Number(r.lane),
  stake: BigInt(r.stake as string),
  boost: BigInt(r.boost as string),
  roundId: (r.round_id as string | null) ?? null,
  status: r.status as BoostStatus,
  problem: (r.problem as string | null) ?? null,
  equity: big(r.equity),
  userOut: big(r.user_out),
  fee: big(r.fee),
  cut: big(r.cut),
  gap: big(r.gap),
  laneBefore: big(r.lane_before),
  createdAt: new Date(r.created_at as string).getTime(),
});

export const userAccount = (address: string) => `user:${address.toLowerCase()}`;
const hold = (id: string) => `hold:${id}`;

export class BoostStore {
  private readonly sql: SQL | null;

  constructor(
    private readonly network: string,
    url = process.env.DATABASE_URL ?? "",
  ) {
    this.sql = url ? new SQL({ url, max: 4, idleTimeout: 30 }) : null;
  }

  get available() {
    return this.sql !== null;
  }

  private db() {
    if (!this.sql) throw Error("Boost needs a database: set DATABASE_URL.");
    return this.sql;
  }

  async ready() {
    const sql = this.db();
    await sql`CREATE TABLE IF NOT EXISTS boost_ledger (
      id bigserial PRIMARY KEY, network text NOT NULL, account text NOT NULL, amount bigint NOT NULL,
      kind text NOT NULL, round_id text, ref text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE INDEX IF NOT EXISTS boost_ledger_by_account ON boost_ledger (network, account)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS boost_ledger_once ON boost_ledger (network, ref, account)`;
    await sql`CREATE TABLE IF NOT EXISTS boost_rounds (
      id text PRIMARY KEY, network text NOT NULL, address text NOT NULL, account_index bigint NOT NULL, market text NOT NULL,
      lane bigint NOT NULL, stake bigint NOT NULL, boost bigint NOT NULL, round_id text, status text NOT NULL, problem text,
      equity bigint, user_out bigint, fee bigint, cut bigint, gap bigint,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS boost_one_open_per_user ON boost_rounds (network, address) WHERE status IN ('reserved', 'funding', 'running', 'settling')`;
    await sql`CREATE TABLE IF NOT EXISTS boost_lanes (network text NOT NULL, account_index bigint NOT NULL, boost_id text, leased_at timestamptz, PRIMARY KEY (network, account_index))`;
    // A lane's balance is known only while it is free: set when it is topped back up to its float, cleared when it is leased.
    await sql`ALTER TABLE boost_lanes ADD COLUMN IF NOT EXISTS balance bigint`;
    await sql`ALTER TABLE boost_rounds ADD COLUMN IF NOT EXISTS lane_before bigint`;
    await sql`CREATE TABLE IF NOT EXISTS boost_state (network text PRIMARY KEY, killed boolean NOT NULL DEFAULT false, reason text, updated_at timestamptz NOT NULL DEFAULT now())`;
  }

  /** The lanes the environment names, and only those. A lane dropped from the list is never leased again. */
  async syncLanes(lanes: number[]) {
    const sql = this.db();
    for (const lane of lanes) await sql`INSERT INTO boost_lanes (network, account_index) VALUES (${this.network}, ${lane}) ON CONFLICT DO NOTHING`;
  }

  // --- the ledger -----------------------------------------------------------

  /** One movement: two rows, summing to zero. Booked once per `ref`, however often it is asked. */
  private async move(tx: Tx, from: string, to: string, amount: bigint, kind: string, ref: string, roundId: string | null = null): Promise<void> {
    if (amount === 0n) return;
    if (amount < 0n) return this.move(tx, to, from, -amount, kind, ref, roundId);
    await tx`INSERT INTO boost_ledger (network, account, amount, kind, round_id, ref) VALUES
      (${this.network}, ${from}, ${-amount}, ${kind}, ${roundId}, ${ref}),
      (${this.network}, ${to}, ${amount}, ${kind}, ${roundId}, ${ref})
      ON CONFLICT (network, ref, account) DO NOTHING`;
  }

  private async sum(tx: Tx, account: string): Promise<bigint> {
    const [r] = await tx`SELECT COALESCE(SUM(amount), 0)::text AS s FROM boost_ledger WHERE network = ${this.network} AND account = ${account}`;
    return BigInt(r.s);
  }

  balance(account: string) {
    return this.sum(this.db(), account);
  }

  /** Every account's balance, for the reconciliation and the admin view. */
  async totals(): Promise<{ users: bigint; holds: bigint; treasury: bigint; fees: bigint; venue: bigint }> {
    const rows = await this.db()`SELECT CASE WHEN account LIKE 'user:%' THEN 'users' WHEN account LIKE 'hold:%' THEN 'holds' ELSE account END AS k, SUM(amount)::text AS s
      FROM boost_ledger WHERE network = ${this.network} GROUP BY 1`;
    const out = { users: 0n, holds: 0n, treasury: 0n, fees: 0n, venue: 0n } as Record<string, bigint>;
    for (const r of rows) out[r.k] = BigInt(r.s);
    return out as { users: bigint; holds: bigint; treasury: bigint; fees: bigint; venue: bigint };
  }

  /** What the treasury started with, booked once: skech's own money on the venue. */
  async seed(amount: bigint) {
    const sql = this.db();
    await sql.begin(async (tx) => this.move(tx as unknown as Tx, "venue", "treasury", amount, "seed", "seed"));
  }

  async seeded(): Promise<boolean> {
    const [r] = await this.db()`SELECT 1 FROM boost_ledger WHERE network = ${this.network} AND ref = 'seed' LIMIT 1`;
    return !!r;
  }

  /** Money that arrived from a user's own Lighter account. */
  credit(address: string, amount: bigint, ref: string) {
    return this.db().begin(async (tx) => this.move(tx as unknown as Tx, "venue", userAccount(address), amount, "deposit", ref));
  }

  /**
   * Take money out of a Boost balance before sending it, so two withdrawals
   * cannot both spend it. Undone with `unwithdraw` if the transfer fails.
   */
  async withdraw(address: string, amount: bigint, ref: string): Promise<boolean> {
    return this.db().begin(async (t) => {
      const tx = t as unknown as Tx;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`boost:${this.network}`}))`;
      const [open] = await tx`SELECT 1 FROM boost_rounds WHERE network = ${this.network} AND address = ${address.toLowerCase()} AND status IN ('reserved', 'funding', 'running', 'settling') LIMIT 1`;
      if (open) throw Error("Wait for your Boost round to finish before taking money out.");
      if ((await this.sum(tx, userAccount(address))) < amount) return false;
      await this.move(tx, userAccount(address), "venue", amount, "withdraw", ref);
      return true;
    });
  }

  unwithdraw(address: string, amount: bigint, ref: string) {
    return this.db().begin(async (tx) => this.move(tx as unknown as Tx, "venue", userAccount(address), amount, "withdraw-undone", `${ref}:undo`));
  }

  // --- rounds ---------------------------------------------------------------

  /**
   * Hold a stake and a boost for a new round, and lease it a lane, in one
   * transaction under one lock. Every check that protects money is in here:
   * the user has the stake, the treasury has the boost, the boost out in open
   * rounds stays under the cap, the user has nothing else running, and the
   * lane is nobody else's and already holds enough to trade both.
   *
   * Nothing moves on the venue: the lane already holds skech's float, and the
   * round trades part of it. The ledger says whose part is whose. Answers the
   * lane and what it held, which settling subtracts again.
   */
  async reserve(o: { id: string; address: string; accountIndex: number; market: string; stake: bigint; boost: bigint; cap: bigint }): Promise<{ lane: number; before: bigint }> {
    return this.db().begin(async (t) => {
      const tx = t as unknown as Tx;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`boost:${this.network}`}))`;
      const address = o.address.toLowerCase();
      const [running] = await tx`SELECT 1 FROM boost_rounds WHERE network = ${this.network} AND address = ${address} AND status IN ('reserved', 'funding', 'running', 'settling') LIMIT 1`;
      if (running) throw Error("You already have a Boost round running.");
      if ((await this.sum(tx, userAccount(address))) < o.stake) throw Error("Your money for this round has not reached skech yet. Try again.");
      if ((await this.sum(tx, "treasury")) < o.boost) throw Error("Boost is full right now. Try a smaller amount or again in a minute.");
      const [out] = await tx`SELECT COALESCE(SUM(boost), 0)::text AS s FROM boost_rounds WHERE network = ${this.network} AND status IN ('reserved', 'funding', 'running', 'settling')`;
      if (BigInt(out.s) + o.boost > o.cap) throw Error("Boost is full right now. Try a smaller amount or again in a minute.");
      const need = o.stake + o.boost;
      const [lane] = await tx`SELECT account_index, balance::text AS balance FROM boost_lanes
        WHERE network = ${this.network} AND boost_id IS NULL AND balance IS NOT NULL AND balance >= ${need}
        ORDER BY leased_at NULLS FIRST, account_index LIMIT 1`;
      if (!lane) throw Error("Every Wild lane is busy. Try again in a minute.");
      const laneIndex = Number(lane.account_index);
      const before = BigInt(lane.balance);
      await tx`UPDATE boost_lanes SET boost_id = ${o.id}, leased_at = now(), balance = NULL WHERE network = ${this.network} AND account_index = ${laneIndex}`;
      await tx`INSERT INTO boost_rounds (id, network, address, account_index, market, lane, stake, boost, status, lane_before)
        VALUES (${o.id}, ${this.network}, ${address}, ${o.accountIndex}, ${o.market}, ${laneIndex}, ${o.stake}, ${o.boost}, 'reserved', ${before})`;
      await this.move(tx, userAccount(address), hold(o.id), o.stake, "stake", `stake:${o.id}`, o.id);
      await this.move(tx, "treasury", hold(o.id), o.boost, "boost", `boost:${o.id}`, o.id);
      return { lane: laneIndex, before };
    });
  }

  async update(id: string, patch: { status?: BoostStatus; roundId?: string; problem?: string | null }) {
    const sql = this.db();
    if (patch.status) await sql`UPDATE boost_rounds SET status = ${patch.status}, updated_at = now() WHERE id = ${id}`;
    if (patch.roundId) await sql`UPDATE boost_rounds SET round_id = ${patch.roundId}, updated_at = now() WHERE id = ${id}`;
    if (patch.problem !== undefined) await sql`UPDATE boost_rounds SET problem = ${patch.problem}, updated_at = now() WHERE id = ${id}`;
  }

  /** Nothing traded: the stake back to the user, the boost back to the treasury, the lane free. */
  async refund(id: string, problem: string | null) {
    await this.db().begin(async (t) => {
      const tx = t as unknown as Tx;
      const [r] = await tx`SELECT * FROM boost_rounds WHERE id = ${id} FOR UPDATE`;
      if (!r || r.status === "done" || r.status === "refunded") return;
      const row = rowOf(r);
      await this.move(tx, hold(id), userAccount(row.address), row.stake, "refund", `refund:${id}`, id);
      await this.move(tx, hold(id), "treasury", row.boost, "refund", `refund-boost:${id}`, id);
      await tx`UPDATE boost_rounds SET status = 'refunded', problem = ${problem}, updated_at = now() WHERE id = ${id}`;
    });
  }

  /**
   * Book a finished round. The hold is first made equal to what the lane held
   * (the round's profit or loss comes in from, or goes out to, the venue),
   * then shared out exactly as `settle` said. Idempotent by ref.
   */
  async book(id: string, s: Settlement) {
    await this.db().begin(async (t) => {
      const tx = t as unknown as Tx;
      const [r] = await tx`SELECT * FROM boost_rounds WHERE id = ${id} FOR UPDATE`;
      if (!r || r.status === "done") return;
      const row = rowOf(r);
      await this.move(tx, "venue", hold(id), s.pnl, "pnl", `pnl:${id}`, id);
      await this.move(tx, hold(id), userAccount(row.address), s.user, "payout", `payout:${id}`, id);
      await this.move(tx, hold(id), "fees", s.fee + s.cut, s.cut > 0n ? "cut" : "fee", `income:${id}`, id);
      await this.move(tx, hold(id), "treasury", s.skech - s.fee - s.cut, "boost-back", `boost-back:${id}`, id);
      await tx`UPDATE boost_rounds SET status = 'done', equity = ${s.equity}, user_out = ${s.user}, fee = ${s.fee}, cut = ${s.cut}, gap = ${s.gap}, problem = NULL, updated_at = now() WHERE id = ${id}`;
    });
  }

  /**
   * Lanes that need topping back up to their float before anyone leases them:
   * new ones, and ones whose round is booked. A round's lane stays leased
   * until then, so nobody trades on a lane of unknown size.
   */
  async tendable(): Promise<number[]> {
    const rows = await this.db()`SELECT l.account_index FROM boost_lanes l
      WHERE l.network = ${this.network} AND (
        (l.boost_id IS NULL AND l.balance IS NULL)
        OR l.boost_id IN (SELECT id FROM boost_rounds WHERE network = ${this.network} AND status IN ('done', 'refunded')))
      ORDER BY l.account_index`;
    return rows.map((r: Record<string, unknown>) => Number(r.account_index));
  }

  /**
   * Take a free lane off the market so it can be brought to a new float: it
   * cannot be leased while its balance is unknown. False if it was leased or
   * already off.
   */
  async retire(lane: number): Promise<boolean> {
    const rows = await this.db()`UPDATE boost_lanes SET balance = NULL
      WHERE network = ${this.network} AND account_index = ${lane} AND boost_id IS NULL AND balance IS NOT NULL RETURNING account_index`;
    return rows.length > 0;
  }

  /** A lane topped up and flat: free again, holding `balance`. Never frees a lane whose round is still open. */
  async release(lane: number, balance: bigint) {
    await this.db()`UPDATE boost_lanes SET boost_id = NULL, balance = ${balance}
      WHERE network = ${this.network} AND account_index = ${lane}
        AND (boost_id IS NULL OR boost_id IN (SELECT id FROM boost_rounds WHERE network = ${this.network} AND status IN ('done', 'refunded')))`;
  }

  async get(id: string): Promise<BoostRow | null> {
    const [r] = await this.db()`SELECT * FROM boost_rounds WHERE id = ${id}`;
    return r ? rowOf(r) : null;
  }

  async byRound(roundId: string): Promise<BoostRow | null> {
    const [r] = await this.db()`SELECT * FROM boost_rounds WHERE network = ${this.network} AND round_id = ${roundId}`;
    return r ? rowOf(r) : null;
  }

  async openFor(address: string): Promise<BoostRow | null> {
    const [r] = await this.db()`SELECT * FROM boost_rounds WHERE network = ${this.network} AND address = ${address.toLowerCase()} AND status IN ('reserved', 'funding', 'running', 'settling') LIMIT 1`;
    return r ? rowOf(r) : null;
  }

  async unfinished(): Promise<BoostRow[]> {
    const rows = await this.db()`SELECT * FROM boost_rounds WHERE network = ${this.network} AND status IN ('reserved', 'funding', 'running', 'settling') ORDER BY created_at`;
    return rows.map(rowOf);
  }

  async recent(address: string, limit = 20): Promise<BoostRow[]> {
    const rows = await this.db()`SELECT * FROM boost_rounds WHERE network = ${this.network} AND address = ${address.toLowerCase()} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map(rowOf);
  }

  /**
   * Wallets with money on skech's side, no round open, and nothing moved for
   * `seconds`: the ones whose money should go home.
   */
  async idle(seconds: number): Promise<{ address: string; amount: bigint }[]> {
    const rows = await this.db()`
      SELECT l.account, SUM(l.amount)::text AS s FROM boost_ledger l
      WHERE l.network = ${this.network} AND l.account LIKE 'user:%'
      GROUP BY l.account
      HAVING SUM(l.amount) > 0 AND MAX(l.created_at) < now() - make_interval(secs => ${seconds})
        AND NOT EXISTS (SELECT 1 FROM boost_rounds r WHERE r.network = ${this.network} AND 'user:' || r.address = l.account AND r.status IN ('reserved', 'funding', 'running', 'settling'))`;
    return rows.map((r: Record<string, unknown>) => ({ address: String(r.account).slice(5), amount: BigInt(r.s as string) }));
  }

  async outstanding(): Promise<bigint> {
    const [r] = await this.db()`SELECT COALESCE(SUM(boost), 0)::text AS s FROM boost_rounds WHERE network = ${this.network} AND status IN ('reserved', 'funding', 'running', 'settling')`;
    return BigInt(r.s);
  }

  async lanes(): Promise<{ lane: number; boostId: string | null; balance: bigint | null }[]> {
    const rows = await this.db()`SELECT account_index, boost_id, balance::text AS balance FROM boost_lanes WHERE network = ${this.network} ORDER BY account_index`;
    return rows.map((r: Record<string, unknown>) => ({ lane: Number(r.account_index), boostId: (r.boost_id as string | null) ?? null, balance: big(r.balance) }));
  }

  // --- the switch -----------------------------------------------------------

  async killed(): Promise<{ killed: boolean; reason: string | null }> {
    const [r] = await this.db()`SELECT killed, reason FROM boost_state WHERE network = ${this.network}`;
    return { killed: !!r?.killed, reason: (r?.reason as string | null) ?? null };
  }

  async setKilled(killed: boolean, reason: string | null) {
    await this.db()`INSERT INTO boost_state (network, killed, reason) VALUES (${this.network}, ${killed}, ${reason})
      ON CONFLICT (network) DO UPDATE SET killed = EXCLUDED.killed, reason = EXCLUDED.reason, updated_at = now()`;
  }
}
