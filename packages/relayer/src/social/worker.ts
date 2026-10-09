/**
 * The social service, in a worker of its own so nothing it does holds up a drawing: HTTP and a WebSocket on
 * 127.0.0.1:SOCIAL_PORT (3105), behind Caddy's /social/*. The relayer tells it what it placed and settled
 * (bridge.ts); the chain tells it the rest (solana-indexer.ts).
 *
 *   GET  /health, /leaderboard, /identity, /profile, /following, /drawing, /avatar
 *   POST /challenge, then /profile or /follow with the wallet's signature (auth.ts)
 *   WS   /ws   a snapshot of the live feed, then each drawing as it changes
 *
 * Without SOCIAL_DATABASE_URL it does nothing; with a database that is down it answers 503 and tries again, and the
 * game never waits for it.
 */
import type { Server, ServerWebSocket } from "bun";
import { cleanBio, socialWindows, usernameProblem, type PlayerProfile, type PublicDrawing, type SocialActivity, type SocialMessage, type SocialWindow } from "@skech/core/social";
import { Bucket, clientIp, Door, remember } from "../limits";
import { AVATAR_BYTES, avatarHeaders, parseAvatar } from "./avatar";
import { Challenges, isPlayer, Unauthorized } from "./auth";
import { SolanaIndexer, type IndexerConfig } from "./solana-indexer";
import { SocialStore, type Placement, type Settlement } from "./store";

declare const self: Worker;
const log = (message: string) => self.postMessage({ log: message });

/** The largest request: an avatar's data URL and the rest of a profile. */
const BODY_BYTES = Math.ceil(AVATAR_BYTES / 3) * 4 + 8 * 1024;
/** Updates from the relayer waiting on the database: past this, they are dropped and the indexer recovers them. */
const MOST_WAITING = 5_000;
const SNAPSHOT_BUFFER = 500;

let store: SocialStore | null = null;
let challenges: Challenges | null = null;
let indexer: SolanaIndexer | null = null;
let counting = true, progress = 0;
let activity: SocialActivity[] = [];
const clients = new Set<ServerWebSocket<Socket>>();
const door = new Door(2_000, 8);
type Socket = { ip: string; buffer: string[] | null };

/* ---- how much one address, and one wallet, may ask ---- */
const byIp = new Map<string, { read: Bucket; write: Bucket }>();
const byPlayer = new Map<string, Bucket>();
function allowed(ip: string, write: boolean) {
  let b = byIp.get(ip);
  if (!b) remember(byIp, ip, (b = { read: new Bucket(120, 10), write: new Bucket(20, 0.5) }), 20_000);
  return write ? b.write.take() : b.read.take();
}
function allowedPlayer(player: string) {
  let b = byPlayer.get(player);
  if (!b) remember(byPlayer, player, (b = new Bucket(10, 1 / 6)), 20_000);
  return b.take();
}

const origins = new Set((process.env.SOCIAL_ALLOWED_ORIGINS ?? "http://localhost:3101,http://127.0.0.1:3101").split(",").map((s) => s.trim()).filter(Boolean));

/* ---- the live feed ---- */
function send(ws: ServerWebSocket<Socket>, text: string) {
  if (ws.data.buffer) {
    if (ws.data.buffer.length >= SNAPSHOT_BUFFER) ws.close(1013, "Reconnect for a fresh snapshot");
    else ws.data.buffer.push(text);
  } else if (ws.send(text) === -1) ws.close(1013, "Reconnect for a fresh snapshot");
}
const broadcast = (message: SocialMessage) => {
  const text = JSON.stringify(message);
  for (const ws of clients) send(ws, text);
};
function changed(drawing: PublicDrawing | null, kind: "placed" | "settled", event: string) {
  if (!drawing || !store) return;
  const item = store.activity(drawing, kind, event);
  activity = [item, ...activity.filter((a) => a.id !== item.id)].slice(0, 60);
  broadcast({ type: "drawing", drawing, activity: item });
}
function status(next: boolean, fraction: number) {
  if (counting === next && Math.abs(progress - fraction) < 0.01) return;
  counting = next;
  progress = fraction;
  broadcast({ type: "status", counting, progress });
}
/** The feed's first look, made at most once a second however many connect at once. */
let snapshot: { at: number; text: Promise<string> } | null = null;
function snapshotText() {
  if (!snapshot || Date.now() - snapshot.at > 1000) {
    // What happened since this service started, then the newest from the database: the history read from the
    // chain is never news as it arrives, but a feed opened after it should still show it.
    const text = Promise.all([store!.live(), store!.recent(30)]).then(([drawings, recent]) => {
      const told = new Set(activity.map((a) => a.drawing));
      const merged = [...activity, ...recent.filter((a) => !told.has(a.drawing))].sort((a, b) => b.at - a.at).slice(0, 60);
      return JSON.stringify({ type: "snapshot", drawings, activity: merged, counting, progress } satisfies SocialMessage);
    });
    snapshot = { at: Date.now(), text };
    text.catch(() => {
      snapshot = null;
    });
  }
  return snapshot.text;
}

/* ---- requests ---- */
class Refusal extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}
const windowOf = (url: URL): SocialWindow => {
  const v = url.searchParams.get("window");
  return socialWindows.includes(v as SocialWindow) ? (v as SocialWindow) : "all";
};
function playerParam(url: URL, name: string): string | null {
  const v = url.searchParams.get(name);
  if (!v) return null;
  if (!isPlayer(v)) throw new Refusal("Invalid player");
  return v;
}
/** A profile change as asked: checked the same before the challenge and after the signature. */
function profileChange(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Refusal("Choose a username");
  const p = payload as Record<string, unknown>;
  const problem = usernameProblem(p.username);
  if (problem) throw new Refusal(problem);
  let bio: string;
  try {
    bio = cleanBio(p.bio ?? "");
  } catch (e) {
    throw new Refusal((e as Error).message);
  }
  let image: ReturnType<typeof parseAvatar> | null | undefined;
  try {
    image = p.image === undefined ? undefined : p.image === null ? null : parseAvatar(p.image);
  } catch (e) {
    throw new Refusal((e as Error).message);
  }
  return { username: p.username as string, bio, image };
}
function followChange(player: string, payload: unknown) {
  const p = payload as { target?: unknown; enabled?: unknown } | null;
  if (!p || !isPlayer(p.target) || typeof p.enabled !== "boolean" || p.target === player) throw new Refusal("Invalid follow");
  return { target: p.target, enabled: p.enabled };
}

async function get(url: URL): Promise<Response> {
  const s = store!;
  switch (url.pathname) {
    case "/leaderboard": {
      const viewer = playerParam(url, "viewer");
      const rows = await s.board(windowOf(url), viewer, url.searchParams.get("friends") === "1" && viewer !== null);
      return Response.json({ rows: rows.slice(0, 100), me: rows.find((r) => r.profile.player === viewer) ?? null, counting, progress });
    }
    case "/identity": {
      const player = playerParam(url, "player");
      if (!player) break;
      return Response.json({ profile: await s.profile(player) });
    }
    case "/profile": {
      const player = playerParam(url, "player");
      if (!player) break;
      const cursor = url.searchParams.get("cursor");
      if (cursor && cursor.length > 200) throw new Refusal("Invalid history cursor");
      try {
        return Response.json(await s.details(player, windowOf(url), playerParam(url, "viewer"), cursor));
      } catch (e) {
        if ((e as Error).message === "Invalid history cursor") throw new Refusal("Invalid history cursor");
        throw e;
      }
    }
    case "/following": {
      const player = playerParam(url, "player");
      if (!player) break;
      return Response.json({ players: await s.following(player) });
    }
    case "/drawing": {
      const id = url.searchParams.get("id") ?? "";
      const [player, n, extra] = id.split(":");
      if (!isPlayer(player) || !/^\d{1,20}$/.test(n ?? "") || extra !== undefined) throw new Refusal("Invalid drawing");
      return Response.json({ drawing: await s.drawing(id) });
    }
    case "/avatar": {
      const player = playerParam(url, "player");
      if (!player) break;
      const a = await s.avatar(player);
      if (!a) return new Response(null, { status: 404, headers: { "x-content-type-options": "nosniff" } });
      return new Response(Buffer.from(a.bytes), { headers: avatarHeaders(a.mime) });
    }
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}

async function post(req: Request, url: URL, ip: string): Promise<Response> {
  const s = store!, c = challenges!;
  if (Number(req.headers.get("content-length") ?? 0) > BODY_BYTES) throw new Refusal("Request too large", 413);
  const raw = await req.text();
  if (raw.length > BODY_BYTES) throw new Refusal("Request too large", 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Refusal("Invalid request");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Refusal("Invalid request");
  if (url.pathname === "/challenge") {
    const { player, action, payload } = body;
    if (!isPlayer(player) || (action !== "profile" && action !== "follow")) throw new Refusal("Invalid action");
    if (action === "profile") profileChange(payload);
    else followChange(player, payload);
    return Response.json(c.issue(player, action, payload));
  }
  if (url.pathname === "/profile" || url.pathname === "/follow") {
    const action = url.pathname.slice(1);
    const signed = c.take(body.token, body.payload, body.signature);
    if (signed.action !== action) throw new Unauthorized("Please sign again");
    if (!allowedPlayer(signed.player)) throw new Refusal("Please slow down", 429);
    if (action === "profile") {
      const p = profileChange(body.payload);
      const profile = await s.edit(signed.player, p.username, p.bio, p.image);
      broadcast({ type: "profile", profile });
      log(`profile ${signed.player.slice(0, 6)}… from ${ip.slice(0, 64)}`);
      return Response.json({ profile } satisfies { profile: PlayerProfile });
    }
    const f = followChange(signed.player, body.payload);
    await s.follow(signed.player, f.target, f.enabled);
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}

function serve(port: number) {
  return Bun.serve<Socket, never>({
    port,
    hostname: "127.0.0.1",
    maxRequestBodySize: BODY_BYTES,
    async fetch(req, server: Server<Socket>) {
      const origin = req.headers.get("origin");
      // A page from anywhere else is refused outright. No Origin at all is a request no browser page made: it may
      // read, and may change something only with a wallet's signature, which every change needs.
      if (origin && !origins.has(origin)) return new Response("Origin not allowed", { status: 403 });
      const headers = new Headers({ vary: "Origin", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      if (origin) headers.set("access-control-allow-origin", origin);
      headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
      headers.set("access-control-allow-headers", "Content-Type");
      headers.set("access-control-max-age", "600");
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
      const ip = clientIp(req, server.requestIP(req)?.address);
      const write = req.method === "POST";
      if (!allowed(ip, write)) return Response.json({ error: "Please slow down" }, { status: 429, headers });
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true, db: store !== null, counting, progress }, { headers });
      if (url.pathname === "/ws") {
        if (!store) return new Response("Starting", { status: 503, headers });
        if (!door.enter(ip)) return new Response("Too many connections", { status: 503, headers });
        if (server.upgrade(req, { data: { ip, buffer: [] } })) return;
        door.leave(ip);
        return new Response("Expected a websocket", { status: 426, headers });
      }
      if (!store) return Response.json({ error: "Community features are starting" }, { status: 503, headers });
      try {
        const response = req.method === "GET" ? await get(url) : write ? await post(req, url, ip) : Response.json({ error: "Method not allowed" }, { status: 405 });
        for (const [k, v] of headers) if (!(k === "cache-control" && response.headers.has("cache-control"))) response.headers.set(k, v);
        return response;
      } catch (e) {
        const message = String((e as Error).message ?? e);
        if (e instanceof Unauthorized) return Response.json({ error: message }, { status: 401, headers });
        if (e instanceof Refusal) return Response.json({ error: message }, { status: e.status, headers });
        if (/duplicate key|unique/i.test(message)) return Response.json({ error: "That username is already taken" }, { status: 409, headers });
        if (/^You can follow up to/.test(message) || message === "Try again in a moment") return Response.json({ error: message }, { status: 429, headers });
        log(`a request failed: ${message.split("\n")[0].slice(0, 160)}`);
        return Response.json({ error: "Could not load this right now. Try again." }, { status: 503, headers });
      }
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        // What changes while the snapshot is read waits for it, then follows it.
        snapshotText().then(
          (text) => {
            if (!clients.has(ws)) return;
            const waiting = ws.data.buffer ?? [];
            ws.data.buffer = null;
            ws.send(text);
            for (const t of waiting) ws.send(t);
          },
          () => ws.close(1011, "Please reconnect"),
        );
      },
      close(ws) {
        clients.delete(ws);
        door.leave(ws.data.ip);
      },
      message() {},
      maxPayloadLength: 1024,
      idleTimeout: 120,
      sendPings: true,
    },
  });
}

/* ---- starting, and what the relayer says ---- */
async function connect(cfg: IndexerConfig, url: string) {
  for (let wait = 5_000; ; wait = Math.min(60_000, wait * 2)) {
    const s = new SocialStore(url, `solana-${cfg.cluster}:${cfg.game}`);
    try {
      await s.start();
      return s;
    } catch (e) {
      const message = String((e as Error).message ?? e).split("\n")[0];
      void s.close().catch(() => undefined);
      // A database for another deployment is not tried again: it never will be this one's.
      if (/^this database is for/.test(message)) throw e;
      log(`no database yet (${message.replace(/postgres(ql)?:\/\/\S+/g, "<db>").slice(0, 120)}); trying again in ${wait / 1000} s`);
      await Bun.sleep(wait);
    }
  }
}

async function start(cfg: IndexerConfig) {
  const url = process.env.SOCIAL_DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    log("SOCIAL_DATABASE_URL is not set: profiles, follows and the leaderboard are off; the game is not affected");
    return;
  }
  const port = Number(process.env.SOCIAL_PORT ?? 3105);
  const server = serve(port);
  log(`listening on http://127.0.0.1:${server.port}; origins ${[...origins].join(", ")}`);
  const s = await connect(cfg, url);
  challenges = new Challenges(s.scope);
  store = s;
  log("Postgres connected");
  const timer = setInterval(() => {
    challenges?.prune();
  }, 30_000);
  timer.unref?.();
  indexer = new SolanaIndexer(cfg, s, changed, status, log);
  await indexer.start();
}

/** Updates in from the relayer, a few at a time; a database that has stopped answering never piles them up. */
let waiting = 0;
let chain: Promise<unknown> = Promise.resolve();
function later(run: (s: SocialStore) => Promise<void>) {
  if (!store) return;
  if (waiting >= MOST_WAITING) return;
  waiting++;
  chain = chain
    .then(() => run(store!))
    .catch(() => undefined)
    .finally(() => waiting--);
}

self.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { type: string; cfg?: IndexerConfig; placement?: Placement; settlement?: Settlement };
  if (data.type === "start" && data.cfg) {
    void start(data.cfg).catch((e) => log(`stopped: ${String((e as Error).message ?? e).split("\n")[0].replace(/postgres(ql)?:\/\/\S+/g, "<db>")}; the game is not affected`));
  } else if (data.type === "placed" && data.placement) {
    const p = data.placement;
    later(async (s) => changed(await s.place(p), "placed", `${p.tx}:${p.betId}`));
  } else if (data.type === "settled" && data.settlement) {
    const st = data.settlement;
    later(async (s) => changed(await s.settle(st), "settled", `${st.tx}:${st.betId}:${st.hitMask}:${st.missMask}`));
  }
});
