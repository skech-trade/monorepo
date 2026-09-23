/**
 * Player profiles and points.
 *
 * A wallet claims a username by signing a message, and gets a session token
 * back. A signed-in player registers a drawn prediction; once its round is
 * over it is scored here against the feed's own candles, never against
 * anything the browser reports.
 */

import { createHash, randomBytes } from "node:crypto";
import { type Pt, shapeOf } from "@skech/core/shape";
import { isSymbol } from "@skech/core/venue";
import type { SQL } from "bun";
import { verifyMessage } from "viem";
import { sql } from "./db";
import { addressOf, readJson } from "./http";
import { type Candle, isDrawing, levelOf, scorePrediction, usernameOf } from "./social-rules";

const FEED = (process.env.SOCIAL_FEED_URL ?? "http://localhost:3210").replace(/\/$/, "");
/** The feed's candle. Scoring counts candles, so a feed on any other interval is refused. */
const CANDLE_MS = 500;
const DAILY_PREDICTIONS = 3;
const CHALLENGE_MS = 5 * 60_000;
const SESSION_MS = 7 * 86_400_000;
/** A prediction whose candles have not all turned up by now never will: the feed keeps ten minutes. */
const EXPIRE_MS = 9 * 60_000;
const ACHIEVEMENT = "achievement:";
const BUDDIES = ["blue", "mint", "coral"];

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const json = (data: unknown, status = 200) => Response.json(data, { status });
const buddyOf = (s: unknown) => (BUDDIES.includes(String(s)) ? String(s) : "blue");

export async function migrateSocial() {
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS social_profiles (
      address     text PRIMARY KEY,
      username    text UNIQUE NOT NULL,
      buddy       text NOT NULL DEFAULT 'blue',
      created_at  timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS social_challenges (
      id          text PRIMARY KEY,
      address     text NOT NULL,
      username    text NOT NULL,
      message     text NOT NULL,
      expires_at  timestamptz NOT NULL
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS social_sessions (
      token_hash  text PRIMARY KEY,
      address     text NOT NULL REFERENCES social_profiles(address),
      expires_at  timestamptz NOT NULL
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS social_predictions (
      id          text PRIMARY KEY,
      address     text NOT NULL REFERENCES social_profiles(address),
      pts         jsonb NOT NULL,
      entry       double precision NOT NULL,
      starts_at   bigint NOT NULL,
      seconds     int NOT NULL,
      status      text NOT NULL DEFAULT 'pending',
      accuracy    double precision,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`;
  // Scored against its own market's candles. Rows from before Ethereum are Bitcoin.
  await sql`ALTER TABLE social_predictions ADD COLUMN IF NOT EXISTS market text NOT NULL DEFAULT 'BTC'`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS social_one_pending ON social_predictions(address) WHERE status = 'pending'`;
  await sql`
    CREATE TABLE IF NOT EXISTS social_points (
      id          bigserial PRIMARY KEY,
      address     text NOT NULL REFERENCES social_profiles(address),
      event_key   text NOT NULL,
      points      int NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE(address, event_key)
    )`;
}

/** Points for an event, once: the key is unique per address, so a repeat is a no-op. */
const award = (db: SQL, address: string, key: string, points: number) =>
  db`INSERT INTO social_points(address, event_key, points) VALUES (${address}, ${key}, ${points}) ON CONFLICT DO NOTHING`;

async function profile(address: string) {
  if (!sql) return null;
  // Independent reads, so they go together rather than one after another.
  const [[row], [sum], badges, [counts]] = await Promise.all([
    sql`SELECT username, buddy FROM social_profiles WHERE address = ${address}`,
    sql`SELECT COALESCE(SUM(points), 0)::int AS points FROM social_points WHERE address = ${address}`,
    sql`SELECT event_key FROM social_points WHERE address = ${address} AND event_key LIKE 'achievement:%' ORDER BY id`,
    sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'scored')::int AS completed,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS today
      FROM social_predictions WHERE address = ${address}`,
  ]);
  if (!row) return null;
  return {
    ...row,
    points: sum.points,
    ...levelOf(sum.points),
    achievements: badges.map((b: { event_key: string }) => b.event_key.slice(ACHIEVEMENT.length)),
    completed: counts.completed,
    dailyRemaining: Math.max(0, DAILY_PREDICTIONS - counts.today),
  };
}

async function marketBars(market: string): Promise<Candle[]> {
  const r = await fetch(`${FEED}/bars?n=1200&market=${market}`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw Error("Feed unavailable");
  const data = (await r.json()) as { bars: Candle[]; intervalMs: number };
  if (data.intervalMs !== CANDLE_MS || !Array.isArray(data.bars) || !data.bars.length) {
    throw Error("Market history unavailable");
  }
  return data.bars;
}

/** Evaluated against server market history, never P&L or accuracy supplied by a browser. */
export async function settlePredictions() {
  if (!sql) return;
  const due = await sql`
    SELECT * FROM social_predictions
    WHERE status = 'pending' AND starts_at + seconds * 1000 < ${Date.now() - 2000}
    ORDER BY starts_at LIMIT 100`;
  if (!due.length) return;
  // One market's feed being down holds back only that market's rows; they are tried again next pass.
  const byMarket = new Map<string, Candle[] | null>();
  for (const row of due) {
    const market = String(row.market ?? "BTC");
    if (!byMarket.has(market)) byMarket.set(market, await marketBars(market).catch(() => null));
    const bars = byMarket.get(market);
    if (!bars) continue;
    const start = Number(row.starts_at);
    const end = start + row.seconds * 1000;
    // Every candle of the round, with none missing: a gap would score a move nobody saw.
    const run = bars.filter((b) => b.t * 1000 >= start && b.t * 1000 < end);
    const contiguous =
      run.length === (row.seconds * 1000) / CANDLE_MS && run.every((b, i) => b.t * 1000 === start + i * CANDLE_MS);
    if (!contiguous) {
      if (Date.now() - start > EXPIRE_MS) {
        await sql`UPDATE social_predictions SET status = 'expired' WHERE id = ${row.id} AND status = 'pending'`;
      }
      continue;
    }
    const score = scorePrediction(row.pts as Pt[], row.entry, run);
    if (!score) continue;
    await sql.begin(async (tx) => {
      await tx`SELECT address FROM social_profiles WHERE address = ${row.address} FOR UPDATE`;
      const changed = await tx`
        UPDATE social_predictions SET status = 'scored', accuracy = ${score.accuracy}
        WHERE id = ${row.id} AND status = 'pending' RETURNING id`;
      if (!changed.length) return;
      await award(tx, row.address, `prediction:${row.id}`, score.points);
      const [n] = await tx`SELECT COUNT(*)::int AS count FROM social_predictions WHERE address = ${row.address} AND status = 'scored'`;
      const awards: [string, number][] = [["first_prediction", 10]];
      if (n.count >= 5) awards.push(["five_predictions", 20]);
      if (score.accuracy >= 0.7) awards.push(["sharp_eye", 20]);
      for (const [badge, points] of awards) await award(tx, row.address, `${ACHIEVEMENT}${badge}`, points);
    });
  }
}

export async function socialRoute(req: Request): Promise<Response> {
  if (!sql) return json({ error: "Profiles need the database" }, 503);
  const path = new URL(req.url).pathname;
  const body = req.method === "POST" ? await readJson(req) : null;
  if (req.method === "POST" && !body) return json({ error: "Invalid request" }, 400);

  // A signature request for a username. Signing it is what claims the name.
  if (path === "/social/challenge" && body) {
    const address = addressOf(body.address);
    const username = usernameOf(body.username);
    if (!address || !username) {
      return json({ error: "Use 3–20 letters, numbers or underscores, starting with a letter." }, 400);
    }
    const [existing] = await sql`SELECT username FROM social_profiles WHERE address = ${address}`;
    if (existing && existing.username !== username) {
      return json({ error: `This wallet already owns @${existing.username}. Use that name to reconnect.` }, 409);
    }
    const [used] = await sql`SELECT address FROM social_profiles WHERE username = ${username} AND address <> ${address}`;
    if (used) return json({ error: "That username is taken." }, 409);
    const [recent] = await sql`SELECT COUNT(*)::int AS n FROM social_challenges WHERE address = ${address} AND expires_at > now()`;
    if (recent.n >= 5) return json({ error: "Please wait a few minutes before trying again." }, 429);
    const id = randomBytes(24).toString("hex");
    const expires = new Date(Date.now() + CHALLENGE_MS);
    const message = [
      "Skech player profile",
      `Claim @${username} and sign in to Skech points.`,
      `Wallet: ${address}`,
      `Nonce: ${id}`,
      `Expires: ${expires.toISOString()}`,
      "This does not authorize a trade or transfer.",
    ].join("\n");
    await sql`
      INSERT INTO social_challenges(id, address, username, message, expires_at)
      VALUES (${id}, ${address}, ${username}, ${message}, ${expires})`;
    return json({ id, message });
  }

  // The signed challenge back: the profile is made if it is new, and a session starts either way.
  if (path === "/social/claim" && body) {
    const [challenge] = await sql`SELECT * FROM social_challenges WHERE id = ${String(body.id)} AND expires_at > now()`;
    if (!challenge || typeof body.signature !== "string") return json({ error: "Signature request expired." }, 401);
    const valid = await verifyMessage({
      address: challenge.address,
      message: challenge.message,
      signature: body.signature as `0x${string}`,
    }).catch(() => false);
    if (!valid) return json({ error: "Wallet signature did not match." }, 401);
    const token = randomBytes(32).toString("hex");
    try {
      await sql.begin(async (tx) => {
        const consumed = await tx`DELETE FROM social_challenges WHERE id = ${challenge.id} AND expires_at > now() RETURNING id`;
        if (!consumed.length) throw Error("expired");
        await tx`
          INSERT INTO social_profiles(address, username, buddy)
          VALUES (${challenge.address}, ${challenge.username}, ${buddyOf(body.buddy)})
          ON CONFLICT(address) DO NOTHING`;
        await tx`
          INSERT INTO social_sessions(token_hash, address, expires_at)
          VALUES (${hash(token)}, ${challenge.address}, ${new Date(Date.now() + SESSION_MS)})`;
        await award(tx, challenge.address, `${ACHIEVEMENT}founding_skecher`, 50);
      });
    } catch {
      return json({ error: "Claim expired or username was just taken. Please try again." }, 409);
    }
    return json({ token, profile: await profile(challenge.address) });
  }

  // Everything below needs a session.
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const [session] = await sql`SELECT address FROM social_sessions WHERE token_hash = ${hash(token)} AND expires_at > now()`;
  if (!session) return json({ error: "Sign in to your player profile." }, 401);
  const address = session.address as string;

  if (path === "/social/me" && req.method === "GET") return json(await profile(address));

  if (path === "/social/buddy" && body) {
    await sql`UPDATE social_profiles SET buddy = ${buddyOf(body.buddy)} WHERE address = ${address}`;
    return json(await profile(address));
  }

  if (path === "/social/predictions" && body) {
    const market = body.market ?? "BTC";
    if (!isSymbol(market)) return json({ error: "Predictions are on Bitcoin or Ethereum." }, 400);
    const pts = body.pts;
    const seconds = Number(body.seconds);
    if (!isDrawing(pts) || !Number.isInteger(seconds) || seconds < 10 || seconds > 300) {
      return json({ error: "Draw a prediction lasting 10–300 seconds." }, 400);
    }
    const bars = await marketBars(market);
    const head = bars.at(-1)!;
    if (Date.now() - head.t * 1000 > 5000) return json({ error: "Waiting for live market data." }, 503);
    // The drawing is moved to start at the market as it is now, which is what it is scored from.
    const entry = head.c;
    const offset = entry - pts[0].price;
    const shifted = pts.map((p) => ({ t: p.t, price: p.price + offset }));
    if (shifted.some((p) => !Number.isFinite(p.price) || p.price <= 0) || shapeOf(shifted, entry)?.flat !== false) {
      return json({ error: "Draw a clearer prediction to earn points." }, 400);
    }
    const id = crypto.randomUUID();
    // It starts on the next candle boundary, so its candles line up with the feed's.
    const start = Math.ceil(Date.now() / CANDLE_MS) * CANDLE_MS;
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT address FROM social_profiles WHERE address = ${address} FOR UPDATE`;
        const [n] = await tx`
          SELECT COUNT(*)::int AS n FROM social_predictions
          WHERE address = ${address} AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
        if (n.n >= DAILY_PREDICTIONS) throw Error("daily");
        await tx`
          INSERT INTO social_predictions(id, address, market, pts, entry, starts_at, seconds)
          VALUES (${id}, ${address}, ${market}, ${shifted}::jsonb, ${entry}, ${start}, ${seconds})`;
      });
    } catch {
      return json({ error: "One scored prediction at a time, up to three per UTC day." }, 409);
    }
    return json({ id, endsAt: start + seconds * 1000 });
  }

  return json({ error: "Not found" }, 404);
}
