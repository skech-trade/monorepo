/**
 * The Solana relayer's door: one WebSocket per app, the same messages as Monad's (`hello`, `watch`, `account`,
 * `piece`, `ack`, `placed`, `refused`, `settled`, `activity`), and one change for everything a wallet signs.
 *
 * A session, a deposit or a withdrawal is a transaction the wallet signs and the relayer pays for:
 *   app → { type: "build", kind: "session" | "deposit" | "withdraw" | "revoke", player, ... }
 *   relayer → { type: "built", id, kind, tx }          base64, the relayer's fee-payer signature already on it
 *   app → { type: "submit", id, tx }                   the same transaction, signed by the wallet (Coinbase or MWA)
 *   relayer → { type: "submitted", id, kind, ok, tx | why }
 * The relayer co-signs nothing it did not build: `submit` sends only the exact message `build` made.
 */
import type { Server as BunServer, ServerWebSocket } from "bun";
import { type Address, address, createNoopSigner, getBase16Decoder, type Instruction } from "@solana/kit";
import { fetchMaybeToken, findAssociatedTokenPda, getApproveInstruction, getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getDepositInstruction, getRevokeSessionInstruction, getSetSessionInstruction, getWithdrawInstruction, playerAddress } from "@skech/contracts/solana/sdk";
import type { Engine } from "../engine";
import type { SolanaChain } from "./chain";
import type { SolanaConfig } from "./config";
import type { Placed, Refused, SolanaPieceMsg, SolanaSequencer } from "./sequencer";
import type { SocialBridge } from "../social/bridge";
import type { Settled, SolanaSettler } from "./settler";

type Data = { id: number; player?: Address };
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const big = (s: unknown) => (typeof s === "string" && /^\d{1,20}$/.test(s) ? BigInt(s) : typeof s === "number" && Number.isInteger(s) && s >= 0 ? BigInt(s) : null);
const addr = (s: unknown): Address | null => {
  try {
    return typeof s === "string" ? address(s) : null;
  } catch {
    return null;
  }
};
const reason = (e: unknown) => String((e as Error).message ?? e).split("\n")[0].slice(0, 160);

export class SolanaServer {
  private clients = new Set<ServerWebSocket<Data>>();
  private byPlayer = new Map<Address, Set<ServerWebSocket<Data>>>();
  private nextId = 1;
  private server: BunServer<Data> | null = null;
  sequencer: SolanaSequencer | null = null;
  settler: SolanaSettler | null = null;
  /** Transactions per player, counted from their account's signatures: fetched on demand, then kept up to date. */
  private sweeping = new Set<Address>();
  private activity = new Map<Address, { at: number; txs: number; newest: string | null; recent: { signature: string; time: number | null }[] }>();

  constructor(
    private readonly cfg: SolanaConfig,
    private readonly engine: Engine,
    private readonly chain: SolanaChain,
    private readonly domain: Uint8Array,
    private readonly log: (s: string) => void,
    private readonly status: () => Record<string, unknown>,
  ) {}

  start() {
    this.server = Bun.serve<Data>({
      port: this.cfg.port,
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname === "/health") return new Response("ok");
        if (url.pathname === "/status") return new Response(json(this.status()), { headers: { "content-type": "application/json" } });
        if (url.pathname === "/ws") {
          if (server.upgrade(req, { data: { id: this.nextId++ } })) return undefined;
          return new Response("expected a websocket", { status: 426 });
        }
        return new Response("skech relayer (Solana): /ws, /health, /status", { status: 404 });
      },
      websocket: {
        open: (ws) => {
          this.clients.add(ws);
          ws.send(json(this.hello()));
        },
        message: (ws, raw) => void this.onMessage(ws, raw),
        close: (ws) => {
          this.clients.delete(ws);
          if (ws.data.player) this.byPlayer.get(ws.data.player)?.delete(ws);
        },
        perMessageDeflate: false,
        maxPayloadLength: 256 * 1024,
      },
    });
    this.log(`listening on ws://localhost:${this.cfg.port}/ws (${this.cfg.net.label})`);
  }

  announce() {
    const text = json(this.hello());
    for (const ws of this.clients) ws.send(text);
  }
  get connections() {
    return this.clients.size;
  }

  hello() {
    const d = this.cfg.deployment;
    return {
      type: "hello",
      chain: "solana",
      cluster: this.cfg.net.cluster,
      label: this.cfg.net.label,
      program: d.program,
      game: d.game,
      usdc: d.usdcMint,
      lookupTable: d.lookupTable,
      domain: getBase16Decoder().decode(this.domain),
      oracle: this.chain.signer.address,
      relayer: this.chain.signer.address,
      engineSigner: this.engine.signer,
      market: { id: this.cfg.market, name: this.cfg.marketName },
      difficulty: this.sequencer?.difficulty ?? null,
      lateMs: this.cfg.lateMs,
      units: this.sequencer?.units() ?? null,
      terms: this.sequencer?.terms ?? null,
      faucet: this.cfg.net.faucet,
      activity: true,
    };
  }

  social: SocialBridge | null = null;
  readonly notify = {
    placed: (p: Placed) => { this.toPlayer(p.player, { type: "placed", ...p }); if (p.unit) this.social?.placed({ ...p, unit: p.unit }); },
    refused: (r: Refused) => this.toPlayer(r.player, { type: "refused", ...r }),
    settled: (s: Settled) => {
      this.social?.settled(s);
      this.sequencer?.credit(s.player, s.paid);
      this.toPlayer(s.player, { type: "settled", ...s });
    },
    owed: (to: Address, value: bigint) => this.toPlayer(to, { type: "owed", value }),
    account: (player: Address) => void this.sendAccount(player),
  };

  private toPlayer(player: Address, msg: unknown) {
    const text = json(msg);
    for (const ws of this.byPlayer.get(player) ?? []) ws.send(text);
  }

  private async sendAccount(player: Address, only?: ServerWebSocket<Data>) {
    try {
      const [p, pool, wallet] = await Promise.all([this.chain.player(player), this.chain.pool(), this.walletUsdc(player)]);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const owed = p && p.iouShares > 0n ? (p.iouShares * (pool.iouIndexAt + pool.iouRate * (now - pool.iouTimeAt > 0n ? now - pool.iouTimeAt : 0n))) / 10n ** 18n : 0n;
      const msg = {
        type: "account",
        player,
        balance: p?.balance ?? 0n,
        session: p ? { key: p.session.key, validUntil: p.session.validUntil, allowance: p.session.allowance } : null,
        owed,
        wallet,
      };
      if (only) only.send(json(msg));
      else this.toPlayer(player, msg);
    } catch (e) {
      this.log(`account ${player}: ${reason(e)}`);
    }
  }

  /** The USDC in the player's own wallet, and how much of it the game may sweep in. */
  private async walletUsdc(player: Address) {
    const [ata] = await findAssociatedTokenPda({ mint: this.cfg.deployment.usdcMint, owner: player, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const t = await fetchMaybeToken(this.chain.rpc, ata);
    if (!t.exists) return { usdc: 0n, approved: 0n };
    const approved = t.data.delegate.__option === "Some" && t.data.delegate.value === this.cfg.deployment.game ? t.data.delegatedAmount : 0n;
    return { usdc: t.data.amount, approved };
  }

  private async onMessage(ws: ServerWebSocket<Data>, raw: string | Buffer) {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return ws.send(json({ type: "error", why: "Not JSON" }));
    }
    const seq = this.sequencer;
    if (!seq) return ws.send(json({ type: "error", why: "Starting up" }));
    switch (msg.type) {
      case "hello":
        return ws.send(json(this.hello()));
      case "watch": {
        const player = addr(msg.player);
        if (!player) return ws.send(json({ type: "error", why: "Bad player" }));
        if (ws.data.player) this.byPlayer.get(ws.data.player)?.delete(ws);
        ws.data.player = player;
        let set = this.byPlayer.get(player);
        if (!set) this.byPlayer.set(player, (set = new Set()));
        set.add(ws);
        return void this.sendAccount(player, ws);
      }
      case "account":
        if (ws.data.player) return void this.sendAccount(ws.data.player, ws);
        return;
      case "activity": {
        const player = addr(msg.player) ?? ws.data.player;
        if (!player) return ws.send(json({ type: "activity", player: null, txs: 0, recent: [], counting: true, progress: 0 }));
        return ws.send(json({ type: "activity", player, ...(await this.countActivity(player)) }));
      }
      case "sweep": {
        // The app saw USDC land in the wallet: move it in now rather than on the next round, once at a time.
        const player = ws.data.player;
        if (!player || !this.settler || this.sweeping.has(player)) return;
        this.sweeping.add(player);
        void this.settler.sweepIn(player).finally(() => this.sweeping.delete(player));
        return;
      }
      case "piece": {
        const m = msg as unknown as SolanaPieceMsg;
        const r = await seq.accept(m);
        return ws.send(json({ type: "ack", ...r, index: m.piece?.index, drawing: m.piece?.drawing }));
      }
      case "build": {
        try {
          const built = await this.build(msg);
          return ws.send(json({ type: "built", kind: msg.kind, ...built }));
        } catch (e) {
          return ws.send(json({ type: "built", kind: msg.kind, ok: false, why: reason(e) }));
        }
      }
      case "submit": {
        const id = typeof msg.id === "string" ? msg.id : "";
        try {
          const { kind, player, sent } = await this.chain.submit(id, String(msg.tx ?? ""));
          seq.forget(player);
          if (sent.err) ws.send(json({ type: "submitted", id, kind, ok: false, why: `Failed on chain: ${json(sent.err)}`, tx: sent.signature }));
          else {
            if (kind === "session" && msg.approve) this.settler?.approve(player);
            // The new balance first, then the answer, as on Monad.
            await this.sendAccount(player);
            ws.send(json({ type: "submitted", id, kind, ok: true, tx: sent.signature }));
          }
        } catch (e) {
          ws.send(json({ type: "submitted", id, ok: false, why: reason(e) }));
        }
        return;
      }
      default:
        return ws.send(json({ type: "error", why: `Unknown message ${String(msg.type)}` }));
    }
  }

  /** A transaction for the player's wallet to sign, the relayer paying. */
  private async build(msg: Record<string, unknown>) {
    const player = addr(msg.player);
    if (!player) throw new Error("Bad player");
    const d = this.cfg.deployment;
    const me = this.chain.signer;
    const wallet = createNoopSigner(player);
    const playerPda = await playerAddress(player, d.program);
    const [ata] = await findAssociatedTokenPda({ mint: d.usdcMint, owner: player, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const ixs: Instruction[] = [];
    let units = 60_000;
    switch (msg.kind) {
      case "session": {
        const key = addr(msg.key);
        const until = big(msg.validUntil);
        const allowance = big(msg.allowance);
        if (!key || until === null || allowance === null) throw new Error("Bad session");
        ixs.push(getSetSessionInstruction({ payer: me, authority: wallet, game: d.game, player: playerPda, key, validUntil: until, allowance }));
        // Optionally, a standing approval: USDC that lands in the wallet is swept into the balance by itself.
        const approve = big(msg.approve);
        if (approve !== null && approve > 0n) {
          ixs.push(getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata, owner: player, mint: d.usdcMint }));
          ixs.push(getApproveInstruction({ source: ata, delegate: d.game, owner: wallet, amount: approve }));
          units = 90_000;
        }
        break;
      }
      case "deposit": {
        const amount = big(msg.amount);
        if (!amount) throw new Error("Bad amount");
        ixs.push(getDepositInstruction({ payer: me, authority: wallet, game: d.game, player: playerPda, from: ata, vault: d.vault, usdcMint: d.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS, amount }));
        break;
      }
      case "withdraw": {
        const amount = big(msg.amount);
        const to = addr(msg.to) ?? player;
        if (!amount) throw new Error("Bad amount");
        const [toAta] = await findAssociatedTokenPda({ mint: d.usdcMint, owner: to, tokenProgram: TOKEN_PROGRAM_ADDRESS });
        ixs.push(getCreateAssociatedTokenIdempotentInstruction({ payer: me, ata: toAta, owner: to, mint: d.usdcMint }));
        ixs.push(getWithdrawInstruction({ authority: wallet, game: d.game, player: playerPda, to: toAta, vault: d.vault, usdcMint: d.usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS, amount }));
        units = 80_000;
        break;
      }
      case "revoke":
        ixs.push(getRevokeSessionInstruction({ authority: wallet, player: playerPda }));
        break;
      default:
        throw new Error(`Unknown kind ${String(msg.kind)}`);
    }
    return this.chain.build(String(msg.kind), player, ixs, units);
  }

  private async countActivity(player: Address) {
    const pda = await playerAddress(player, this.cfg.deployment.program);
    const c = this.activity.get(player) ?? { at: 0, txs: 0, newest: null, recent: [] };
    if (Date.now() - c.at > 10_000) {
      // Newer signatures than we had, page by page: every transaction that touched the player's account.
      let before: string | undefined;
      const fresh: { signature: string; time: number | null }[] = [];
      for (let page = 0; page < 20; page++) {
        const sigs = await this.chain.rpc
          .getSignaturesForAddress(pda, { limit: 1000, ...(before ? { before: before as never } : {}), ...(c.newest ? { until: c.newest as never } : {}) })
          .send()
          .catch(() => []);
        fresh.push(...sigs.map((s) => ({ signature: s.signature as string, time: s.blockTime === null ? null : Number(s.blockTime) })));
        if (sigs.length < 1000) break;
        before = sigs.at(-1)!.signature;
      }
      c.txs += fresh.length;
      if (fresh.length) c.newest = fresh[0].signature;
      c.recent = [...fresh, ...c.recent].slice(0, 20);
      c.at = Date.now();
      this.activity.set(player, c);
    }
    return { txs: c.txs, recent: c.recent, explorer: this.cfg.net.explorer("address", pda), counting: false, progress: 1 };
  }
}
