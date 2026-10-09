/**
 * The community's Postgres: profiles, avatars, follows, and every piece and settlement the game made, from which the
 * leaderboard, profiles and the live feed are read. One schema, `skech_social`, made at start and closed to
 * Supabase's browser roles; one deployment of the game per database (the scope in `social_meta` says which).
 *
 * Every query is a tagged template: Bun sends each value as a bound parameter, never as text in the statement.
 * Money is NUMERIC, exact; it crosses the API as decimal strings.
 */
import { SQL } from "bun";
import { decodeStroke } from "@skech/core/chain";
import type { Stroke } from "@skech/core/ink";
import { windowStart, type DrawingPiece, type LeaderboardRow, type PlayerProfile, type PlayerStats, type ProfileResponse, type PublicDrawing, type SocialActivity, type SocialWindow } from "@skech/core/social";

export type Section = DrawingPiece["sections"][number];
export type Placement = { betId: string; player: string; drawing: string; openAt: bigint; staked: bigint; unit: bigint; stroke?: string; sections: Section[]; tx: string };
/** `expiredMask`: bands given back because their second can no longer be posted; their refund is in `paid`. */
export type Settlement = { betId: string; player: string; hitMask: number; missMask: number; expiredMask?: number; paid: bigint; owed: bigint; tx: string; at?: number };
export type Avatar = { mime: string; bytes: Uint8Array };

type PieceRow = { id: string; drawing: string; player: string; at: string; updated: string; stake: string; settled_stake: string; paid: string; owed: string; hit_mask: string; miss_mask: string; expired_mask: string; geometry: DrawingPiece | string; tx: string };
type ProfileRow = { player: string; username: string | null; bio: string; joined: string; avatar: boolean; followers: string; following: string };

/** The most players one player may follow: a table nobody can grow without end. */
export const MOST_FOLLOWS = 2_000;

/** A piece's shape as the feed draws it: its stroke when the relayer saw one, else only its sections. */
function geometry(p: Placement): DrawingPiece {
  let stroke: Stroke | null = null;
  if (p.stroke) {
    try {
      const d = decodeStroke(p.stroke as `0x${string}`);
      if (d.rt > 0 && d.rp > 0 && d.pts.length) stroke = { t0: d.t0, p0: d.p0, rt: d.rt, rp: d.rp, pts: d.pts };
    } catch {
      /* The accounting stands without a shape. */
    }
  }
  return { betId: p.betId, stroke, sections: p.sections, openAt: Number(p.openAt), unit: p.unit.toString(), hitMask: 0, missMask: 0 };
}
const parseGeometry = (g: DrawingPiece | string): DrawingPiece => (typeof g === "string" ? (JSON.parse(g) as DrawingPiece) : g);

export class SocialStore {
  readonly sql: SQL;
  private ingestion: Promise<unknown> = Promise.resolve();
  private boardCache = new Map<string, { until: number; rows: LeaderboardRow[] }>();

  constructor(url: string, readonly scope: string) {
    this.sql = new SQL(url, { max: 4, connectionTimeout: 10, idleTimeout: 30, maxLifetime: 1800 });
  }

  /** One write at a time, in order: a settlement never overtakes its placement. */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.ingestion.then(run);
    this.ingestion = result.catch(() => undefined);
    return result;
  }

  async start() {
    const sql = this.sql;
    await sql`CREATE SCHEMA IF NOT EXISTS skech_social`;
    await sql`CREATE TABLE IF NOT EXISTS skech_social.social_profiles (player TEXT PRIMARY KEY, username TEXT UNIQUE, bio TEXT NOT NULL DEFAULT '', joined BIGINT NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS skech_social.social_avatars (player TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BYTEA NOT NULL, updated BIGINT NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS skech_social.social_pieces (id TEXT PRIMARY KEY, drawing TEXT NOT NULL, player TEXT NOT NULL, at BIGINT NOT NULL, updated BIGINT NOT NULL, stake NUMERIC NOT NULL, settled_stake NUMERIC NOT NULL DEFAULT 0, paid NUMERIC NOT NULL DEFAULT 0, owed NUMERIC NOT NULL DEFAULT 0, hit_mask BIGINT NOT NULL DEFAULT 0, miss_mask BIGINT NOT NULL DEFAULT 0, expired_mask BIGINT NOT NULL DEFAULT 0, geometry JSONB NOT NULL, tx TEXT NOT NULL)`;
    await sql`CREATE INDEX IF NOT EXISTS social_pieces_player_at ON skech_social.social_pieces(player, at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS social_pieces_drawing ON skech_social.social_pieces(drawing)`;
    await sql`CREATE INDEX IF NOT EXISTS social_pieces_updated ON skech_social.social_pieces(updated DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS social_pieces_tx ON skech_social.social_pieces(tx)`;
    await sql`CREATE TABLE IF NOT EXISTS skech_social.social_settlements (id TEXT PRIMARY KEY, bet TEXT NOT NULL, tx TEXT NOT NULL, hit_mask BIGINT NOT NULL, miss_mask BIGINT NOT NULL, expired_mask BIGINT NOT NULL DEFAULT 0, paid NUMERIC NOT NULL, owed NUMERIC NOT NULL, stake NUMERIC NOT NULL DEFAULT 0, counted BOOLEAN NOT NULL DEFAULT false, at BIGINT NOT NULL)`;
    await sql`CREATE INDEX IF NOT EXISTS social_settlements_bet ON skech_social.social_settlements(bet)`;
    await sql`CREATE INDEX IF NOT EXISTS social_settlements_at ON skech_social.social_settlements(at)`;
    await sql`CREATE TABLE IF NOT EXISTS skech_social.social_follows (player TEXT NOT NULL, target TEXT NOT NULL, at BIGINT NOT NULL, PRIMARY KEY(player, target))`;
    await sql`CREATE INDEX IF NOT EXISTS social_follows_target ON skech_social.social_follows(target)`;
    await sql`CREATE TABLE IF NOT EXISTS skech_social.social_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    // Supabase's browser roles must not read or write the server's tables.
    await sql`REVOKE ALL ON SCHEMA skech_social FROM PUBLIC`;
    await sql`REVOKE ALL ON ALL TABLES IN SCHEMA skech_social FROM PUBLIC`;
    await sql`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON SCHEMA skech_social FROM anon;
        REVOKE ALL ON ALL TABLES IN SCHEMA skech_social FROM anon;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON SCHEMA skech_social FROM authenticated;
        REVOKE ALL ON ALL TABLES IN SCHEMA skech_social FROM authenticated;
      END IF;
    END $$`;
    const scope = await this.meta("scope");
    if (scope && scope !== this.scope) throw new Error(`this database is for ${scope}, not ${this.scope}: use a database of its own`);
    if (!scope) await this.setMeta("scope", this.scope);
  }

  close() {
    return this.sql.close();
  }

  async meta(key: string): Promise<string | null> {
    const [row] = await this.sql`SELECT value FROM skech_social.social_meta WHERE key = ${key}`;
    return row?.value ?? null;
  }
  async setMeta(key: string, value: string) {
    await this.sql`INSERT INTO skech_social.social_meta (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
  }

  /* ---- profiles and follows ---- */

  async ensureProfile(player: string, at = Date.now()) {
    await this.sql`INSERT INTO skech_social.social_profiles (player, joined) VALUES (${player}, ${at}) ON CONFLICT (player) DO UPDATE SET joined = LEAST(skech_social.social_profiles.joined, excluded.joined)`;
  }
  async profile(player: string): Promise<PlayerProfile> {
    const [row] = (await this.sql`
      SELECT p.player, p.username, p.bio, p.joined,
        EXISTS (SELECT 1 FROM skech_social.social_avatars a WHERE a.player = p.player) AS avatar,
        (SELECT COUNT(*) FROM skech_social.social_follows WHERE target = p.player) AS followers,
        (SELECT COUNT(*) FROM skech_social.social_follows WHERE player = p.player) AS following
      FROM skech_social.social_profiles p WHERE p.player = ${player}`) as ProfileRow[];
    return { player, username: row?.username ?? null, bio: row?.bio ?? "", avatar: Boolean(row?.avatar), joinedAt: Number(row?.joined ?? 0), followers: Number(row?.followers ?? 0), following: Number(row?.following ?? 0) };
  }
  /** A new name and bio, and a new avatar (or none, null; or the same, undefined). Throws on a name someone has. */
  async edit(player: string, username: string, bio: string, avatar: Avatar | null | undefined): Promise<PlayerProfile> {
    await this.sql.begin(async (tx) => {
      await tx`INSERT INTO skech_social.social_profiles (player, joined) VALUES (${player}, ${Date.now()}) ON CONFLICT (player) DO NOTHING`;
      await tx`UPDATE skech_social.social_profiles SET username = ${username}, bio = ${bio} WHERE player = ${player}`;
      if (avatar === null) await tx`DELETE FROM skech_social.social_avatars WHERE player = ${player}`;
      else if (avatar) await tx`INSERT INTO skech_social.social_avatars (player, mime, bytes, updated) VALUES (${player}, ${avatar.mime}, ${Buffer.from(avatar.bytes)}, ${Date.now()}) ON CONFLICT (player) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes, updated = excluded.updated`;
    });
    this.boardCache.clear();
    return this.profile(player);
  }
  async avatar(player: string): Promise<Avatar | null> {
    const [row] = await this.sql`SELECT mime, bytes FROM skech_social.social_avatars WHERE player = ${player}`;
    return row ? { mime: row.mime as string, bytes: new Uint8Array(row.bytes as Uint8Array) } : null;
  }
  async following(player: string): Promise<string[]> {
    const rows = await this.sql`SELECT target FROM skech_social.social_follows WHERE player = ${player} ORDER BY at DESC LIMIT ${MOST_FOLLOWS}`;
    return rows.map((r: { target: string }) => r.target);
  }
  async follow(player: string, target: string, enabled: boolean) {
    if (!enabled) {
      await this.sql`DELETE FROM skech_social.social_follows WHERE player = ${player} AND target = ${target}`;
      this.boardCache.clear();
      return;
    }
    await this.ensureProfile(player);
    await this.ensureProfile(target);
    const [count] = await this.sql`SELECT COUNT(*) AS n FROM skech_social.social_follows WHERE player = ${player}`;
    if (Number(count.n) >= MOST_FOLLOWS) throw new Error(`You can follow up to ${MOST_FOLLOWS.toLocaleString("en-US")} players`);
    await this.sql`INSERT INTO skech_social.social_follows (player, target, at) VALUES (${player}, ${target}, ${Date.now()}) ON CONFLICT DO NOTHING`;
    this.boardCache.clear();
  }

  /* ---- what the game did ---- */

  /** Whether a transaction is already counted: the indexer need not fetch it. */
  async knows(tx: string): Promise<boolean> {
    const [row] = await this.sql`SELECT EXISTS (SELECT 1 FROM skech_social.social_pieces WHERE tx = ${tx}) OR EXISTS (SELECT 1 FROM skech_social.social_settlements WHERE tx = ${tx}) AS known`;
    return Boolean(row?.known);
  }

  /** A piece placed: the drawing as it now stands, or null if nothing changed (seen before). */
  place(p: Placement): Promise<PublicDrawing | null> {
    return this.serial(() => this.placeOnce(p));
  }
  private async placeOnce(p: Placement): Promise<PublicDrawing | null> {
    const drawing = `${p.player}:${p.drawing}`;
    const shape = geometry(p);
    await this.ensureProfile(p.player, Number(p.openAt));
    // A piece recovered from the chain has no stroke (only its hash is there): the relayer's copy fills it in.
    const enriched = shape.stroke
      ? await this.sql`UPDATE skech_social.social_pieces SET geometry = jsonb_set(geometry, '{stroke}', ${JSON.stringify(shape.stroke)}::text::jsonb) WHERE id = ${p.betId} AND geometry -> 'stroke' = 'null'::jsonb RETURNING id`
      : [];
    const inserted = await this.sql`INSERT INTO skech_social.social_pieces (id, drawing, player, at, updated, stake, geometry, tx) VALUES (${p.betId}, ${drawing}, ${p.player}, ${Number(p.openAt)}, ${Number(p.openAt)}, ${p.staked.toString()}, ${JSON.stringify(shape)}::text::jsonb, ${p.tx}) ON CONFLICT DO NOTHING RETURNING id`;
    // A settlement can be read before its placement: count it now.
    await this.recalculate(p.betId);
    if (!inserted.length && !enriched.length) return null;
    this.boardCache.clear();
    return this.drawing(drawing);
  }

  /** A settlement: counted once, however many times it is told. */
  settle(s: Settlement): Promise<PublicDrawing | null> {
    return this.serial(() => this.settleOnce(s));
  }
  private async settleOnce(s: Settlement): Promise<PublicDrawing | null> {
    const hit = s.hitMask >>> 0, miss = s.missMask >>> 0, expired = (s.expiredMask ?? 0) >>> 0;
    const id = `${s.tx}:${s.betId}:${hit}:${miss}:${expired}`;
    const inserted = await this.sql`INSERT INTO skech_social.social_settlements (id, bet, tx, hit_mask, miss_mask, expired_mask, paid, owed, at) VALUES (${id}, ${s.betId}, ${s.tx}, ${hit}, ${miss}, ${expired}, ${s.paid.toString()}, ${s.owed.toString()}, ${s.at ?? Date.now()}) ON CONFLICT DO NOTHING RETURNING id`;
    const drawing = await this.recalculate(s.betId);
    if (!inserted.length) return null;
    this.boardCache.clear();
    return drawing ? this.drawing(drawing) : null;
  }

  /** A piece's totals again from its settlements. A section decides once: a repeat cannot add to anyone's numbers. */
  private async recalculate(bet: string): Promise<string | null> {
    const [piece] = (await this.sql`SELECT * FROM skech_social.social_pieces WHERE id = ${bet}`) as PieceRow[];
    if (!piece) return null;
    const settlements = await this.sql`SELECT id, hit_mask, miss_mask, expired_mask, paid, owed, at FROM skech_social.social_settlements WHERE bet = ${bet} ORDER BY at, id`;
    const g = parseGeometry(piece.geometry);
    let hits = 0, misses = 0, expired = 0, paid = 0n, owed = 0n, updated = Number(piece.at);
    for (const s of settlements) {
      // A refund settles its band too: its stake is counted settled, and given back in `paid`.
      const mask = (Number(s.hit_mask) | Number(s.miss_mask) | Number(s.expired_mask)) >>> 0;
      // A band told twice (in two transactions) counts the first time only, here and in every sum.
      if (((hits | misses | expired) & mask) !== 0) {
        await this.sql`UPDATE skech_social.social_settlements SET counted = false, stake = 0 WHERE id = ${s.id}`;
        continue;
      }
      hits = (hits | Number(s.hit_mask)) >>> 0;
      misses = (misses | Number(s.miss_mask)) >>> 0;
      expired = (expired | Number(s.expired_mask)) >>> 0;
      let stake = 0n;
      g.sections.forEach((section, i) => {
        if ((mask & (1 << i)) !== 0) stake += BigInt(section.stake);
      });
      await this.sql`UPDATE skech_social.social_settlements SET stake = ${stake.toString()}, counted = true WHERE id = ${s.id}`;
      paid += BigInt(s.paid);
      owed += BigInt(s.owed);
      updated = Math.max(updated, Number(s.at));
    }
    let settled = 0n;
    g.sections.forEach((section, i) => {
      if (((hits | misses | expired) & (1 << i)) !== 0) settled += BigInt(section.stake);
    });
    await this.sql`UPDATE skech_social.social_pieces SET settled_stake = ${settled.toString()}, paid = ${paid.toString()}, owed = ${owed.toString()}, hit_mask = ${hits}, miss_mask = ${misses}, expired_mask = ${expired}, updated = ${updated} WHERE id = ${bet}`;
    return piece.drawing;
  }

  /* ---- reading ---- */

  private async assemble(rows: PieceRow[]): Promise<PublicDrawing[]> {
    const groups = new Map<string, PublicDrawing>();
    const profiles = new Map<string, PlayerProfile>();
    for (const player of new Set(rows.map((r) => r.player))) profiles.set(player, await this.profile(player));
    for (const row of rows) {
      let d = groups.get(row.drawing);
      if (!d) groups.set(row.drawing, (d = { id: row.drawing, player: row.player, profile: profiles.get(row.player)!, at: Number(row.at), updatedAt: Number(row.updated), stake: "0", settledStake: "0", paid: "0", owed: "0", pnl: "0", complete: true, pieces: [], tx: row.tx }));
      d.at = Math.min(d.at, Number(row.at));
      d.updatedAt = Math.max(d.updatedAt, Number(row.updated));
      d.stake = (BigInt(d.stake) + BigInt(row.stake)).toString();
      d.settledStake = (BigInt(d.settledStake) + BigInt(row.settled_stake)).toString();
      d.paid = (BigInt(d.paid) + BigInt(row.paid)).toString();
      d.owed = (BigInt(d.owed) + BigInt(row.owed)).toString();
      const piece = parseGeometry(row.geometry);
      piece.hitMask = Number(row.hit_mask);
      piece.missMask = Number(row.miss_mask);
      piece.expiredMask = Number(row.expired_mask);
      const decided = (piece.hitMask | piece.missMask | piece.expiredMask) >>> 0;
      d.complete &&= piece.sections.every((_, i) => (decided & (1 << i)) !== 0);
      d.pieces.push(piece);
      d.pnl = (BigInt(d.paid) + BigInt(d.owed) - BigInt(d.settledStake)).toString();
    }
    return [...groups.values()].sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  }

  async drawing(id: string): Promise<PublicDrawing | null> {
    const rows = (await this.sql`SELECT * FROM skech_social.social_pieces WHERE drawing = ${id} ORDER BY at, id LIMIT 500`) as PieceRow[];
    return (await this.assemble(rows))[0] ?? null;
  }

  /** Drawings that moved in the last two minutes: the live feed's first look. */
  async live(now = Date.now()): Promise<PublicDrawing[]> {
    const rows = (await this.sql`SELECT * FROM skech_social.social_pieces WHERE drawing IN (SELECT drawing FROM skech_social.social_pieces WHERE updated > ${now - 120_000} GROUP BY drawing ORDER BY MAX(updated) DESC LIMIT 80) ORDER BY at, id`) as PieceRow[];
    return this.assemble(rows);
  }

  /** The newest drawings as activity, for a feed that has heard nothing since it started. */
  async recent(limit = 30): Promise<SocialActivity[]> {
    const ids = await this.sql`SELECT drawing FROM skech_social.social_pieces GROUP BY drawing ORDER BY MAX(updated) DESC LIMIT ${limit}`;
    const out: SocialActivity[] = [];
    for (const r of ids) {
      const d = await this.drawing(r.drawing as string);
      if (!d) continue;
      const settled = BigInt(d.settledStake) > 0n;
      out.push(this.activity(d, settled ? "settled" : "placed", `recent:${d.id}:${d.updatedAt}`));
    }
    return out.sort((a, b) => b.at - a.at);
  }

  private async statistics(player: string, since: number): Promise<PlayerStats> {
    const [money] = await this.sql`SELECT COALESCE(SUM(s.stake), 0)::text AS settled, COALESCE(SUM(s.paid), 0)::text AS paid, COALESCE(SUM(s.owed), 0)::text AS owed FROM skech_social.social_settlements s JOIN skech_social.social_pieces p ON p.id = s.bet WHERE s.counted AND p.player = ${player} AND s.at >= ${since}`;
    const [volume] = await this.sql`SELECT COALESCE(SUM(stake), 0)::text AS staked, COUNT(DISTINCT drawing) AS drawings FROM skech_social.social_pieces WHERE player = ${player} AND at >= ${since}`;
    const [finished] = await this.sql`
      SELECT COUNT(*) AS completed, COALESCE(SUM(CASE WHEN paid + owed > stake THEN 1 ELSE 0 END), 0) AS wins, GREATEST(COALESCE(MAX(paid + owed - stake), 0), 0)::text AS biggest
      FROM (SELECT drawing, SUM(stake) AS stake, SUM(settled_stake) AS settled, SUM(paid) AS paid, SUM(owed) AS owed FROM skech_social.social_pieces WHERE player = ${player} GROUP BY drawing HAVING MAX(updated) >= ${since} AND SUM(stake) = SUM(settled_stake)) d`;
    return {
      staked: volume.staked,
      settledStake: money.settled,
      paid: money.paid,
      owed: money.owed,
      pnl: (BigInt(money.paid) + BigInt(money.owed) - BigInt(money.settled)).toString(),
      drawings: Number(volume.drawings),
      completed: Number(finished.completed),
      wins: Number(finished.wins),
      biggest: finished.biggest,
    };
  }

  /** The top hundred by net PnL in the window, everyone or only whom `player` follows, and `player`'s own row. */
  async board(window: SocialWindow, player: string | null, friends: boolean): Promise<LeaderboardRow[]> {
    const key = `${window}:${friends ? "friends" : "all"}:${player ?? ""}`;
    const cached = this.boardCache.get(key);
    if (cached && cached.until > Date.now()) return cached.rows;
    const since = windowStart(window);
    const everyone = !friends;
    const result = await this.sql`
      WITH earnings AS (
        SELECT p.player, SUM(s.paid) AS paid, SUM(s.owed) AS owed, SUM(s.stake) AS settled
        FROM skech_social.social_settlements s JOIN skech_social.social_pieces p ON p.id = s.bet WHERE s.counted AND s.at >= ${since} GROUP BY p.player
      ), volume AS (
        SELECT player, SUM(stake) AS staked, COUNT(DISTINCT drawing) AS drawings FROM skech_social.social_pieces WHERE at >= ${since} GROUP BY player
      ), drawings AS (
        SELECT player, drawing, SUM(stake) AS stake, SUM(settled_stake) AS settled, SUM(paid) AS paid, SUM(owed) AS owed FROM skech_social.social_pieces GROUP BY player, drawing HAVING MAX(updated) >= ${since}
      ), finishes AS (
        SELECT player, COUNT(*) AS completed, SUM(CASE WHEN paid + owed > stake THEN 1 ELSE 0 END) AS wins, MAX(paid + owed - stake) AS biggest FROM drawings WHERE stake = settled GROUP BY player
      ), ranked AS (
        SELECT p.player, p.username, p.bio, p.joined, EXISTS (SELECT 1 FROM skech_social.social_avatars a WHERE a.player = p.player) AS avatar,
          COALESCE(v.staked, 0)::text AS staked, COALESCE(e.settled, 0)::text AS settled,
          COALESCE(e.paid, 0)::text AS paid, COALESCE(e.owed, 0)::text AS owed,
          COALESCE(e.paid + e.owed - e.settled, 0)::text AS pnl,
          COALESCE(v.drawings, 0) AS drawings, COALESCE(f.completed, 0) AS completed, COALESCE(f.wins, 0) AS wins,
          GREATEST(COALESCE(f.biggest, 0), 0)::text AS biggest,
          ROW_NUMBER() OVER (ORDER BY COALESCE(e.paid + e.owed - e.settled, 0) DESC, p.player) AS rank
        FROM skech_social.social_profiles p LEFT JOIN earnings e ON e.player = p.player LEFT JOIN volume v ON v.player = p.player LEFT JOIN finishes f ON f.player = p.player
        WHERE (e.player IS NOT NULL OR v.player IS NOT NULL)
          AND (${everyone} OR p.player = ${player} OR EXISTS (SELECT 1 FROM skech_social.social_follows WHERE player = ${player} AND target = p.player))
      ) SELECT * FROM ranked WHERE rank <= 100 OR player = ${player} ORDER BY rank`;
    const rows: LeaderboardRow[] = result.map((r: Record<string, unknown>) => ({
      rank: Number(r.rank),
      profile: { player: String(r.player), username: (r.username as string | null) ?? null, bio: String(r.bio), joinedAt: Number(r.joined), avatar: Boolean(r.avatar), followers: 0, following: 0 },
      stats: { staked: String(r.staked), settledStake: String(r.settled), paid: String(r.paid), owed: String(r.owed), pnl: String(r.pnl), drawings: Number(r.drawings), completed: Number(r.completed), wins: Number(r.wins), biggest: String(r.biggest) },
    }));
    // A key per viewer: kept briefly, and never more than a few hundred of them.
    if (this.boardCache.size >= 200) this.boardCache.clear();
    this.boardCache.set(key, { until: Date.now() + 2000, rows });
    return rows;
  }

  /** A player's page: profile, numbers for the window, twenty drawings at a time, and the PnL line. */
  async details(player: string, window: SocialWindow, viewer: string | null, cursor: string | null): Promise<ProfileResponse> {
    const since = windowStart(window);
    let before = Date.now() + 60_000, beforeId = "~";
    if (cursor) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(cursor);
      } catch {
        throw new Error("Invalid history cursor");
      }
      if (!Array.isArray(parsed) || !Number.isSafeInteger(parsed[0]) || typeof parsed[1] !== "string" || parsed[1].length > 120) throw new Error("Invalid history cursor");
      [before, beforeId] = parsed as [number, string];
    }
    const ids = await this.sql`SELECT drawing, MIN(at) AS at FROM skech_social.social_pieces WHERE player = ${player} GROUP BY drawing HAVING MAX(updated) >= ${since} AND (MIN(at), drawing) < (${before}::bigint, ${beforeId}::text) ORDER BY MIN(at) DESC, drawing DESC LIMIT 21`;
    const drawings: PublicDrawing[] = [];
    for (const r of ids.slice(0, 20)) {
      const d = await this.drawing(r.drawing as string);
      if (d) drawings.push(d);
    }
    const profile = await this.profile(player);
    const stats = await this.statistics(player, since);
    const [follows] = viewer ? await this.sql`SELECT EXISTS (SELECT 1 FROM skech_social.social_follows WHERE player = ${viewer} AND target = ${player}) AS yes` : [{ yes: false }];
    const points = await this.sql`SELECT (s.at / 60000) * 60000 AS minute, SUM(s.paid + s.owed - s.stake)::text AS pnl FROM skech_social.social_settlements s JOIN skech_social.social_pieces p ON p.id = s.bet WHERE s.counted AND p.player = ${player} AND s.at >= ${since} GROUP BY 1 ORDER BY 1`;
    let total = 0n;
    const curve: ProfileResponse["curve"] = points.map((p: { minute: string; pnl: string }) => ({ at: Number(p.minute), pnl: (total += BigInt(p.pnl)).toString() }));
    const stride = Math.max(1, Math.ceil(curve.length / 120));
    const badges = [stats.drawings > 0 ? "First drawing" : null, stats.wins > 0 ? "First win" : null, stats.completed >= 100 ? "100 drawings" : null, stats.completed >= 1000 ? "1,000 drawings" : null].filter((b): b is string => b !== null);
    const last = ids.length > 20 ? ids[19] : null;
    return {
      profile,
      stats,
      drawings,
      next: last ? JSON.stringify([Number(last.at), last.drawing]) : null,
      curve: curve.filter((_, i) => i % stride === 0 || i === curve.length - 1),
      badges,
      following: Boolean(follows?.yes),
    };
  }

  activity(d: PublicDrawing, kind: "placed" | "settled", event: string): SocialActivity {
    return { id: event, kind, drawing: d.id, player: d.player, profile: d.profile, at: kind === "placed" ? d.at : d.updatedAt, amount: kind === "placed" ? d.stake : d.pnl, complete: d.complete };
  }
}
