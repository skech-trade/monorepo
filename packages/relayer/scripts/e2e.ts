/**
 * The whole thing, locally: anvil, the contracts with a mock USDC, the engine
 * on live Coinbase, the relayer, and a scripted player. Needs the network,
 * cargo and foundry. Prints every service's log and exits 0 when the player
 * has placed, been settled and withdrawn.
 *
 *   bun packages/relayer/scripts/e2e.ts
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

const root = join(import.meta.dir, "..", "..", "..");
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil's first account: deployer, oracle, relayer
const PLAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil's second
const oracle = privateKeyToAccount(ANVIL_KEY).address;
const player = privateKeyToAccount(PLAYER_KEY).address;
const children: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.log(`${new Date().toISOString().slice(11, 23)} e2e ${s}`);

function run(name: string, cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const child = spawn(cmd[0], cmd.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  for (const stream of [child.stdout!, child.stderr!]) {
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) console.log(`${new Date().toISOString().slice(11, 23)} ${name.padEnd(7)} ${line}`);
    });
  }
  return child;
}
const stop = () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGINT");
};
process.on("SIGINT", () => (stop(), process.exit(1)));

const up = async (url: string, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
};

try {
  run("anvil", ["anvil", "--port", "8545", "--chain-id", "31337", "--disable-code-size-limit", "--silent"], root);
  await sleep(1500);
  say("deploying");
  const deploy = spawnSync(
    "forge",
    ["script", "script/DeployLocal.s.sol", "--rpc-url", "http://127.0.0.1:8545", "--broadcast", "--private-key", ANVIL_KEY],
    { cwd: join(root, "packages", "contracts", "evm"), env: { ...process.env, ORACLE_ADDRESS: oracle, PLAYER: player }, encoding: "utf8" },
  );
  if (deploy.status !== 0) throw new Error(`deploy failed:\n${deploy.stdout}\n${deploy.stderr}`);
  const deployment = JSON.parse(await Bun.file(join(root, "packages", "contracts", "deployments", "31337.json")).text()) as { game: string; usdc: string };
  say(`game ${deployment.game}, usdc ${deployment.usdc}`);
  const env = {
    ENGINE_PRIVATE_KEY: ANVIL_KEY,
    RELAYER_PRIVATE_KEY: ANVIL_KEY,
    ENGINE_CHAIN_ID: "31337",
    ENGINE_VERIFYING_CONTRACT: deployment.game,
    SKECH_GAME: deployment.game,
    MONAD_RPC_URL: "http://127.0.0.1:8545",
    ENGINE_PORT: "3112",
    RELAYER_PORT: "3113",
    NEXT_PUBLIC_ENGINE_URL: "ws://localhost:3112/ws",
    RELAYER_URL: "ws://localhost:3113/ws",
  };
  run("engine", ["cargo", "run", "--release", "--quiet"], join(root, "packages", "engine"), env);
  if (!(await up("http://localhost:3112/health", 600))) throw new Error("engine did not come up");
  run("relayer", ["bun", "src/index.ts"], join(root, "packages", "relayer"), env);
  if (!(await up("http://localhost:3113/health", 120))) throw new Error("relayer did not come up");
  // The relayer needs five minutes of bars to price; the engine backfills ten on connect. Give the relayer a moment to take them.
  await sleep(4000);
  const p = run("player", ["bun", "scripts/player.ts"], join(root, "packages", "relayer"), { ...env, PLAYER_KEY });
  const code = await new Promise<number>((r) => p.on("exit", (c) => r(c ?? 1)));
  say(code === 0 ? "passed" : `player exited ${code}`);
  stop();
  process.exit(code);
} catch (e) {
  say(String((e as Error).message ?? e));
  stop();
  process.exit(1);
}
