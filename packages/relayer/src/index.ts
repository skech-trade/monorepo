/**
 * skech relayer: prices what players draw, signs it, and puts it on chain for
 * them; posts the price every second and settles on it; pays off IOUs and
 * moves the fees out. The one process that holds the oracle's key besides the
 * engine.
 *
 *   bun run dev:relayer      (from the repo root; reads .env.local there)
 *
 *   ws://localhost:3103/ws   apps connect here (NEXT_PUBLIC_RELAYER_URL)
 *   GET /health, GET /status
 */
import { report, survive, trail } from "./sentry";
import { formatEther } from "viem";
import { join } from "node:path";
import { Activity } from "./activity";
import { ChainClient } from "./chain";
import { cfg } from "./config";
import { Engine } from "./engine";
import { Pricer } from "./pricer";
import { Sequencer } from "./sequencer";
import { Server } from "./server";
import { Settler } from "./settler";
import { redact } from "./rpc";

const log = (s: string) => {
  console.error(`${new Date().toISOString().slice(11, 23)} ${s}`);
  trail(s);
};
survive(log);

const started = Date.now();
const libBytes = await Bun.file(cfg.libPath).arrayBuffer();
const pricer = new Pricer(libBytes, log);
log(`paths: ${await pricer.ready} from ${cfg.libPath}`);

const chain = new ChainClient(cfg, log);
const chainId = await chain.pub.getChainId();
if (chainId !== cfg.chainId) throw new Error(`the RPC at ${redact(cfg.rpcUrl)} is chain ${chainId}, not ${cfg.chainId} (ENGINE_CHAIN_ID)`);
await chain.start();
const [oracle, gameConfig, difficulty, mon] = await Promise.all([chain.oracle(), chain.gameConfig(), chain.difficultyOf(cfg.market), chain.pub.getBalance({ address: chain.account.address })]);
log(`chain ${chainId} via ${redact(cfg.rpcUrl)}: game ${cfg.game}, oracle ${oracle}, difficulty ${difficulty}, relayer ${chain.account.address} holds ${formatEther(mon)} MON`);
if (oracle.toLowerCase() !== chain.account.address.toLowerCase()) {
  log(`WARNING: this relayer's key is not the game's oracle; its quotes and bars will be refused`);
  report("not-oracle", `relayer ${chain.account.address} is not the game's oracle ${oracle}`);
}
if (mon < 12n * 10n ** 18n) log(`WARNING: Monad keeps 10 MON of an account in reserve; with ${formatEther(mon)} MON this relayer may not be able to send`);
cfg.lateMs = gameConfig.lateMs;

const engine = new Engine(cfg.engineUrl, log);
engine.start();

let sequencer: Sequencer;
let settler: Settler;
const server: Server = new Server({
  cfg,
  engine,
  chain,
  log,
  status: (): Record<string, unknown> => ({
    up: Math.round((Date.now() - started) / 1000),
    engine: { connected: engine.connected, ready: engine.ready(), bars: engine.book.bars.length, skew: Math.round(engine.skew), signer: engine.signer },
    chain: { id: chainId, game: cfg.game, relayer: chain.account.address, inflight: chain.busy, gas: chain.gasStats, pool: chain.ledger.pool?.toString() ?? null },
    difficulty: sequencer.difficulty,
    connections: server.connections,
    pieces: sequencer.stats,
    settling: { ...settler.stats, seconds: settler.watchers() },
  }),
});
// One state file per chain and game: what is owed on testnet means nothing to a local chain.
// Each player's transactions on chain, read from the game's logs. Without the deployment block, counted from now.
const from = cfg.deployBlock ?? (await chain.pub.getBlockNumber());
if (cfg.deployBlock === null) log(`activity: no deployment block known (deployments/${cfg.chainId}.json "block", or SKECH_DEPLOY_BLOCK); counting from block ${from}`);
const activity = new Activity(chain, from, join(import.meta.dir, "..", `.relayer-activity.${cfg.chainId}.${cfg.game.toLowerCase()}.json`), log);
settler = new Settler(cfg, engine, chain, server.notify, log, join(import.meta.dir, "..", `.relayer-state.${cfg.chainId}.${cfg.game.toLowerCase()}.json`));
sequencer = new Sequencer(cfg, engine, pricer, chain, settler, server.notify, log);
sequencer.difficulty = difficulty;
sequencer.gameConfig = gameConfig;
settler.profitFeeBps = BigInt(gameConfig.profitFeeBps);
server.sequencer = sequencer;
server.settler = settler;
server.activity = activity;

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
// The difficulty and the terms live on chain: follow them.
setInterval(() => {
  void Promise.all([chain.difficultyOf(cfg.market), chain.gameConfig()]).then(([d, gc]) => {
    const changed = d !== sequencer.difficulty || json(gc) !== json(sequencer.gameConfig);
    if (d !== sequencer.difficulty) log(`difficulty is now ${d}`);
    sequencer.difficulty = d;
    sequencer.gameConfig = gc;
    settler.profitFeeBps = BigInt(gc.profitFeeBps);
    cfg.lateMs = gc.lateMs;
    // An app still on the old terms would have every piece turned away until it reconnected.
    if (changed) server.announce();
  }, (e) => log(`reading the chain: ${String((e as Error).message ?? e).split("\n")[0]}`));
}, 10_000);
// Monad's reserve: the relayer must keep 10 MON plus what its transactions cost.
setInterval(() => {
  void chain.pub.getBalance({ address: chain.account.address }).then((b) => {
    if (b < 12n * 10n ** 18n) {
      log(`WARNING: relayer holds ${formatEther(b)} MON; top it up`);
      report("low-mon", `relayer holds ${formatEther(b)} MON; top it up`, "warning");
    }
  }, (e) => log(`reading the relayer's MON: ${String((e as Error).message ?? e).split("\n")[0]}`));
}, 60_000);

// The engine's signer must be the game's oracle, or nothing a player sees can be checked on chain.
setTimeout(() => {
  if (engine.signer && engine.signer.toLowerCase() !== oracle.toLowerCase()) {
    log(`WARNING: the engine signs as ${engine.signer} but the game's oracle is ${oracle}; prices seen will be refused`);
    report("engine-signer", `the engine signs as ${engine.signer} but the game's oracle is ${oracle}`);
  }
  if (engine.domain && engine.domain.verifyingContract.toLowerCase() !== cfg.game.toLowerCase()) log(`WARNING: the engine signs for ${engine.domain.verifyingContract}, not the game ${cfg.game}: set ENGINE_VERIFYING_CONTRACT`);
}, 3000);

settler.start();
activity.start();
server.start();
