import { ed25519 } from "@noble/curves/ed25519";
import { getAddressEncoder, isAddress as isSolanaAddress } from "@solana/kit";
import { indexSolana } from "./solana-indexer";
import { randomBytes, createHash } from "node:crypto";
import { verifyMessage, isAddress, type Hex } from "viem";
import type { ServerWebSocket } from "bun";
import { socialPlayer, socialWindows, type PublicDrawing, type SocialActivity, type SocialMessage, type SocialWindow } from "@skech/core/social";
import { indexChain, type SocialConfig } from "./indexer";
import { SocialStore, type Placement, type Settlement } from "./store";
import type { Placed } from "../sequencer";

declare const self: Worker;
const log = (message: string) => self.postMessage({ log: message });
let store: SocialStore | null = null;
let counting = true, progress = 0;
const clients = new Set<ServerWebSocket<null>>();
const activity: SocialActivity[] = [];
const pendingSnapshots = new Map<ServerWebSocket<null>, string[]>();
let queue = Promise.resolve();
const challenges = new Map<string, { player: string; action: string; payload: string; message: string; expires: number }>();
const rates = new Map<string, { at: number; count: number }>();
const origins = new Set((process.env.SOCIAL_ALLOWED_ORIGINS ?? "http://localhost:3101,http://127.0.0.1:3101").split(",").map(s => s.trim()).filter(Boolean));
const json = (value: unknown) => JSON.stringify(value);
let solana = false;
const validPlayer = (value: unknown): value is string => typeof value === "string" && (solana ? isSolanaAddress(value) : isAddress(value));
const broadcast = (message: SocialMessage) => { const encoded = json(message); for (const ws of clients) { if (pendingSnapshots.has(ws)) { const buffer = pendingSnapshots.get(ws)!; if (buffer.length >= 500) ws.close(1013, "Reconnect for a fresh snapshot"); else buffer.push(encoded); } else if (ws.send(encoded) === -1) ws.close(1013, "Reconnect for a fresh snapshot"); } };
function changed(drawing: PublicDrawing | null, kind: "placed" | "settled", event: string) {
  if (!drawing || !store) return;
  const item = store.activity(drawing, kind, event);
  activity.unshift(item); activity.length = Math.min(60, activity.length);
  broadcast({ type: "drawing", drawing, activity: item });
}
function status(next: boolean, fraction: number) {
  if (counting === next && Math.abs(progress - fraction) < 0.01) return;
  counting = next; progress = fraction;
  broadcast({ type: "status", counting, progress });
}
function windowOf(url: URL): SocialWindow { const value = url.searchParams.get("window"); return socialWindows.includes(value as SocialWindow) ? value as SocialWindow : "all"; }
function profilePayload(payload: unknown): { username: string; bio: string; image?: string | null } {
  if (!payload || typeof payload !== "object") throw new Error("Choose a username");
  const p = payload as Record<string, unknown>;
  if (typeof p.username !== "string" || !/^[a-z][a-z0-9_]{2,23}$/.test(p.username)) throw new Error("Use 3–24 lowercase letters, numbers or underscores; start with a letter");
  if (typeof p.bio !== "string" || p.bio.length > 160) throw new Error("Keep your bio under 160 characters");
  if (p.image !== undefined && p.image !== null) {
    if (typeof p.image !== "string" || p.image.length > 350_000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(p.image)) throw new Error("Choose a PNG, JPEG or WebP avatar under 250 KB");
    const bytes = Buffer.from(p.image.split(",")[1], "base64");
    const mime = p.image.slice(11, p.image.indexOf(";"));
    if (!(mime === "png" && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) && !(mime === "jpeg" && bytes[0] === 255 && bytes[1] === 216) && !(mime === "webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")) throw new Error("This avatar is not a supported image");
  }
  return { username: p.username, bio: p.bio, ...(p.image !== undefined ? { image: p.image as string | null } : {}) };
}
async function handle(req: Request, url: URL): Promise<Response> {
  if (!store) return Response.json({ error: "Social features are starting" }, { status: 503 });
  const player = socialPlayer(url.searchParams.get("player") ?? "") || null;
  const viewer = socialPlayer(url.searchParams.get("viewer") ?? "") || null;
  if ((player && !validPlayer(player)) || (viewer && !validPlayer(viewer))) return Response.json({ error: "Invalid player" }, { status: 400 });
  if (req.method === "GET") {
    if (url.pathname === "/health") return Response.json({ ok: true, counting, progress });
    if (url.pathname === "/leaderboard") {
      const rows = await store.board(windowOf(url), viewer, url.searchParams.get("friends") === "1" && Boolean(viewer));
      return Response.json({ rows: rows.slice(0, 100), me: rows.find(row => row.profile.player === viewer) ?? null, counting, progress });
    }
    if (url.pathname === "/identity" && player) return Response.json({ profile: await store.profile(player) });
    if (url.pathname === "/profile" && player) return Response.json(await store.details(player, windowOf(url), viewer, url.searchParams.get("cursor")));
    if (url.pathname === "/following" && player) return Response.json({ players: await store.following(player) });
    if (url.pathname === "/drawing") return Response.json({ drawing: await store.drawing(url.searchParams.get("id") ?? "") });
    if (url.pathname === "/avatar" && player) {
      const image = await store.avatar(player);
      if (!image) return new Response(null, { status: 404 });
      return new Response(Buffer.from(image.split(",")[1], "base64"), { headers: { "content-type": image.slice(5, image.indexOf(";")), "cache-control": "public, max-age=60", "x-content-type-options": "nosniff" } });
    }
  }
  if (req.method === "POST") {
    if (Number(req.headers.get("content-length") ?? 0) > 400_000) return Response.json({ error: "Request too large" }, { status: 413 });
    const raw = await req.text();
    if (raw.length > 400_000) return Response.json({ error: "Request too large" }, { status: 413 });
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid request"); } catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }
    if (url.pathname === "/challenge") {
      if (!validPlayer(body.player) || !["profile", "follow"].includes(String(body.action))) throw new Error("Invalid action");
      if (body.action === "profile") profilePayload(body.payload);
      else {
        const p = body.payload as { target?: string; enabled?: boolean };
        if (!validPlayer(p?.target) || typeof p.enabled !== "boolean" || socialPlayer(p.target) === socialPlayer(body.player)) throw new Error("Invalid follow");
      }
      if (challenges.size >= 2000) throw new Error("Try again in a moment");
      const nonce = randomBytes(24).toString("hex"), expires = Date.now() + 300_000;
      const payload = JSON.stringify(body.payload);
      const message = `skech social\nDeployment: ${store.scope}\nPlayer: ${socialPlayer(body.player)}\nAction: ${body.action}\nPayload: ${createHash("sha256").update(payload).digest("hex")}\nNonce: ${nonce}\nExpires: ${expires}`;
      challenges.set(nonce, { player: socialPlayer(body.player), action: String(body.action), payload, message, expires });
      return Response.json({ nonce, message });
    }
    if (url.pathname === "/profile" || url.pathname === "/follow") {
      const nonce = String(body.nonce ?? ""), challenge = challenges.get(nonce);
      challenges.delete(nonce); // Consume before verification, including concurrent requests.
      if (!challenge || challenge.expires < Date.now() || challenge.action !== url.pathname.slice(1) || typeof body.signature !== "string" || !(solana ? /^[A-Za-z0-9+/]{86}==$/.test(body.signature) : /^0x[0-9a-f]{130}$/i.test(body.signature))) return Response.json({ error: "Please sign again" }, { status: 401 });
      if (!(solana ? ed25519.verify(Buffer.from(body.signature, "base64"), new TextEncoder().encode(challenge.message), new Uint8Array(getAddressEncoder().encode(challenge.player as Parameters<ReturnType<typeof getAddressEncoder>["encode"]>[0]))) : await verifyMessage({ address: challenge.player as `0x${string}`, message: challenge.message, signature: body.signature as Hex }))) return Response.json({ error: "Signature does not match your wallet" }, { status: 401 });
      const payload = JSON.parse(challenge.payload);
      if (challenge.action === "profile") {
        const p = profilePayload(payload);
        const profile = await store.edit(challenge.player, p.username, p.bio, p.image);
        broadcast({ type: "profile", profile });
        return Response.json({ profile });
      }
      await store.follow(challenge.player, socialPlayer(payload.target), payload.enabled);
      return Response.json({ ok: true });
    }
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}

async function start(cfg: SocialConfig) {
  const database = process.env.SOCIAL_DATABASE_URL;
  if (!database || !/^postgres(?:ql)?:\/\//.test(database)) { log("Set SOCIAL_DATABASE_URL to your Supabase/Postgres connection string to enable profiles and live activity."); return; }
  solana = cfg.kind === "solana";
  store = new SocialStore(database, `${cfg.chainId}:${socialPlayer(cfg.game)}`, solana ? "skech_social_solana" : "skech_social");
  await store.start();
  const server = Bun.serve<null>({
    port: Number(process.env.SOCIAL_PORT ?? 3105),
    hostname: "127.0.0.1",
    maxRequestBodySize: 400_000,
    async fetch(req, server) {
      const origin = req.headers.get("origin");
      if (origin && !origins.has(origin)) return new Response("Origin not allowed", { status: 403 });
      const headers = new Headers({ "vary": "Origin", "cache-control": "no-store" });
      if (origin) headers.set("access-control-allow-origin", origin);
      headers.set("access-control-allow-methods", "GET, POST, OPTIONS"); headers.set("access-control-allow-headers", "Content-Type");
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
      const peer = server.requestIP(req)?.address ?? "unknown";
      // The service binds to loopback; Caddy appends the actual peer to X-Forwarded-For.
      const ip = ["127.0.0.1", "::1"].includes(peer) ? req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? peer : peer;
      const rate = rates.get(ip) ?? { at: Date.now(), count: 0 };
      if (Date.now() - rate.at > 60_000) { rate.at = Date.now(); rate.count = 0; }
      rate.count++; rates.set(ip, rate);
      if (rate.count > (req.method === "POST" ? 120 : 600)) return Response.json({ error: "Please slow down" }, { status: 429, headers });
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (clients.size >= 2000) return new Response("Try again soon", { status: 503, headers });
        if (server.upgrade(req, { data: null })) return;
        return new Response("Expected a websocket", { status: 426, headers });
      }
      try {
        const response = await handle(req, url);
        for (const [key, value] of headers) response.headers.set(key, value);
        return response;
      } catch (error) {
        const message = String((error as Error).message);
        const known = /^(Use |Keep |Choose |This avatar|Invalid |Try again)/.test(message);
        const duplicate = /unique|duplicate/i.test(message);
        if (!known && !duplicate) log("A social request failed; check database connectivity.");
        return Response.json({ error: duplicate ? "That username is already taken" : known ? message : "Could not load this right now. Try again." }, { status: duplicate ? 409 : known ? 400 : 503, headers });
      }
    },
    websocket: {
      open(ws) {
        clients.add(ws); pendingSnapshots.set(ws, []);
        // Buffer incremental events while the snapshot query is pending.
        queue = queue.then(async () => { const drawings = await store!.live(); ws.send(json({ type: "snapshot", drawings, activity, counting, progress })); for (const message of pendingSnapshots.get(ws) ?? []) ws.send(message); pendingSnapshots.delete(ws); }).then(() => undefined).catch(() => ws.close(1011, "Please reconnect"));
      },
      close(ws) { clients.delete(ws); pendingSnapshots.delete(ws); },
      message() {},
      maxPayloadLength: 1024,
      idleTimeout: 120,
    },
  });
  setInterval(() => {
    for (const [key, c] of challenges) if (c.expires < Date.now()) challenges.delete(key);
    for (const [key, r] of rates) if (Date.now() - r.at > 60_000) rates.delete(key);
    for (const ws of clients) ws.ping();
  }, 30_000);
  log(`Postgres connected; listening on http://127.0.0.1:${server.port}`);
  void (solana ? indexSolana : indexChain)(cfg, store, changed, status, log);
}

self.addEventListener("message", (event: MessageEvent) => {
  if (event.data.type === "start") { queue = queue.then(() => start(event.data.cfg)).catch(() => log("Could not start social features. Check SOCIAL_DATABASE_URL and database permissions.")); return; }
  queue = queue.then(async () => {
    if (!store) return;
    if (event.data.type === "placed") {
      const p = event.data.placement as Placed;
      if (!p.drawing || !p.unit || !p.stroke) return;
      const placement: Placement = { ...p, drawing: p.drawing, unit: p.unit, stroke: p.stroke, sections: p.sections.map(s => ({ ...s, lo: s.lo.toString(), hi: s.hi.toString(), stake: s.stake.toString() })) };
      changed(await store.place(placement), "placed", `${p.tx}:${p.betId}`);
    } else if (event.data.type === "settled") {
      const s = event.data.settlement as Settlement;
      changed(await store.settle(s), "settled", `${s.tx}:${s.betId}:${s.hitMask}:${s.missMask}`);
    }
  }).catch(() => log("An activity update will be recovered by the chain indexer."));
});
