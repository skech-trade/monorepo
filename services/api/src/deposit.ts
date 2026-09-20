/**
 * Getting money onto Lighter, from any chain and any token.
 *
 * Two public services, no key between them:
 *
 *   Lighter hands out a CCTP **intent address** for a wallet. Anything USDC
 *   that lands on it is credited to that wallet's perp account, and the
 *   account is made if there is not one yet. That last part is what makes
 *   this the route for a first deposit.
 *
 *   Relay turns whatever someone is holding into USDC on a chain Lighter
 *   watches, and sends it to an address. An ordinary address, which the
 *   intent address is.
 *
 * Together: hold anything anywhere, end up with collateral on Lighter, in one
 * transaction. Relay's own Lighter route was the alternative and it is worse
 * for exactly the people this is for: its recipient is an account index, so a
 * wallet with no account has nothing to put there, and quoting one anyway
 * costs $3.62 of relayer gas against $0.02 for an account that exists.
 */

const RELAY = process.env.RELAY_URL ?? "https://api.relay.link";

/**
 * Where money can come from.
 *
 * Every chain a Coinbase embedded wallet can sign on, which is the real
 * limit: Relay bridges from almost anywhere, but the wallet has to be able to
 * send the transaction. `network` is CDP's own name for it, so a chain listed
 * here is a chain the wallet can sign on by construction.
 */
/*
  Every chain the wallet can sign on, which is the whole list and not a
  selection. Relay bridges from sixty, so it was never the limit: a Coinbase
  embedded wallet signs on base, ethereum, avalanche, polygon, optimism,
  arbitrum and world, and that is the ceiling. Each USDC address below was
  read off its own chain with a `symbol()` call rather than copied.
*/
export const CHAINS = [
  { id: 8453, name: "Base", network: "base", nativeSymbol: "ETH", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  { id: 42161, name: "Arbitrum", network: "arbitrum", nativeSymbol: "ETH", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  { id: 10, name: "Optimism", network: "optimism", nativeSymbol: "ETH", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  { id: 137, name: "Polygon", network: "polygon", nativeSymbol: "POL", usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
  { id: 43114, name: "Avalanche", network: "avalanche", nativeSymbol: "AVAX", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" },
  { id: 1, name: "Ethereum", network: "ethereum", nativeSymbol: "ETH", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { id: 480, name: "World", network: "world", nativeSymbol: "ETH", usdc: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1" },
] as const;

/**
 * Where it lands. Lighter watches a handful of chains for intent deposits and
 * Base is the cheapest of them, so everything is routed there whatever it
 * started as.
 */
export const LANDS_ON = CHAINS[0];

/**
 * Where a plain USDC transfer to the deposit address is watched for. Lighter's
 * CCTP list, not ours, and narrower than the chains Relay can bridge from.
 */
export const SEND_TO = [
  { id: 8453, name: "Base" },
  { id: 42161, name: "Arbitrum" },
  { id: 43114, name: "Avalanche" },
] as const;

/** The native coin of a chain, as Relay spells it. */
export const NATIVE = "0x0000000000000000000000000000000000000000";

export type Quote = {
  /** What they put in, and what lands on Lighter. */
  inAmount: string;
  inSymbol: string;
  outAmount: string;
  outSymbol: string;
  /** What the whole thing costs, in dollars. Negative is a cost. */
  impactUsd: number;
  seconds: number;
  /** Where the money is going, so the app can show it. */
  intentAddress: string;
  /** What the wallet has to sign, in order. Flattened out of Relay's steps. */
  transactions: { to: string; data: string; value: string; chainId: number }[];
};

export class Deposits {
  constructor(private readonly lighter: string) {}

  /** One address per wallet per chain, so asking twice is wasted. */
  private readonly known = new Map<string, string>();

  /**
   * The address that credits this wallet's perp account.
   *
   * One per person, and that is the whole point: it is the same address on
   * Base, Arbitrum, Avalanche and Arc, it does not change with the amount,
   * and `is_external_deposit` means anyone may send to it. So a reader can
   * send USDC straight from Coinbase, an exchange, another wallet or a
   * friend, and it lands on their Lighter account, making the account if they
   * have none.
   *
   * That removes a whole hop. Everything else asks someone to fund a new
   * wallet first and bridge from it, which is two moves and a balance sitting
   * somewhere that feels like neither their money nor their position.
   *
   * Without `is_external_deposit` the call refuses an amount of zero, with
   * "amount should be greater than 0 for user wallet deposit". With it, zero
   * is right, because the amount is whatever turns up.
   */
  async intentAddress(address: string, chainId: number = LANDS_ON.id): Promise<string | null> {
    const key = address.toLowerCase();
    const had = this.known.get(key);
    if (had) return had;
    const res = await fetch(`${this.lighter}/api/v1/createIntentAddress`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ chain_id: String(chainId), from_addr: address, amount: "0", is_external_deposit: "true" }),
    }).catch(() => null);
    if (!res?.ok) return null;
    const out = (await res.json()) as { intent_address?: string };
    if (!out.intent_address) return null;
    this.known.set(key, out.intent_address);
    return out.intent_address;
  }

  /**
   * What it costs to turn `amount` of `token` on `fromChain` into collateral.
   *
   * `amount` is in the token's own smallest unit, because that is what a
   * wallet signs and rounding it here would be rounding somebody's money.
   */
  async quote(opts: { address: string; fromChain: number; token: string; amount: string; toChain?: number; usdc?: string }): Promise<Quote | null> {
    const to = CHAINS.find((c) => c.id === (opts.toChain ?? LANDS_ON.id)) ?? LANDS_ON;
    const intent = await this.intentAddress(opts.address, to.id);
    if (!intent) return null;

    const res = await fetch(`${RELAY}/quote/v2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user: opts.address,
        originChainId: opts.fromChain,
        originCurrency: opts.token,
        destinationChainId: to.id,
        destinationCurrency: opts.usdc ?? to.usdc,
        recipient: intent,
        amount: opts.amount,
        tradeType: "EXACT_INPUT",
      }),
    }).catch(() => null);
    if (!res?.ok) return null;

    const d = (await res.json()) as {
      details?: {
        currencyIn?: { amountFormatted?: string; currency?: { symbol?: string } };
        currencyOut?: { amountFormatted?: string; currency?: { symbol?: string } };
        totalImpact?: { usd?: string };
        timeEstimate?: number;
      };
      steps?: unknown[];
    };
    if (!d.details) return null;
    /*
      Relay describes the work as steps, each holding items, each holding one
      transaction. The app only ever signs transactions in order, so they are
      flattened here rather than teaching the browser Relay's shape.
    */
    const transactions = (d.steps ?? []).flatMap((step) =>
      ((step as { items?: { data?: Record<string, unknown> }[] }).items ?? [])
        .map((item) => item.data)
        .filter((tx): tx is Record<string, unknown> => Boolean(tx?.to))
        .map((tx) => ({ to: String(tx.to), data: String(tx.data ?? "0x"), value: String(tx.value ?? "0"), chainId: Number(tx.chainId) })),
    );
    return {
      inAmount: d.details.currencyIn?.amountFormatted ?? "0",
      inSymbol: d.details.currencyIn?.currency?.symbol ?? "",
      outAmount: d.details.currencyOut?.amountFormatted ?? "0",
      outSymbol: d.details.currencyOut?.currency?.symbol ?? "USDC",
      impactUsd: Number(d.details.totalImpact?.usd ?? 0),
      seconds: d.details.timeEstimate ?? 0,
      intentAddress: intent,
      transactions,
    };
  }
}
