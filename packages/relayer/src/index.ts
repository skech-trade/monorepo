/**
 * skech relayer, on Solana: prices what players draw, attests it, and puts it on chain for them; posts the price
 * every second and settles on it; pays off IOUs and moves the fees out. The one process that holds the oracle's
 * key besides the engine.
 *
 *   bun run dev:relayer     (from the repo root; SKECH_SOLANA_CLUSTER, SOLANA_RELAYER_KEYPAIR in .env.local)
 *
 *   ws://localhost:3104/ws   apps connect here
 *   GET /health, GET /status
 */
import { report, survive, trail } from "./sentry";
import { join } from "node:path";
import { domainFor } from "@skech/contracts/solana/sdk";
import { Engine } from "./engine";
import { Pricer } from "./pricer";
import { SolanaChain } from "./solana/chain";
import { scfg } from "./solana/config";
import { SolanaSequencer } from "./solana/sequencer";
import { SolanaServer } from "./solana/server";
import { SolanaSettler } from "./solana/settler";

const log = (s: string) => {
  console.error(`${new Date().toISOString().slice(11, 23)} ${s}`);
  trail(s);
};
survive(log);

const started = Date.now();
const pricer = new Pricer(await Bun.file(scfg.libPath).arrayBuffer(), log);
log(`paths: ${await pricer.ready} from ${scfg.libPath}`);

const chain = new SolanaChain(scfg, log);
await chain.start();
const [game, difficulty, lamports] = await Promise.all([chain.game(), chain.difficulty(), chain.lamports()]);
const domain = await domainFor(scfg.deployment.program, scfg.net.cluster);
if (!domain.every((b, i) => b === game.domain[i])) throw new Error(`the game's domain is not ${scfg.net.cluster}'s: is SKECH_SOLANA_CLUSTER right?`);
log(`${scfg.net.label}: game ${scfg.deployment.game}, oracle ${game.oracle}, difficulty ${difficulty}, relayer ${chain.signer.address} holds ${Number(lamports) / 1e9} SOL`);
if (game.oracle !== chain.signer.address) {
  log("WARNING: this relayer's key is not the game's oracle; every placement and bar will be refused");
  report("not-oracle", `relayer ${chain.signer.address} is not the Solana game's oracle ${game.oracle}`);
}
scfg.lateMs = game.config.lateMs;

const engine = new Engine(scfg.engineUrl, log, scfg.engineSigner);
engine.start();

let sequencer: SolanaSequencer;
let settler: SolanaSettler;
const server: SolanaServer = new SolanaServer(scfg, engine, chain, domain, log, (): Record<string, unknown> => ({
  up: Math.round((Date.now() - started) / 1000),
  engine: { connected: engine.connected, ready: engine.ready(), bars: engine.book.bars.length, skew: Math.round(engine.skew), signer: engine.signer },
  chain: { cluster: scfg.net.cluster, program: scfg.deployment.program, relayer: chain.signer.address, inflight: chain.inflight, priority: chain.priority, sends: chain.stats },
  rpc: { perSec: chain.budget.perSec, waiting: chain.budget.waiting, ...chain.budget.stats, statusPolls: chain.confirmations.polls },
  difficulty: sequencer.difficulty,
  connections: server.connections,
  pieces: sequencer.stats,
  settling: { ...settler.stats, seconds: settler.watchers() },
}));
settler = new SolanaSettler(scfg, engine, chain, server.notify, log, join(scfg.stateDir, `.relayer-state.solana-${scfg.net.cluster}.${scfg.deployment.game}.json`));
sequencer = new SolanaSequencer(scfg, engine, pricer, chain, settler, server.notify, log, domain);
const setTerms = (g: typeof game, d: number) => {
  sequencer.difficulty = d;
  sequencer.terms = { minPerDot: g.config.minPerDot, maxPerDot: g.config.maxPerDot, maxPieceStake: g.config.maxPieceStake, maxPriceAgeMs: g.config.maxPriceAgeMs, feeBps: g.config.feeBps, profitFeeBps: g.config.profitFeeBps };
  scfg.lateMs = g.config.lateMs;
  settler.placeGraceMs = g.config.placeGraceMs;
};
setTerms(game, difficulty);
server.sequencer = sequencer;
server.settler = settler;

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
// The difficulty and the terms live on chain: follow them, and tell every app when they change.
setInterval(() => {
  void chain.terms().then(([g, d]) => {
    const changed = d !== sequencer.difficulty || json(g.config) !== json(game.config);
    if (d !== sequencer.difficulty) log(`difficulty is now ${d}`);
    setTerms(g, d);
    Object.assign(game, g);
    if (changed) server.announce();
  }, (e) => log(`reading the chain: ${String((e as Error).message ?? e).split("\n")[0]}`));
}, 10_000);
// Every fee and rent comes out of the relayer's SOL.
setInterval(() => {
  void chain.lamports().then((l) => {
    if (l < 500_000_000n) {
      log(`WARNING: relayer holds ${Number(l) / 1e9} SOL; top it up`);
      report("low-sol", `Solana relayer holds ${Number(l) / 1e9} SOL; top it up`, "warning");
    }
  }, (e) => log(`reading the relayer's SOL: ${String((e as Error).message ?? e).split("\n")[0]}`));
}, 60_000);

// An app that connected before the engine had prices was told no grid: tell it again once there is one.
let hadUnits = false;
setInterval(() => {
  const has = sequencer.units() !== null;
  if (has && !hadUnits) server.announce();
  hadUnits = has;
}, 1_000);

// A restart (systemd stops with SIGTERM) keeps what is still to settle and who is owed: saved on the way out.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log(`${signal}: saving the state and stopping`);
    settler.save();
    process.exit(0);
  });
}

await settler.start();
server.start();
