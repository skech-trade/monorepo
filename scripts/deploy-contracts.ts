/**
 * `bun run deploy:contracts`: the game on Monad, wired up from .env.local.
 *
 *   bun run deploy:contracts             deploy to SKECH_NETWORK (testnet when unset)
 *   bun run deploy:contracts --dry-run   simulate: gas and addresses, nothing sent, nothing written
 *   bun run deploy:contracts --mainnet   required as well when SKECH_NETWORK=mainnet: it spends real MON
 *
 * The deployer is DEPLOYER_PRIVATE_KEY, or ENGINE_PRIVATE_KEY when that is unset: on testnet one key
 * is the admin, the oracle and the relayer. The oracle is ORACLE_ADDRESS, or the engine wallet.
 * USDC, DIFFICULTY and IOU_RATE pass through to script/Deploy.s.sol:Deploy. Afterwards the addresses
 * are in packages/evm-contracts/deployments/<chainId>.json. The engine, the relayer and the app all find the
 * game there from SKECH_NETWORK, so nothing is written to .env.local and switching networks is one line.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chainIdFor, network, networkOf, rpcFor } from "../packages/core/src/network";

const root = join(import.meta.dir, "..");
const contracts = join(root, "packages/evm-contracts");
const dryRun = process.argv.includes("--dry-run");

const FAUCET = "https://faucet.monad.xyz";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const trimmed = (name: string) => process.env[name]?.trim() || undefined;

let net: ReturnType<typeof network>;
let chainNumber: number;
try {
  net = network(process.env.SKECH_NETWORK);
  chainNumber = chainIdFor(process.env);
} catch (e) {
  fail((e as Error).message);
}
if (!networkOf(chainNumber!)) fail(`chain ${chainNumber!} is not testnet or mainnet: for anvil use bun packages/relayer/scripts/e2e.ts`);
const chainId = String(chainNumber!);
const rpc = rpcFor(process.env, chainNumber!);
if (net!.name === "mainnet" && !dryRun && !process.argv.includes("--mainnet")) {
  fail("SKECH_NETWORK is mainnet: this deploy spends real MON and the game takes real USDC. Run it again with --mainnet to go ahead, or --dry-run to simulate.");
}
const engineKey = trimmed("ENGINE_PRIVATE_KEY");
const deployer = trimmed("DEPLOYER_PRIVATE_KEY") ?? engineKey ?? fail("ENGINE_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) must be set in .env.local: it deploys and becomes the admin");

const cast = (...args: string[]) => {
  const run = spawnSync("cast", args, { cwd: contracts, encoding: "utf8" });
  if (run.error) fail(`cast is not installed: curl -L https://foundry.paradigm.xyz | bash && foundryup`);
  if (run.status !== 0) fail(`cast ${args[0]} failed: ${run.stderr.trim()}`);
  return run.stdout.trim();
};
const oracle =
  trimmed("ORACLE_ADDRESS") ??
  (engineKey
    ? cast("wallet", "address", "--private-key", engineKey)
    : fail("ORACLE_ADDRESS must be set when ENGINE_PRIVATE_KEY is blank: the engine would sign with a throwaway wallet and nothing it signs would verify"));
const deployerAddress = cast("wallet", "address", "--private-key", deployer);

const balance = Number(cast("balance", deployerAddress, "--rpc-url", rpc, "--ether"));
if (!dryRun && balance < 14) {
  fail(
    `${deployerAddress} holds ${balance} MON on chain ${chainId}. The deploy needs about 4 MON above the 10 MON Monad keeps in reserve.` +
      (chainId === "10143" ? ` Faucet: ${FAUCET}` : ""),
  );
}

// The network's own USDC unless one is named: the Solidity default is testnet's, which would be wrong on mainnet.
process.env.USDC = trimmed("USDC") ?? net!.usdc;
const extras = ["USDC", "DIFFICULTY", "IOU_RATE"].filter((name) => trimmed(name)).map((name) => `${name}=${trimmed(name)}`);
console.log(
  `${dryRun ? "simulating" : "deploying"} on ${net!.label} (chain ${chainId}) as ${deployerAddress} (${balance} MON), oracle ${oracle}${extras.length ? `, ${extras.join(", ")}` : ""}`,
);
// The deployment file's time before, so a redeploy that broadcast nothing is not mistaken for one that did.
const file = join(contracts, "deployments", `${chainId}.json`);
const before = existsSync(file) ? statSync(file).mtimeMs : 0;
const forge = spawnSync(
  "forge",
  ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", rpc, "--private-key", deployer, ...(dryRun ? [] : ["--broadcast"])],
  { cwd: contracts, stdio: "inherit", env: { ...process.env, ORACLE_ADDRESS: oracle } },
);
if (forge.error) fail("forge is not installed: curl -L https://foundry.paradigm.xyz | bash && foundryup");
if (forge.status !== 0) fail("forge script failed, see above");
if (dryRun) process.exit(0);

if (!existsSync(file) || statSync(file).mtimeMs === before) fail(`${file} was not written, so nothing was broadcast`);
const deployed = JSON.parse(readFileSync(file, "utf8")) as { game: string; iou: string; revenue: string; usdc: string; block?: number };
// The block it went out in, from forge's own receipts: where the relayer starts counting each player's transactions.
const broadcast = join(contracts, "broadcast", "Deploy.s.sol", chainId, "run-latest.json");
if (existsSync(broadcast)) {
  const receipts = (JSON.parse(readFileSync(broadcast, "utf8")) as { receipts?: { blockNumber: string }[] }).receipts ?? [];
  if (receipts.length) {
    deployed.block = Math.min(...receipts.map((r) => Number(BigInt(r.blockNumber))));
    writeFileSync(file, `${JSON.stringify(deployed, null, 2)}\n`);
  }
}

console.log(`
game     ${deployed.game}
iou      ${deployed.iou}
revenue  ${deployed.revenue}
usdc     ${deployed.usdc}

Restart bun run dev: the engine, the relayer and the app find this game in ${file.replace(`${root}/`, "")} while SKECH_NETWORK is ${net!.name}.`);
