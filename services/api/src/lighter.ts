/** What Lighter says an account is worth, for the balances the header shows. */

export type Balance = {
  /** The perp account's collateral, in USDC. What you can trade with. */
  collateral: number;
  available: number;
  /** Marked profit and loss on anything open. */
  unrealised: number;
  /** Collateral plus unrealised, which is what the account is actually worth. */
  equity: number;
  positions: number;
  /** Null when this wallet has no Lighter account yet. */
  accountIndex: number | null;
};

const asNum = (v: unknown, fallback = 0) => {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};

export class Lighter {
  constructor(private readonly base: string) {}

  private async get<T>(path: string): Promise<T | null> {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) throw Error("Venue account lookup failed");
    return (await res.json()) as T;
  }

  /**
   * The account index for a wallet, or null.
   *
   * Lighter keys an account to an Ethereum address and makes it on the first
   * deposit, so "no account" and "never deposited" are the same answer.
   */
  async accountIndexFor(address: string): Promise<number | null> {
    const d = await this.get<{ sub_accounts?: { index?: number }[]; accounts?: { account_index?: number }[] }>(
      `/api/v1/accountsByL1Address?l1_address=${address}`,
    );
    const index = d?.sub_accounts?.[0]?.index ?? d?.accounts?.[0]?.account_index;
    return typeof index === "number" ? index : null;
  }

  async balanceOf(index: number): Promise<Balance | null> {
    const d = await this.get<{ accounts: Record<string, unknown>[] }>(`/api/v1/account?by=index&value=${index}`);
    const a = d?.accounts?.[0];
    if (!a) return null;
    const positions = ((a.positions ?? []) as Record<string, unknown>[]).filter((p) => asNum(p.position) !== 0);
    const unrealised = positions.reduce((sum, p) => sum + asNum(p.unrealized_pnl), 0);
    const collateral = asNum(a.collateral);
    const equity = Number(a.total_asset_value);
    if (!Number.isFinite(equity)) throw Error("Venue equity unavailable");
    return { collateral, available: asNum(a.available_balance), unrealised, equity, positions: positions.length, accountIndex: index };
  }

  /** Straight from a wallet address, which is what the app has. */
  async balanceForAddress(address: string): Promise<Balance> {
    const index = await this.accountIndexFor(address);
    if (index === null) return { collateral: 0, available: 0, unrealised: 0, equity: 0, positions: 0, accountIndex: null };
    const balance=await this.balanceOf(index);
    if(!balance)throw Error("Venue balance unavailable");
    return balance;
  }
}
