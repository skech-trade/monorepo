import { createHash, randomBytes } from "node:crypto";
import { verifyMessage } from "viem";
import { shapeOf, type Pt } from "@skech/core/shape";
import { sql } from "./db";
import { levelOf, scorePrediction, usernameOf, type Candle } from "./social-rules";

const FEED = (process.env.SOCIAL_FEED_URL ?? "http://localhost:3210").replace(/\/$/, "");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const addressOf = (s: unknown) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
const json = (data: unknown, status = 200) => Response.json(data, { status });
const buddyOf = (s: unknown) => ["blue", "mint", "coral"].includes(String(s)) ? String(s) : "blue";

export async function migrateSocial() {
  if (!sql) return;
  await sql`CREATE TABLE IF NOT EXISTS social_profiles (address text PRIMARY KEY, username text UNIQUE NOT NULL, buddy text NOT NULL DEFAULT 'blue', created_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS social_challenges (id text PRIMARY KEY, address text NOT NULL, username text NOT NULL, message text NOT NULL, expires_at timestamptz NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS social_sessions (token_hash text PRIMARY KEY, address text NOT NULL REFERENCES social_profiles(address), expires_at timestamptz NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS social_predictions (id text PRIMARY KEY, address text NOT NULL REFERENCES social_profiles(address), pts jsonb NOT NULL, entry double precision NOT NULL, starts_at bigint NOT NULL, seconds int NOT NULL, status text NOT NULL DEFAULT 'pending', accuracy double precision, created_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS social_one_pending ON social_predictions(address) WHERE status = 'pending'`;
  await sql`CREATE TABLE IF NOT EXISTS social_points (id bigserial PRIMARY KEY, address text NOT NULL REFERENCES social_profiles(address), event_key text NOT NULL, points int NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(address, event_key))`;
}

async function profile(address: string) {
  if (!sql) return null;
  const [row] = await sql`SELECT username, buddy FROM social_profiles WHERE address = ${address}`;
  if (!row) return null;
  const [sum] = await sql`SELECT COALESCE(SUM(points),0)::int AS points FROM social_points WHERE address = ${address}`;
  const badges = await sql`SELECT event_key FROM social_points WHERE address = ${address} AND event_key LIKE 'achievement:%' ORDER BY id`;
  const [counts] = await sql`SELECT COUNT(*) FILTER (WHERE status = 'scored')::int AS completed, COUNT(*) FILTER (WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS today FROM social_predictions WHERE address = ${address}`;
  return { ...row, points: sum.points, ...levelOf(sum.points), achievements: badges.map((b: {event_key: string}) => b.event_key.slice(12)), completed: counts.completed, dailyRemaining: Math.max(0, 3-counts.today) };
}

async function marketBars(): Promise<Candle[]> {
  const r = await fetch(`${FEED}/bars?n=1200`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw Error("Feed unavailable");
  const data = await r.json() as { bars: Candle[]; intervalMs: number };
  if (data.intervalMs !== 500 || !Array.isArray(data.bars) || !data.bars.length) throw Error("Market history unavailable");
  return data.bars;
}

/** Evaluated against server market history, never P&L or accuracy supplied by a browser. */
export async function settlePredictions() {
  if (!sql) return;
  const due = await sql`SELECT * FROM social_predictions WHERE status = 'pending' AND starts_at + seconds * 1000 < ${Date.now()-2000} ORDER BY starts_at LIMIT 100`;
  if (!due.length) return;
  const bars = await marketBars();
  for (const row of due) {
    const start = Number(row.starts_at), count = row.seconds * 2;
    const run = bars.filter(b => b.t * 1000 >= start && b.t * 1000 < start + row.seconds * 1000);
    const contiguous = run.length === count && run.every((b, i) => b.t * 1000 === start + i * 500);
    if (!contiguous) {
      if (Date.now() - start > 9 * 60_000) await sql`UPDATE social_predictions SET status = 'expired' WHERE id = ${row.id} AND status = 'pending'`;
      continue;
    }
    const score = scorePrediction(row.pts as Pt[], row.entry, run);
    if (!score) continue;
    await sql.begin(async tx => {
      await tx`SELECT address FROM social_profiles WHERE address = ${row.address} FOR UPDATE`;
      const changed = await tx`UPDATE social_predictions SET status = 'scored', accuracy = ${score.accuracy} WHERE id = ${row.id} AND status = 'pending' RETURNING id`;
      if (!changed.length) return;
      await tx`INSERT INTO social_points(address,event_key,points) VALUES (${row.address},${`prediction:${row.id}`},${score.points}) ON CONFLICT DO NOTHING`;
      const [n] = await tx`SELECT COUNT(*)::int AS count FROM social_predictions WHERE address = ${row.address} AND status = 'scored'`;
      const awards: [string,number][] = [["first_prediction",10]];
      if (n.count >= 5) awards.push(["five_predictions",20]);
      if (score.accuracy >= .7) awards.push(["sharp_eye",20]);
      for (const [badge, points] of awards) await tx`INSERT INTO social_points(address,event_key,points) VALUES (${row.address},${`achievement:${badge}`},${points}) ON CONFLICT DO NOTHING`;
    });
  }
}

export async function socialRoute(req: Request): Promise<Response> {
  if (!sql) return json({ error: "Profiles need the database" }, 503);
  const path = new URL(req.url).pathname;
  const body = req.method === "POST" ? await req.json().catch(() => null) as Record<string, unknown> | null : null;
  if (req.method === "POST" && (!body || typeof body !== "object")) return json({ error: "Invalid request" }, 400);
  if (path === "/social/challenge" && body) {
    const address = addressOf(body.address), username = usernameOf(body.username);
    if (!address || !username) return json({ error: "Use 3–20 letters, numbers or underscores, starting with a letter." }, 400);
    const [existing] = await sql`SELECT username FROM social_profiles WHERE address = ${address}`;
    if (existing && existing.username !== username) return json({error:`This wallet already owns @${existing.username}. Use that name to reconnect.`},409);
    const [used] = await sql`SELECT address FROM social_profiles WHERE username = ${username} AND address <> ${address}`;
    if (used) return json({ error: "That username is taken." }, 409);
    const [recent] = await sql`SELECT COUNT(*)::int AS n FROM social_challenges WHERE address = ${address} AND expires_at > now()`;
    if (recent.n >= 5) return json({ error: "Please wait a few minutes before trying again." }, 429);
    const id = randomBytes(24).toString("hex"), expires = new Date(Date.now()+300000);
    const message = `Skech player profile\nClaim @${username} and sign in to Skech points.\nWallet: ${address}\nNonce: ${id}\nExpires: ${expires.toISOString()}\nThis does not authorize a trade or transfer.`;
    await sql`INSERT INTO social_challenges(id,address,username,message,expires_at) VALUES (${id},${address},${username},${message},${expires})`;
    return json({ id, message });
  }
  if (path === "/social/claim" && body) {
    const [challenge] = await sql`SELECT * FROM social_challenges WHERE id = ${String(body.id)} AND expires_at > now()`;
    if (!challenge || typeof body.signature !== "string") return json({ error: "Signature request expired." }, 401);
    const valid = await verifyMessage({ address: challenge.address, message: challenge.message, signature: body.signature as `0x${string}` }).catch(() => false);
    if (!valid) return json({ error: "Wallet signature did not match." }, 401);
    const token = randomBytes(32).toString("hex");
    try {
      await sql.begin(async tx => {
        const consumed = await tx`DELETE FROM social_challenges WHERE id = ${challenge.id} AND expires_at > now() RETURNING id`;
        if (!consumed.length) throw Error("expired");
        await tx`INSERT INTO social_profiles(address,username,buddy) VALUES (${challenge.address},${challenge.username},${buddyOf(body.buddy)}) ON CONFLICT(address) DO NOTHING`;
        await tx`INSERT INTO social_sessions(token_hash,address,expires_at) VALUES (${hash(token)},${challenge.address},${new Date(Date.now()+7*86400000)})`;
        await tx`INSERT INTO social_points(address,event_key,points) VALUES (${challenge.address},'achievement:founding_skecher',50) ON CONFLICT DO NOTHING`;
      });
    } catch { return json({ error: "Claim expired or username was just taken. Please try again." }, 409); }
    return json({ token, profile: await profile(challenge.address) });
  }
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
    const pts = body.pts as Pt[], seconds = Number(body.seconds);
    if (!Array.isArray(pts) || pts.length < 2 || pts.length > 256 || !Number.isInteger(seconds) || seconds < 10 || seconds > 300 || pts[0].t !== 0 || pts.at(-1)?.t !== 1 || pts.some((p,i)=>!Number.isFinite(p.t)||!Number.isFinite(p.price)||p.price<=0||p.t<0||p.t>1||(i>0&&p.t<=pts[i-1].t))) return json({error:"Draw a prediction lasting 10–300 seconds."},400);
    const bars = await marketBars();
    const head = bars.at(-1)!;
    if (Date.now() - head.t * 1000 > 5000) return json({error:"Waiting for live market data."},503);
    const entry = head.c, offset = entry - pts[0].price;
    const shifted = pts.map(p=>({t:p.t,price:p.price+offset}));
    if (shifted.some(p=>!Number.isFinite(p.price) || p.price <= 0) || shapeOf(shifted,entry)?.flat !== false) return json({error:"Draw a clearer prediction to earn points."},400);
    const id = crypto.randomUUID(), start = Math.ceil(Date.now()/500)*500;
    try {
      await sql.begin(async tx=>{
        await tx`SELECT address FROM social_profiles WHERE address = ${address} FOR UPDATE`;
        const [n] = await tx`SELECT COUNT(*)::int AS n FROM social_predictions WHERE address = ${address} AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
        if(n.n>=3)throw Error("daily");
        await tx`INSERT INTO social_predictions(id,address,pts,entry,starts_at,seconds) VALUES (${id},${address},${shifted}::jsonb,${entry},${start},${seconds})`;
      });
    } catch {return json({error:"One scored prediction at a time, up to three per UTC day."},409);}
    return json({id,endsAt:start+seconds*1000});
  }
  return json({ error: "Not found" },404);
}
