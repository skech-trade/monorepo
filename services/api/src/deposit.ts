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

/** The chains Lighter watches for intent deposits, and their USDC. */
export const CHAINS = [
  { id: 8453, name: "Base", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  { id: 42161, name: "Arbitrum", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  { id: 43114, name: "Avalanche", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" },
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
  /** What the wallet has to sign, in order. */
  steps: unknown[];
};

export class Deposits {
  constructor(private readonly lighter: string) {}

  /** One address per wallet per chain, so asking twice is wasted. */
  private readonly known = new Map<string, string>();

  /**
   * An address that credits this wallet's perp account. Public, no key, and
   * it works for a wallet that has never touched Lighter, which is the whole
   * reason this route exists.
   *
   * The amount has to be positive or the call is refused, but the address
   * that comes back does not depend on it: the same wallet and chain give the
   * same address for $10, $25 or $100. So one is sent to satisfy the check
   * and the real figure is whatever actually arrives.
   */
  async intentAddress(address: string, chainId: number): Promise<string | null> {
    const key = `${chainId}:${address.toLowerCase()}`;
    const had = this.known.get(key);
    if (had) return had;
    const res = await fetch(`${this.lighter}/api/v1/createIntentAddress`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ chain_id: String(chainId), from_addr: address, amount: "5" }),
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
    const to = CHAINS.find((c) => c.id === (opts.toChain ?? 8453)) ?? CHAINS[0];
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
    return {
      inAmount: d.details.currencyIn?.amountFormatted ?? "0",
      inSymbol: d.details.currencyIn?.currency?.symbol ?? "",
      outAmount: d.details.currencyOut?.amountFormatted ?? "0",
      outSymbol: d.details.currencyOut?.currency?.symbol ?? "USDC",
      impactUsd: Number(d.details.totalImpact?.usd ?? 0),
      seconds: d.details.timeEstimate ?? 0,
      intentAddress: intent,
      steps: d.steps ?? [],
    };
  }
}
