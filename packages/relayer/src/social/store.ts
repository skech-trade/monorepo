import { SQL } from "bun";
import { decodeStroke } from "@skech/core/chain";
import type { Hex } from "viem";
import type { Stroke } from "@skech/core/ink";
import { socialPlayer, windowStart, type DrawingPiece, type LeaderboardRow, type PlayerProfile, type PlayerStats, type ProfileResponse, type PublicDrawing, type SocialActivity, type SocialWindow } from "@skech/core/social";

export type Placement = { betId: string; player: string; drawing: string; openAt: bigint; staked: bigint; unit: bigint; stroke?: string; sections: DrawingPiece["sections"]; tx: string };
export type Settlement = { betId: string; player: string; hitMask: number; missMask: number; paid: bigint; owed: bigint; tx: string; at?: number };
type PieceRow = { id: string; drawing: string; player: string; at: number; updated: number; stake: string; settled_stake: string; paid: string; owed: string; hit_mask: number; miss_mask: number; geometry: string; tx: string };
type ProfileRow = { player: string; username: string | null; bio: string; image: string | null; joined: number; followers?: number; following?: number };
const schema = [
  `CREATE TABLE IF NOT EXISTS skech_social.social_profiles (player TEXT PRIMARY KEY, username TEXT UNIQUE, bio TEXT NOT NULL DEFAULT '', image TEXT, joined BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS skech_social.social_pieces (id TEXT PRIMARY KEY, drawing TEXT NOT NULL, player TEXT NOT NULL, at BIGINT NOT NULL, updated BIGINT NOT NULL, stake TEXT NOT NULL, settled_stake TEXT NOT NULL DEFAULT '0', paid TEXT NOT NULL DEFAULT '0', owed TEXT NOT NULL DEFAULT '0', hit_mask BIGINT NOT NULL DEFAULT 0, miss_mask BIGINT NOT NULL DEFAULT 0, geometry TEXT NOT NULL, tx TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS social_pieces_player_at ON skech_social.social_pieces(player, at DESC)`,
  `CREATE INDEX IF NOT EXISTS social_pieces_drawing ON skech_social.social_pieces(drawing)`,
  `CREATE INDEX IF NOT EXISTS social_pieces_updated ON skech_social.social_pieces(updated DESC)`,
  `CREATE TABLE IF NOT EXISTS skech_social.social_settlements (id TEXT PRIMARY KEY, bet TEXT NOT NULL, hit_mask BIGINT NOT NULL, miss_mask BIGINT NOT NULL, paid TEXT NOT NULL, owed TEXT NOT NULL, stake TEXT NOT NULL DEFAULT '0', at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS social_settlements_bet ON skech_social.social_settlements(bet)`,
  `CREATE TABLE IF NOT EXISTS skech_social.social_follows (player TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY(player, target))`,
  `CREATE INDEX IF NOT EXISTS social_follows_target ON skech_social.social_follows(target)`,
  `CREATE TABLE IF NOT EXISTS skech_social.social_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

function geometry(placement: Placement): DrawingPiece {
  let stroke: Stroke | null = null;
  if (placement.stroke) {
    try {
      const decoded = decodeStroke(placement.stroke as Hex);
      if (decoded.rt > 0 && decoded.rp > 0 && decoded.pts.length) stroke = { t0: decoded.t0, p0: decoded.p0, rt: decoded.rt, rp: decoded.rp, pts: decoded.pts };
    } catch { /* Receipt accounting remains available even when geometry is invalid. */ }
  }
  return { betId: placement.betId, stroke, sections: placement.sections, openAt: Number(placement.openAt), unit: placement.unit.toString(), hitMask: 0, missMask: 0 };
}

export class SocialStore {
  readonly sql: SQL;
  private revision = 0;
  private ingestion = Promise.resolve();
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.ingestion.then(run);
    this.ingestion = result.then(() => undefined, () => undefined);
    return result;
  }
  private boardCache = new Map<string, { revision: number; until: number; rows: LeaderboardRow[] }>();
  constructor(url: string, readonly scope: string, private readonly namespace = "skech_social") { this.sql = new SQL(url, { max: 4, connectionTimeout: 10, idleTimeout: 30, maxLifetime: 1800 }); }
  private query(strings: TemplateStringsArray, ...values: (string | number | bigint | boolean | null)[]) {
    const statement = strings.reduce((out, part, i) => out + (i ? `$${i}` : "") + part, "").replaceAll("skech_social", this.namespace);
    return this.sql.unsafe(statement, values);
  }
  async start() {
    await this.query`CREATE SCHEMA IF NOT EXISTS skech_social`;
    for (const statement of schema) await this.sql.unsafe(statement.replaceAll("skech_social", this.namespace));
    // Supabase's browser roles must not write the server-owned accounting tables.
    await this.query`REVOKE ALL ON SCHEMA skech_social FROM PUBLIC`;
    await this.query`REVOKE ALL ON ALL TABLES IN SCHEMA skech_social FROM PUBLIC`;
    await this.sql.unsafe(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON SCHEMA skech_social FROM anon;
        REVOKE ALL ON ALL TABLES IN SCHEMA skech_social FROM anon;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON SCHEMA skech_social FROM authenticated;
        REVOKE ALL ON ALL TABLES IN SCHEMA skech_social FROM authenticated;
      END IF;
    END $$`.replaceAll("skech_social", this.namespace));
    const scope = await this.meta("scope");
    if (scope && scope !== this.scope) throw new Error("Social database belongs to another network/deployment; use a separate database.");
    await this.setMeta("scope", this.scope);
  }
  async meta(key: string): Promise<string | null> { const [row] = await this.query`SELECT value FROM skech_social.social_meta WHERE key = ${key}`; return row?.value ?? null; }
  async setMeta(key: string, value: string) { await this.query`INSERT INTO skech_social.social_meta (key, value) VALUES (${key}, ${value}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`; }
  async ensureProfile(player: string, at = Date.now()) {
    await this.query`INSERT INTO skech_social.social_profiles (player, joined) VALUES (${socialPlayer(player)}, ${at}) ON CONFLICT(player) DO UPDATE SET joined = CASE WHEN excluded.joined < skech_social.social_profiles.joined THEN excluded.joined ELSE skech_social.social_profiles.joined END`;
  }
  async profile(player: string): Promise<PlayerProfile> {
    const [row] = await this.query`SELECT p.*, (SELECT COUNT(*) FROM skech_social.social_follows WHERE target = p.player) AS followers, (SELECT COUNT(*) FROM skech_social.social_follows WHERE player = p.player) AS following FROM skech_social.social_profiles p WHERE p.player = ${socialPlayer(player)}` as ProfileRow[];
    return { player: socialPlayer(player), username: row?.username ?? null, bio: row?.bio ?? "", avatar: Boolean(row?.image), joinedAt: Number(row?.joined ?? 0), followers: Number(row?.followers ?? 0), following: Number(row?.following ?? 0) };
  }
  async edit(player: string, username: string, bio: string, image: string | null | undefined) {
    await this.ensureProfile(player);
    if (image === undefined) await this.query`UPDATE skech_social.social_profiles SET username = ${username}, bio = ${bio} WHERE player = ${player}`;
    else await this.query`UPDATE skech_social.social_profiles SET username = ${username}, bio = ${bio}, image = ${image} WHERE player = ${player}`;
    this.revision++;
    return this.profile(player);
  }
  async avatar(player: string): Promise<string | null> { const [row] = await this.query`SELECT image FROM skech_social.social_profiles WHERE player = ${player}`; return row?.image ?? null; }
  async following(player: string): Promise<string[]> { return (await this.query`SELECT target FROM skech_social.social_follows WHERE player = ${player}`).map((r: { target: string }) => r.target); }
  async follow(player: string, target: string, enabled: boolean) {
    await this.ensureProfile(player);
    if (enabled) { await this.ensureProfile(target); await this.query`INSERT INTO skech_social.social_follows (player, target) VALUES (${player}, ${target}) ON CONFLICT DO NOTHING`; }
    else await this.query`DELETE FROM skech_social.social_follows WHERE player = ${player} AND target = ${target}`;
    this.revision++;
  }
  place(p: Placement): Promise<PublicDrawing | null> { return this.serial(() => this.placeOnce(p)); }
  private async placeOnce(p: Placement): Promise<PublicDrawing | null> {
    const player = socialPlayer(p.player), drawing = `${player}:${p.drawing}`;
    await this.ensureProfile(player, Number(p.openAt));
    // A recovered Solana event has no stroke bytes; enrich it when the relayer delivers them.
    const enriched = p.stroke ? await this.query`UPDATE skech_social.social_pieces SET geometry = ${JSON.stringify(geometry(p))} WHERE id = ${p.betId} AND geometry::jsonb -> 'stroke' = 'null'::jsonb RETURNING id` : [];
    const rows = await this.query`INSERT INTO skech_social.social_pieces (id, drawing, player, at, updated, stake, geometry, tx) VALUES (${p.betId}, ${drawing}, ${player}, ${Number(p.openAt)}, ${Number(p.openAt)}, ${p.staked.toString()}, ${JSON.stringify(geometry(p))}, ${p.tx}) ON CONFLICT DO NOTHING RETURNING id`;
    await this.recalculate(p.betId);
    if (!rows.length && !enriched.length) return null;
    this.revision++;
    return this.drawing(drawing);
  }
  settle(s: Settlement): Promise<PublicDrawing | null> { return this.serial(() => this.settleOnce(s)); }
  private async settleOnce(s: Settlement): Promise<PublicDrawing | null> {
    const id = `${s.tx}:${s.betId}:${s.hitMask >>> 0}:${s.missMask >>> 0}`;
    const rows = await this.query`INSERT INTO skech_social.social_settlements (id, bet, hit_mask, miss_mask, paid, owed, at) VALUES (${id}, ${s.betId}, ${s.hitMask >>> 0}, ${s.missMask >>> 0}, ${s.paid.toString()}, ${s.owed.toString()}, ${s.at ?? Date.now()}) ON CONFLICT DO NOTHING RETURNING id`;
    const drawing = await this.recalculate(s.betId);
    if (!rows.length) return null;
    this.revision++;
    return drawing ? this.drawing(drawing) : null;
  }
  private async recalculate(bet: string): Promise<string | null> {
    const [piece] = await this.query`SELECT * FROM skech_social.social_pieces WHERE id = ${bet}` as PieceRow[];
    if (!piece) return null; // Backfill may see a settlement before its placement.
    const settlements = await this.query`SELECT * FROM skech_social.social_settlements WHERE bet = ${bet} ORDER BY at, id`;
    let hits = 0, misses = 0, paid = 0n, owed = 0n, updated = Number(piece.at);
    const g = JSON.parse(piece.geometry) as DrawingPiece;
    for (const s of settlements) {
      const mask = (Number(s.hit_mask) | Number(s.miss_mask)) >>> 0;
      // A section settles once. Replayed receipts and repeated chain scans cannot mint statistics.
      if (((hits | misses) & mask) !== 0) continue;
      hits = (hits | Number(s.hit_mask)) >>> 0; misses = (misses | Number(s.miss_mask)) >>> 0;
      let eventStake = 0n;
      g.sections.forEach((section, index) => { if ((mask & (1 << index)) !== 0) eventStake += BigInt(section.stake); });
      await this.query`UPDATE skech_social.social_settlements SET stake = ${eventStake.toString()} WHERE id = ${s.id}`;
      paid += BigInt(s.paid); owed += BigInt(s.owed); updated = Math.max(updated, Number(s.at));
    }
    let settled = 0n;
    g.sections.forEach((section, index) => { if (((hits | misses) & (1 << index)) !== 0) settled += BigInt(section.stake); });
    await this.query`UPDATE skech_social.social_pieces SET settled_stake = ${settled.toString()}, paid = ${paid.toString()}, owed = ${owed.toString()}, hit_mask = ${hits}, miss_mask = ${misses}, updated = ${updated} WHERE id = ${bet}`;
    return piece.drawing;
  }
  private async assemble(rows: PieceRow[]): Promise<PublicDrawing[]> {
    const groups = new Map<string, PublicDrawing>();
    const profiles = new Map<string, PlayerProfile>();
    await Promise.all([...new Set(rows.map(r => r.player))].map(async player => profiles.set(player, await this.profile(player))));
    for (const row of rows) {
      let d = groups.get(row.drawing);
      if (!d) groups.set(row.drawing, d = { id: row.drawing, player: row.player, profile: profiles.get(row.player)!, at: Number(row.at), updatedAt: Number(row.updated), stake: "0", settledStake: "0", paid: "0", owed: "0", pnl: "0", complete: true, pieces: [], tx: row.tx });
      d.at = Math.min(d.at, Number(row.at)); d.updatedAt = Math.max(d.updatedAt, Number(row.updated));
      d.stake = (BigInt(d.stake) + BigInt(row.stake)).toString();
      d.settledStake = (BigInt(d.settledStake) + BigInt(row.settled_stake)).toString();
      d.paid = (BigInt(d.paid) + BigInt(row.paid)).toString(); d.owed = (BigInt(d.owed) + BigInt(row.owed)).toString();
      const piece = JSON.parse(row.geometry) as DrawingPiece;
      piece.hitMask = Number(row.hit_mask); piece.missMask = Number(row.miss_mask);
      const decided = (piece.hitMask | piece.missMask) >>> 0;
      d.complete &&= piece.sections.every((_, i) => (decided & (1 << i)) !== 0);
      d.pieces.push(piece);
      d.pnl = (BigInt(d.paid) + BigInt(d.owed) - BigInt(d.settledStake)).toString();
    }
    return [...groups.values()].sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  }
  async drawing(id: string) { return (await this.assemble(await this.query`SELECT * FROM skech_social.social_pieces WHERE drawing = ${id} ORDER BY at, id` as PieceRow[]))[0] ?? null; }
  async live() {
    const rows = await this.query`SELECT * FROM skech_social.social_pieces WHERE drawing IN (SELECT drawing FROM skech_social.social_pieces WHERE updated > ${Date.now() - 120_000} GROUP BY drawing ORDER BY MAX(updated) DESC LIMIT 80) ORDER BY at, id` as PieceRow[];
    return this.assemble(rows);
  }
  /** PostgreSQL does exact NUMERIC arithmetic; only decimal strings cross the API. */
  private async statistics(player: string, since: number): Promise<PlayerStats> {
    const [money] = await this.query`SELECT CAST(COALESCE(SUM(CAST(s.stake AS NUMERIC)), 0) AS TEXT) AS settled, CAST(COALESCE(SUM(CAST(s.paid AS NUMERIC)), 0) AS TEXT) AS paid, CAST(COALESCE(SUM(CAST(s.owed AS NUMERIC)), 0) AS TEXT) AS owed FROM skech_social.social_settlements s JOIN skech_social.social_pieces p ON p.id = s.bet WHERE p.player = ${player} AND s.at >= ${since}`;
    const [volume] = await this.query`SELECT CAST(COALESCE(SUM(CAST(stake AS NUMERIC)), 0) AS TEXT) AS staked, COUNT(DISTINCT drawing) AS drawings FROM skech_social.social_pieces WHERE player = ${player} AND at >= ${since}`;
    const [finished] = await this.query`SELECT COUNT(*) AS completed, COALESCE(SUM(CASE WHEN paid + owed > stake THEN 1 ELSE 0 END), 0) AS wins, CAST(COALESCE(MAX(paid + owed - stake), 0) AS TEXT) AS biggest FROM (SELECT drawing, SUM(CAST(stake AS NUMERIC)) AS stake, SUM(CAST(settled_stake AS NUMERIC)) AS settled, SUM(CAST(paid AS NUMERIC)) AS paid, SUM(CAST(owed AS NUMERIC)) AS owed FROM skech_social.social_pieces WHERE player = ${player} GROUP BY drawing HAVING MAX(updated) >= ${since} AND SUM(CAST(stake AS NUMERIC)) = SUM(CAST(settled_stake AS NUMERIC))) d`;
    return { staked: volume.staked, settledStake: money.settled, paid: money.paid, owed: money.owed, pnl: (BigInt(money.paid) + BigInt(money.owed) - BigInt(money.settled)).toString(), drawings: Number(volume.drawings), completed: Number(finished.completed), wins: Number(finished.wins), biggest: BigInt(finished.biggest) > 0n ? finished.biggest : "0" };
  }
  async board(window: SocialWindow, player: string | null, friends: boolean) {
    const key = `${window}:${friends ? player : "global"}:${player ?? ""}`;
    const cached = this.boardCache.get(key);
    if (cached && cached.until > Date.now()) return cached.rows;
    const since = windowStart(window);
    const result = await this.query`
      WITH earnings AS (
        SELECT p.player, SUM(CAST(s.paid AS NUMERIC)) AS paid, SUM(CAST(s.owed AS NUMERIC)) AS owed, SUM(CAST(s.stake AS NUMERIC)) AS settled
        FROM skech_social.social_settlements s JOIN skech_social.social_pieces p ON p.id = s.bet WHERE s.at >= ${since} GROUP BY p.player
      ), volume AS (
        SELECT player, SUM(CAST(stake AS NUMERIC)) AS staked, COUNT(DISTINCT drawing) AS drawings FROM skech_social.social_pieces WHERE at >= ${since} GROUP BY player
      ), drawings AS (
        SELECT player, drawing, SUM(CAST(stake AS NUMERIC)) AS stake, SUM(CAST(settled_stake AS NUMERIC)) AS settled, SUM(CAST(paid AS NUMERIC)) AS paid, SUM(CAST(owed AS NUMERIC)) AS owed FROM skech_social.social_pieces GROUP BY player, drawing HAVING MAX(updated) >= ${since}
      ), finishes AS (
        SELECT player, COUNT(*) AS completed, SUM(CASE WHEN paid + owed > stake THEN 1 ELSE 0 END) AS wins, MAX(paid + owed - stake) AS biggest FROM drawings WHERE stake = settled GROUP BY player
      ), ranked AS (
        SELECT p.player, p.username, p.bio, p.joined, (p.image IS NOT NULL) AS avatar,
          CAST(COALESCE(v.staked, 0) AS TEXT) AS staked, CAST(COALESCE(e.settled, 0) AS TEXT) AS settled,
          CAST(COALESCE(e.paid, 0) AS TEXT) AS paid, CAST(COALESCE(e.owed, 0) AS TEXT) AS owed,
          CAST(COALESCE(e.paid + e.owed - e.settled, 0) AS TEXT) AS pnl,
          COALESCE(v.drawings, 0) AS drawings, COALESCE(f.completed, 0) AS completed, COALESCE(f.wins, 0) AS wins,
          CAST(GREATEST(COALESCE(f.biggest, 0), 0) AS TEXT) AS biggest,
          ROW_NUMBER() OVER (ORDER BY COALESCE(e.paid + e.owed - e.settled, 0) DESC, p.player) AS rank
        FROM skech_social.social_profiles p LEFT JOIN earnings e ON e.player = p.player LEFT JOIN volume v ON v.player = p.player LEFT JOIN finishes f ON f.player = p.player
        WHERE (e.player IS NOT NULL OR v.player IS NOT NULL) AND (${!friends} OR p.player = ${player} OR EXISTS (SELECT 1 FROM skech_social.social_follows WHERE player = ${player} AND target = p.player))
      ) SELECT * FROM ranked WHERE rank <= 100 OR player = ${player} ORDER BY rank`;
    const rows: LeaderboardRow[] = result.map((r: Record<string, unknown>) => ({ rank: Number(r.rank), profile: { player: String(r.player), username: r.username as string | null, bio: String(r.bio), joinedAt: Number(r.joined), avatar: Boolean(r.avatar), followers: 0, following: 0 }, stats: { staked: String(r.staked), settledStake: String(r.settled), paid: String(r.paid), owed: String(r.owed), pnl: String(r.pnl), drawings: Number(r.drawings), completed: Number(r.completed), wins: Number(r.wins), biggest: String(r.biggest) } }));
    if (this.boardCache.size > 100) this.boardCache.clear();
    this.boardCache.set(key, { revision: this.revision, until: Date.now() + 2000, rows });
    return rows;
  }
  async details(player: string, window: SocialWindow, viewer: string | null, cursor: string | null): Promise<ProfileResponse> {
    const since = windowStart(window);
    let before = Date.now() + 60_000, beforeId = "~";
    if (cursor) {
      try { const parsed = JSON.parse(cursor); if (!Array.isArray(parsed) || !Number.isSafeInteger(parsed[0]) || typeof parsed[1] !== "string" || parsed[1].length > 120) throw new Error(); [before, beforeId] = parsed; }
      catch { throw new Error("Invalid history cursor"); }
    }
    const ids = await this.query`SELECT drawing, MIN(at) AS at FROM skech_social.social_pieces WHERE player = ${player} GROUP BY drawing HAVING MAX(updated) >= ${since} AND (MIN(at), drawing) < (${before}, ${beforeId}) ORDER BY MIN(at) DESC, drawing DESC LIMIT 21`;
    const drawings = (await Promise.all(ids.slice(0, 20).map((r: { drawing: string }) => this.drawing(r.drawing)))).filter((d): d is PublicDrawing => d !== null);
    const [profile, stats, follows] = await Promise.all([this.profile(player), this.statistics(player, since), viewer ? this.following(viewer) : Promise.resolve([])]);
    const points = await this.query`SELECT (s.at / 60000) * 60000 AS updated, CAST(SUM(CAST(s.paid AS NUMERIC) + CAST(s.owed AS NUMERIC) - CAST(s.stake AS NUMERIC)) AS TEXT) AS pnl FROM skech_social.social_settlements s JOIN skech_social.social_pieces p ON p.id = s.bet WHERE p.player = ${player} AND s.at >= ${since} GROUP BY (s.at / 60000) * 60000 ORDER BY updated`;
    let total = 0n;
    const curve: ProfileResponse["curve"] = points.map((p: { updated: number; pnl: string }) => ({ at: Number(p.updated), pnl: (total += BigInt(p.pnl)).toString() }));
    const stride = Math.max(1, Math.ceil(curve.length / 120));
    const badges = [stats.drawings > 0 ? "First drawing" : null, stats.wins > 0 ? "First win" : null, stats.completed >= 100 ? "100 drawings" : null, stats.completed >= 1000 ? "1,000 drawings" : null].filter((b): b is string => b !== null);
    const last = drawings.at(-1);
    return { profile, stats, drawings, next: ids.length > 20 && last ? JSON.stringify([last.at, last.id]) : null, curve: curve.filter((_, i) => i % stride === 0 || i === curve.length - 1), badges, following: follows.includes(player) };
  }
  activity(d: PublicDrawing, kind: "placed" | "settled", event: string): SocialActivity {
    return { id: event, kind, drawing: d.id, player: d.player, profile: d.profile, at: kind === "placed" ? d.at : d.updatedAt, amount: kind === "placed" ? d.stake : d.pnl, complete: d.complete };
  }
}
