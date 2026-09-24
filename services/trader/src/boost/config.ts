import { isSymbol, NETWORK, type Symbol } from "../network";

/**
 * Boost, as configured.
 *
 * skech's treasury is one wallet. Its Lighter master account holds everybody's
 * Boost balance and skech's own money, and its sub-accounts are the lanes each
 * boosted round runs in, one at a time. One trading key is registered at the
 * same index on the master and on every lane, and the wallet's own key signs
 * what only an owner can: registering that key, and sending money out to a
 * user's account. All of it lives in the environment, written there by
 * `scripts/boost-setup.ts`.
 */

const env = (name: string) => (process.env[name] ?? "").trim();
const num = (name: string, fallback: number) => {
  const n = Number(env(name));
  return env(name) !== "" && Number.isFinite(n) ? n : fallback;
};

export type BoostConfig = {
  /** The treasury wallet's private key. Signs key registrations and withdrawals, nothing else. */
  walletKey: string;
  /** The treasury's master account on Lighter: where Boost balances live between rounds. */
  master: number;
  /** One trading key, registered at this index on the master and every lane. */
  apiKeyIndex: number;
  apiPrivateKey: string;
  /** Sub-accounts of the master. Each runs one boosted round at a time. */
  lanes: number[];
  /** skech adds this many times the stake. */
  multiple: number;
  /** The round closes once this share of the stake is gone. */
  closeAt: number;
  /** skech's share of a winning round's profit. */
  cut: number;
  /** skech's fee on a losing round, as a share of the stake. */
  lossFee: number;
  /** Stakes allowed, in USDC. */
  stakeMin: number;
  stakeMax: number;
  /** The markets Boost runs on, at this leverage. */
  markets: Symbol[];
  leverage: number;
  /**
   * The most boost that may be out in open rounds at once, in USDC, before any
   * fees are earned. Every open round can at worst lose its boost, so this is
   * the most skech can lose at any moment. It grows only with fees booked.
   */
  reserveCap: number;
  /**
   * Margin left free out of stake plus boost, as a share of it. Zero by
   * default: the lane's float leaves the margin a round needs well covered.
   */
  headroom: number;
  /**
   * What each lane holds between rounds, in USDC: skech's money, of which a
   * round trades stake plus boost. Above the largest round with room to
   * spare, so an order can never be cancelled for margin, and no transfer
   * stands between pressing Trade and the order.
   */
  laneFloat: number;
  /**
   * Seconds a wallet's Wild money may sit on skech's side with no round
   * before it is sent back to its Lighter account by itself.
   */
  returnAfter: number;
  /** For the admin routes. Unset, they refuse everything. */
  adminToken: string;
};

/** The configuration, or why there is none. */
export function boostConfig(): { ok: true; config: BoostConfig } | { ok: false; missing: string[] } {
  const required = ["BOOST_TREASURY_WALLET_KEY", "BOOST_TREASURY_ACCOUNT_INDEX", "BOOST_TREASURY_API_KEY_INDEX", "BOOST_TREASURY_API_PRIVATE_KEY", "BOOST_LANES"];
  const missing = required.filter((name) => env(name) === "");
  if (missing.length) return { ok: false, missing };
  const lanes = env("BOOST_LANES").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (!lanes.length) return { ok: false, missing: ["BOOST_LANES"] };
  const markets = (env("BOOST_MARKETS") || "BTC").split(",").map((s) => s.trim().toUpperCase()).filter(isSymbol);
  return {
    ok: true,
    config: {
      walletKey: env("BOOST_TREASURY_WALLET_KEY"),
      master: Number(env("BOOST_TREASURY_ACCOUNT_INDEX")),
      apiKeyIndex: Number(env("BOOST_TREASURY_API_KEY_INDEX")),
      apiPrivateKey: env("BOOST_TREASURY_API_PRIVATE_KEY"),
      lanes,
      multiple: num("BOOST_MULTIPLE", 5),
      closeAt: num("BOOST_CLOSE_AT", 0.8),
      cut: num("BOOST_CUT", 0.3),
      lossFee: num("BOOST_LOSS_FEE", 0.01),
      stakeMin: num("BOOST_STAKE_MIN", 10),
      stakeMax: num("BOOST_STAKE_MAX", 25),
      markets: markets.length ? markets : ["BTC"],
      leverage: num("BOOST_LEVERAGE", 50),
      reserveCap: num("BOOST_RESERVE_CAP", 500),
      headroom: num("BOOST_HEADROOM", 0),
      /*
        On testnet the stop follows the chart, so nothing caps what testnet's
        own fills lose, and its $60 to $100 spread cost a $7,500 position about
        $9 a turn: a $200 lane was down to $145 after five turns, and Lighter
        refused the next open for margin. Three times the largest round there;
        on mainnet the stop caps the lane's loss at the user's stake.
      */
      laneFloat: num("BOOST_LANE_FLOAT", Math.ceil((num("BOOST_STAKE_MAX", 25) * (1 + num("BOOST_MULTIPLE", 5)) * (NETWORK === "testnet" ? 3 : 1.3)) / 10) * 10),
      returnAfter: num("BOOST_RETURN_AFTER_S", 600),
      adminToken: env("BOOST_ADMIN_TOKEN"),
    },
  };
}
