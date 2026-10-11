import { CLUSTER, NETWORK } from "./chain";

/**
 * Money in from somewhere else, through Relay (relay.link).
 *
 * A player signs in and gets an empty Solana wallet. Their money is on an exchange or an EVM chain, and today the
 * deposit sheet can only say "send USDC on Solana", which for most people is a dead end. Relay answers that: ask it
 * for a deposit address on the chain the money is already on, the player sends to it, and USDC arrives here. No
 * wallet to connect, no bridge to learn, about a second to fill.
 *
 * Switching networks is one setting and nothing here: `CLUSTER` decides, `NETWORK.usdc` is already the right mint
 * for whichever cluster that is, and `RELAY_ON` is false anywhere Relay cannot reach. Relay's testnet carries only
 * Base Sepolia and Sepolia, with no Solana at all, so on devnet the sheet keeps the address-and-faucet it has.
 */

/** Relay's own id for Solana. Not a Solana thing: it is how Relay names the chain in its API. */
export const RELAY_SOLANA_CHAIN = 792703809;

/**
 * Whether money can come in from another chain at all. False on devnet and localnet, where Relay has no Solana to
 * deliver to, and the sheet shows the faucet instead.
 */
export const RELAY_ON = CLUSTER === "mainnet-beta";

const API = "https://api.relay.link";

/** A chain money can arrive from, as Relay describes it. */
export type RelayChain = {
  id: number;
  name: string;
  /** "evm" for the 52 that share an address format, "svm" for Solana, and a few of their own. */
  vm: string;
  icon: string | null;
  /** What Relay will take from this chain, the native coin first. */
  currencies: RelayCurrency[];
};
export type RelayCurrency = { address: string; symbol: string; decimals: number };

/** An address to send to, and what sending to it is worth. */
export type RelayDeposit = {
  address: string;
  /** Relay's handle on this order, for looking its progress up later. */
  requestId: string;
  /** What arrives, after Relay's cut, in whole USDC. */
  arrives: number;
  /** What Relay takes, in whole USDC. Mostly fixed gas, so it bites hardest on small amounts. */
  cost: number;
  /** Relay's own estimate, in seconds. It has been quoting one. */
  seconds: number;
};

type ChainRow = {
  id: number;
  displayName?: string;
  name?: string;
  vmType?: string;
  iconUrl?: string;
  disabled?: boolean;
  depositAddressEnabled?: boolean;
  currency?: RelayCurrency & { supportsBridging?: boolean };
  solverCurrencies?: RelayCurrency[];
};

let chains: Promise<RelayChain[]> | null = null;

/**
 * Where money can come from, asked once and kept for the tab's life.
 *
 * Read rather than written down, so the list grows when Relay adds a chain and shrinks when one goes down, without
 * anything here changing. Only chains that can hand out a deposit address are offered: `depositEnabled` is a wider
 * flag and includes chains this flow cannot use.
 */
export function relayChains(): Promise<RelayChain[]> {
  if (!RELAY_ON) return Promise.resolve([]);
  chains ??= fetch(`${API}/chains`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Relay answered ${r.status}`))))
    .then((body: { chains?: ChainRow[] }) =>
      (body.chains ?? [])
        .filter((c) => c.depositAddressEnabled && !c.disabled)
        .map((c) => {
          const native = c.currency?.supportsBridging ? [c.currency] : [];
          // The native coin first: "I have ETH, not USDC" is the common case, and Relay swaps on the way through.
          const rest = (c.solverCurrencies ?? []).filter((k) => k.address !== c.currency?.address);
          return { id: c.id, name: c.displayName ?? c.name ?? String(c.id), vm: c.vmType ?? "evm", icon: c.iconUrl ?? null, currencies: [...native, ...rest] };
        })
        .filter((c) => c.currencies.length > 0),
    )
    .catch((e) => {
      // Asked again next time rather than remembering the failure.
      chains = null;
      throw e;
    });
  return chains;
}

/** The symbols worth offering first on a chain, in the order a player is likely to hold them. */
const FAVOURITES = ["USDC", "USDT", "ETH", "SOL", "BTC"];
export const sortCurrencies = (list: RelayCurrency[]) =>
  [...list].sort((a, b) => {
    const rank = (s: string) => (FAVOURITES.indexOf(s.toUpperCase()) + 1 || 99);
    return rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol);
  });

/**
 * An address on `chain` that turns into USDC here.
 *
 * `from` is the player's address on the chain the money is coming from, and Relay refuses a quote without one that
 * fits: a Solana address for an EVM origin is rejected outright. It is also where a fill that fails is sent back
 * to, which is why it has to be an address the player actually holds and not a stand-in.
 *
 * The address is tied to this route, so one per chain and token, not one per player.
 */
export async function relayDeposit(opts: { chain: number; currency: string; amount: number; decimals: number; from: string; to: string }): Promise<RelayDeposit> {
  if (!RELAY_ON) throw new Error("Money from other chains is off on this network");
  const body = {
    user: opts.from,
    refundTo: opts.from,
    originChainId: opts.chain,
    originCurrency: opts.currency,
    destinationChainId: RELAY_SOLANA_CHAIN,
    destinationCurrency: NETWORK.usdc,
    tradeType: "EXACT_INPUT",
    recipient: opts.to,
    amount: BigInt(Math.round(opts.amount * 10 ** opts.decimals)).toString(),
    useDepositAddress: true,
  };
  const response = await fetch(`${API}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const quote = (await response.json().catch(() => ({}))) as {
    message?: string;
    steps?: { depositAddress?: string; requestId?: string }[];
    details?: { currencyIn?: { amountFormatted?: string }; currencyOut?: { amountFormatted?: string }; timeEstimate?: number };
  };
  if (!response.ok) throw new Error(quote.message || "Relay could not quote that right now");
  const step = quote.steps?.[0];
  if (!step?.depositAddress || !step.requestId) throw new Error("Relay gave no address for that");
  const paid = Number(quote.details?.currencyIn?.amountFormatted ?? opts.amount);
  const arrives = Number(quote.details?.currencyOut?.amountFormatted ?? 0);
  return { address: step.depositAddress, requestId: step.requestId, arrives, cost: Math.max(0, paid - arrives), seconds: quote.details?.timeEstimate ?? 0 };
}

/**
 * What Relay takes is nearly all fixed gas, so it is a quarter of a percent on $100 and over four on $5. Under
 * this, the sheet says so rather than letting someone lose a twentieth of their money to find out.
 */
export const RELAY_WORTH_IT = 20;
