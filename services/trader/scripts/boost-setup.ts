/**
 * Set up Boost's treasury: one wallet, its Lighter master account, and the
 * lanes boosted rounds run in.
 *
 *   bun run --filter @skech/trader boost:setup
 *
 * Idempotent: it reuses whatever the environment already names and does only
 * what is missing. On testnet it funds a new wallet from the faucet; on
 * mainnet it stops and asks for a deposit instead. It writes the result to
 * the repo-root `.env.local` as BOOST_* lines, which is where every service
 * reads its secrets from. The wallet key it writes there controls the
 * treasury: keep it out of anything shared.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { addressOfKey, signL1, withL1Sig } from "../src/l1";
import { Lighter, TX } from "../src/lighter";
import { BASE, CHAIN_ID, NETWORK } from "../src/network";
import { generateApiKey, Signer } from "../src/signer";

const ENV_FILE = join(import.meta.dir, "..", "..", "..", ".env.local");
const LANES = Number(process.env.BOOST_LANE_COUNT ?? 4);
const KEY_INDEX = Number(process.env.BOOST_TREASURY_API_KEY_INDEX || 4);
const venue = new Lighter(BASE);
const say = (s: string) => console.log(`boost-setup: ${s}`);
const until = async <T>(what: string, fn: () => Promise<T | null | false>, ms = 60_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await Bun.sleep(1500);
  }
  throw Error(`timed out waiting for ${what}`);
};

/** Register `publicKey` at KEY_INDEX on `account`: signed by the new key itself and by the treasury wallet. */
async function register(walletKey: string, account: number, key: { privateKey: string; publicKey: string }) {
  if (await venue.hasKey(account, KEY_INDEX, key.publicKey)) return say(`key already registered on ${account}`);
  const signer = Signer.open({ url: BASE, privateKey: key.privateKey, chainId: CHAIN_ID, accountIndex: account, apiKeyIndex: KEY_INDEX, check: false });
  const tx = signer.changePubKey(key.publicKey);
  const signature = await signL1(walletKey, tx.messageToSign);
  await venue.send(TX.changePubKey, withL1Sig(tx.txInfo, signature));
  await until(`the key on ${account}`, () => venue.hasKey(account, KEY_INDEX, key.publicKey), 45_000);
  say(`key registered on ${account}`);
}

function writeEnv(values: Record<string, string>) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
  const kept = lines.filter((l) => !/^\s*BOOST_(TREASURY_[A-Z_]+|LANES)\s*=/.test(l) && !l.startsWith("# ---- Boost treasury (written by boost-setup"));
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  kept.push("", `# ---- Boost treasury (written by boost-setup, ${NETWORK}) ----`);
  for (const [k, v] of Object.entries(values)) kept.push(`${k}=${v}`);
  writeFileSync(ENV_FILE, `${kept.join("\n")}\n`);
}

async function main() {
  say(`${NETWORK}, ${BASE}`);
  const walletKey = process.env.BOOST_TREASURY_WALLET_KEY || generatePrivateKey();
  const address = addressOfKey(walletKey);
  say(`treasury wallet ${address}${process.env.BOOST_TREASURY_WALLET_KEY ? "" : " (new)"}`);

  let accounts = await venue.accountsFor(address);
  if (!accounts.length) {
    if (NETWORK !== "testnet") throw Error(`No Lighter account for ${address}. Deposit USDC to it on Lighter, then run this again.`);
    say("no Lighter account yet: asking the testnet faucet");
    const res = await fetch(`${BASE}/api/v1/faucet?l1_address=${address}`, { signal: AbortSignal.timeout(30_000) });
    const body = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
    if (body.code !== 200) throw Error(`faucet: ${body.message ?? res.status}`);
    accounts = await until("the faucet's account", async () => {
      const a = await venue.accountsFor(address);
      return a.length ? a : null;
    }, 90_000);
  }
  const master = accounts[0];
  say(`master account ${master}`);

  const key = process.env.BOOST_TREASURY_API_PRIVATE_KEY && process.env.BOOST_TREASURY_API_PUBLIC_KEY
    ? { privateKey: process.env.BOOST_TREASURY_API_PRIVATE_KEY, publicKey: process.env.BOOST_TREASURY_API_PUBLIC_KEY }
    : generateApiKey();
  // Written before anything else can fail, so a second run reuses the wallet and the key rather than orphaning them.
  writeEnv({ BOOST_TREASURY_WALLET_KEY: walletKey, BOOST_TREASURY_ACCOUNT_INDEX: String(master), BOOST_TREASURY_API_KEY_INDEX: String(KEY_INDEX), BOOST_TREASURY_API_PRIVATE_KEY: key.privateKey, BOOST_TREASURY_API_PUBLIC_KEY: key.publicKey, BOOST_LANES: accounts.slice(1).join(",") });
  await register(walletKey, master, key);

  const masterSigner = Signer.open({ url: BASE, privateKey: key.privateKey, chainId: CHAIN_ID, accountIndex: master, apiKeyIndex: KEY_INDEX });
  let lanes = accounts.slice(1);
  while (lanes.length < LANES) {
    if (lanes.length) await Bun.sleep(31_000); // Lighter allows two new sub-accounts a minute
    const nonce = await venue.nextNonce(master, KEY_INDEX);
    const tx = masterSigner.createSubAccount(nonce);
    await venue.send(tx.txType || TX.createSubAccount, tx.txInfo);
    const had = lanes.length;
    lanes = await until("the new lane", async () => {
      const all = (await venue.accountsFor(address)).slice(1);
      return all.length > had ? all : null;
    });
    say(`lane created: ${lanes.filter((l) => !accounts.includes(l)).join(", ")}`);
    accounts = [master, ...lanes];
    writeEnv({ BOOST_TREASURY_WALLET_KEY: walletKey, BOOST_TREASURY_ACCOUNT_INDEX: String(master), BOOST_TREASURY_API_KEY_INDEX: String(KEY_INDEX), BOOST_TREASURY_API_PRIVATE_KEY: key.privateKey, BOOST_TREASURY_API_PUBLIC_KEY: key.publicKey, BOOST_LANES: lanes.join(",") });
  }
  for (const lane of lanes.slice(0, LANES)) await register(walletKey, lane, key);

  const balance = await venue.balance(master);
  say(`done. master ${master} holds ${balance.collateral.toFixed(2)} USDC; lanes ${lanes.slice(0, LANES).join(", ")}`);
  say(`written to ${ENV_FILE}. Restart the trader to pick it up.`);
}

main().catch((e) => {
  console.error(`boost-setup failed: ${(e as Error).message}`);
  process.exit(1);
});
