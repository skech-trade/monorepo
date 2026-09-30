/**
 * A player, scripted: registers a session, deposits by permit, draws a few
 * taps ahead of the live price, and waits for the chain to settle them. Run
 * against a relayer (and an engine) on a local chain by `scripts/e2e.ts`, or
 * against testnet by hand.
 *
 *   PLAYER_KEY=0x… RELAYER_URL=ws://localhost:3103/ws bun scripts/player.ts
 *
 * SESSION=p256 signs as the app does: a P-256 key, ECDSA over SHA-256 of the
 * digest, low s, checked on chain through Monad's P-256 precompile. Otherwise
 * an Ethereum key.
 */
import { BarBook } from "@skech/core/bars";
import { betIdOf, encodeStroke, RECEIVE_WITH_AUTHORIZATION_TYPES, gridStep, GRID, LATE_MS, stakeOf, strokeHash, toE6, toE8, toSections, TYPES, unitFor } from "@skech/core/chain";
import { features, openFor, stepFor } from "@skech/core/dots";
import { INK_EDGE_CELLS, newInk, type Stroke } from "@skech/core/ink";
import { p256 } from "@noble/curves/p256";
import { bytesToHex, createPublicClient, hashTypedData, hexToBytes, sha256, type Address, type Hex } from "viem";
import { monadHttp } from "../src/rpc";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const RELAYER = process.env.RELAYER_URL ?? "ws://localhost:3103/ws";
const ENGINE = process.env.NEXT_PUBLIC_ENGINE_URL ?? "ws://localhost:3102/ws";
const RPC = process.env.MONAD_RPC_URL ?? "http://127.0.0.1:8545";
const player = privateKeyToAccount((process.env.PLAYER_KEY ?? generatePrivateKey()) as Hex);
const session = privateKeyToAccount(generatePrivateKey());
const P256 = process.env.SESSION === "p256";
const p256Key = p256.utils.randomPrivateKey();
const p256Pub = p256.getPublicKey(p256Key, false); // 04 ‖ x ‖ y
const p256X = bytesToHex(p256Pub.slice(1, 33));
const p256Y = bytesToHex(p256Pub.slice(33, 65));
const TAPS = Number(process.env.TAPS ?? 4);
const say = (s: string) => console.log(`${new Date().toISOString().slice(11, 23)} player ${s}`);

/* ---- the engine: prices, and the price the player "sees" ---- */
const book = new BarBook();
let skew = 0;
let seen: { priceE8: bigint; time: number; sig: Hex } | null = null;
let engineSigner: Address | null = null;
const engine = new WebSocket(ENGINE);
engine.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.type === "hello") engineSigner = m.signer;
  else if (m.type === "history") for (const [, t, p] of m.trades) book.fold(t, p);
  else if (m.type === "price") {
    skew = skew === 0 ? m.t + 40 - Date.now() : skew * 0.98 + (m.t + 40 - Date.now()) * 0.02;
    book.fold(m.t, m.p);
    if (m.message && m.signature) seen = { priceE8: BigInt(m.message.price), time: m.message.time, sig: m.signature };
  }
};
const now = () => Date.now() + skew;
setInterval(() => book.closeQuiet(now()), 200);

/* ---- the relayer ---- */
type Hello = { chainId: number; game: Address; usdc: Address; difficulty: number; config: { minPerDot: string } };
let hello: Hello | null = null;
const waiting = new Map<string, (m: Record<string, unknown>) => void>();
const results = { placed: 0, refused: 0, settled: 0, hits: 0, paid: 0n, owed: 0n, staked: 0n };
const relayer = new WebSocket(RELAYER);
relayer.onmessage = (e) => {
  const m = JSON.parse(String(e.data)) as Record<string, unknown> & { type: string };
  if (m.type === "hello") hello = m as unknown as Hello;
  else if (m.type === "placed") {
    results.placed++;
    results.staked += BigInt(m.staked as string);
    say(`placed ${String(m.betId).slice(0, 10)} staked ${m.staked} fee ${m.fee} refunded ${m.refunded} rungs ${(m.sections as { rung: number }[]).map((s) => s.rung / 100 + "x").join(" ")}`);
  } else if (m.type === "refused") {
    results.refused++;
    say(`refused ${String(m.betId).slice(0, 10)}: ${m.why}`);
  } else if (m.type === "settled") {
    results.settled++;
    if (Number(m.hitMask) > 0) results.hits++;
    results.paid += BigInt(m.paid as string);
    results.owed += BigInt(m.owed as string);
    say(`settled ${String(m.betId).slice(0, 10)} hit ${m.hitMask} miss ${m.missMask} paid ${m.paid} owed ${m.owed}`);
  } else if (m.type === "account") say(`account balance ${m.balance} owed ${m.owed} session ${(m.session as { validUntil: string }).validUntil}`);
  else if (m.type === "ack") {
    const w = waiting.get(`ack:${m.drawing}:${m.index}`);
    if (w) w(m);
  } else {
    const w = waiting.get(m.type);
    if (w) w(m);
  }
};
const ask = (type: string, msg: unknown, reply: string) =>
  new Promise<Record<string, unknown>>((resolve) => {
    waiting.set(reply, resolve);
    relayer.send(JSON.stringify(msg, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** As WebCrypto signs: ECDSA P-256 over SHA-256 of the digest, r ‖ s, s in the low half. */
const signP256 = (digest: Hex): Hex => bytesToHex(p256.sign(hexToBytes(sha256(digest)), p256Key, { prehash: false, lowS: true }).toCompactRawBytes());

await new Promise<void>((r) => (relayer.onopen = () => r()));
while (!hello || !engineSigner) await sleep(100);
say(`relayer says chain ${hello.chainId}, game ${hello.game}, difficulty ${hello.difficulty}; engine signs as ${engineSigner}`);
const pub = createPublicClient({ transport: monadHttp(RPC) });
const domain = { name: "skech", version: "1", chainId: hello.chainId, verifyingContract: hello.game } as const;
relayer.send(JSON.stringify({ type: "watch", player: player.address }));

/* ---- a deposit, by EIP-3009 authorization: one signature, no allowance ---- */
const usdcAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const [usdcName, usdcVersion, held] = await Promise.all([
  pub.readContract({ address: hello.usdc, abi: usdcAbi, functionName: "name" }),
  pub.readContract({ address: hello.usdc, abi: usdcAbi, functionName: "version" }).catch(() => "1"),
  pub.readContract({ address: hello.usdc, abi: usdcAbi, functionName: "balanceOf", args: [player.address] }),
]);
const amount = held < 50_000_000n ? held : 50_000_000n;
if (amount === 0n) {
  say(`no USDC at ${player.address} on ${hello.usdc}`);
  process.exit(1);
}
const authNonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
const authSig = await player.signTypedData({
  domain: { name: usdcName, version: usdcVersion, chainId: hello.chainId, verifyingContract: hello.usdc },
  types: RECEIVE_WITH_AUTHORIZATION_TYPES,
  primaryType: "ReceiveWithAuthorization",
  message: { from: player.address, to: hello.game, value: amount, validAfter: 0n, validBefore, nonce: authNonce },
});
const dep = await ask("deposit", { type: "deposit", owner: player.address, amount, validAfter: 0n, validBefore, nonce: authNonce, sig: authSig }, "deposited");
say(`deposit of ${amount} ${dep.ok ? `done (${dep.tx})` : `failed: ${dep.why}`}`);
if (!dep.ok) process.exit(1);

/* ---- a session, signed by the wallet: the relayer pays for one only once there is money in ---- */
const nonce = (await pub.readContract({ address: hello.game, abi: [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "nonces", args: [player.address] })) as bigint;
const validUntil = BigInt(Math.floor(Date.now() / 1000) + 3600);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
const allowance = 1_000_000_000n;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const keyFields = P256
  ? { kind: 1, key: "0x0000000000000000000000000000000000000000" as Address, x: p256X, y: p256Y }
  : { kind: 0, key: session.address, x: ZERO32, y: ZERO32 };
const sessionSig = await player.signTypedData({ domain, types: TYPES, primaryType: "Session", message: { player: player.address, ...keyFields, validUntil, allowance, nonce, deadline } });
const set = await ask("session", { type: "session", player: player.address, ...keyFields, validUntil, allowance, deadline, sig: sessionSig }, "session-set");
say(`${P256 ? "P-256" : "Ethereum"} session ${set.ok ? `set (${set.tx})` : `failed: ${set.why}`}`);
if (!set.ok) process.exit(1);

/* ---- drawing: taps on the price a couple of seconds ahead, as the app would ---- */
while (book.bars.length < 320 || !seen) await sleep(200);
const drawing = BigInt(Date.now());
const perDot = toE6(0.1);
for (let i = 0; i < TAPS; i++) {
  const t = now();
  const openAt = openFor(t + LATE_MS);
  const f = features(book.bars, Math.floor(t / 1000) * 1000)!;
  const marketStep = stepFor(f.sigma, f.price);
  const unit = unitFor(marketStep);
  const step = gridStep(marketStep);
  // A tap 2.5 s ahead, at the price, with a medium pen: 0.7 steps wide, the nib's radius in time 300 ms.
  const price = book.last!.c + (i % 2 === 0 ? 0 : marketStep * 0.4);
  const stroke: Stroke = { t0: openAt + 2500, p0: price, pts: [{ t: 0, p: 0 }], rt: 300, rp: marketStep * 0.35 };
  const cells = newInk(stroke, null, openAt, step);
  const sections = toSections(cells, openAt, perDot, unit);
  if (!sections.length) {
    say(`tap ${i}: nothing in play`);
    continue;
  }
  const strokeBytes = encodeStroke({ t0: stroke.t0, p0: stroke.p0, rt: stroke.rt, rp: stroke.rp, from: 0, pts: stroke.pts });
  const piece = { player: player.address, drawing, index: i, market: 0, difficulty: hello.difficulty, openAt: BigInt(openAt), perDot, unit: toE8(unit), priceSeen: seen.priceE8, priceTime: BigInt(seen.time), sections, strokeHash: strokeHash(strokeBytes) };
  const sig = P256 ? signP256(hashTypedData({ domain, types: TYPES, primaryType: "Piece", message: piece })) : await session.signTypedData({ domain, types: TYPES, primaryType: "Piece", message: piece });
  const ack = await ask("piece", { type: "piece", piece: { ...piece, drawing: drawing.toString(), openAt: piece.openAt.toString(), perDot: perDot.toString(), unit: piece.unit.toString(), priceSeen: piece.priceSeen.toString(), priceTime: piece.priceTime.toString(), sections: sections.map((s) => ({ second: s.second, lo: s.lo.toString(), hi: s.hi.toString(), stake: s.stake.toString() })) }, sessionSig: sig, priceSig: seen.sig, stroke: strokeBytes }, `ack:${drawing}:${i}`);
  say(`tap ${i}: ${sections.length} sections, stake ${stakeOf(sections)}, opens ${openAt}: ${ack.ok ? "accepted" : `refused: ${ack.why}`} ${betIdOf(player.address, drawing, i).slice(0, 10)}`);
  await sleep(1100);
}

/* ---- wait for the chain to settle them ---- */
const until = Date.now() + 25_000;
while (Date.now() < until && results.settled < results.placed) await sleep(250);
say(`placed ${results.placed} refused ${results.refused} settled ${results.settled} hits ${results.hits} staked ${results.staked} paid ${results.paid} owed ${results.owed}`);

/* ---- and take the money out, by signature ---- */
const nonce2 = (await pub.readContract({ address: hello.game, abi: [{ type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "nonces", args: [player.address] })) as bigint;
// Its own deadline: the one above was signed before the engine had the minutes of history pricing waits for.
const wdeadline = BigInt(Math.floor(Date.now() / 1000) + 300);
const wsig = await player.signTypedData({ domain, types: TYPES, primaryType: "Withdraw", message: { player: player.address, amount: 1_000_000n, to: player.address, nonce: nonce2, deadline: wdeadline } });
const w = await ask("withdraw", { type: "withdraw", player: player.address, amount: 1_000_000n, to: player.address, deadline: wdeadline, sig: wsig }, "withdrawn");
say(`withdraw of 1 USDC ${w.ok ? `done (${w.tx})` : `failed: ${w.why}`}`);
const ok = results.placed > 0 && results.settled > 0 && !!w.ok;
say(ok ? "OK" : "FAILED");
process.exit(ok ? 0 : 1);
