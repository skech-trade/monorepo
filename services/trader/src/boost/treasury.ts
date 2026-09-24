import { signL1, withL1Sig } from "../l1";
import { type Lighter, TX } from "../lighter";
import { memoOf, Signer } from "../signer";
import type { BoostConfig } from "./config";
import { micro } from "./money";

/**
 * The treasury on the venue: moving USDC between its accounts and out to
 * users, and taking it in from them.
 *
 * Three kinds of transfer, and who signs each:
 *
 *   master → lane, lane → master   the treasury's trading key alone: they are
 *                                  sub-accounts of one master, and free
 *   master → a user's account      the trading key and the treasury wallet,
 *                                  because the money leaves skech's accounts
 *   a user's account → master      the user's trading key and the user's own
 *                                  wallet signature, from their browser
 *
 * Nonces are read from the venue for every transfer, never counted here: the
 * lanes' keys also sign orders through an executor with its own count, and a
 * transfer is rare enough that one extra read costs nothing.
 *
 * Every transfer goes through one queue and is not done until the venue shows
 * the money moved. Slower than it could be, and on purpose: a deposit is
 * confirmed by the master's balance rising by its amount, which only means
 * something if nothing else can be moving the master's balance at the time.
 */

type Pending = { address: string; amount: bigint; fee: bigint; txInfo: string; expires: number };

export class Treasury {
  private readonly signers = new Map<number, Signer>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly deposits = new Map<string, Pending>();

  constructor(
    private readonly config: BoostConfig,
    private readonly venue: Lighter,
    private readonly url: string,
    private readonly chainId: number,
  ) {}

  /** The treasury's trading key, on the master or on a lane. */
  signer(account: number): Signer {
    let s = this.signers.get(account);
    if (!s) {
      s = Signer.open({ url: this.url, privateKey: this.config.apiPrivateKey, chainId: this.chainId, accountIndex: account, apiKeyIndex: this.config.apiKeyIndex });
      this.signers.set(account, s);
    }
    return s;
  }

  isLane(account: number) {
    return this.config.lanes.includes(account);
  }

  /** One transfer at a time, across the whole treasury. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** What an account holds, in micro-USDC, flat or not. */
  async held(account: number) {
    const b = await this.venue.balance(account);
    return { collateral: micro(b.collateral), equity: micro(b.equity), positions: b.positions };
  }

  /** Lighter's charge for a transfer between two accounts that do not share a master. $1 on mainnet, $3 on testnet. */
  async transferFee(from: number, to: number, signer: Signer): Promise<bigint> {
    try {
      const token = signer.authToken(BigInt(Math.floor(Date.now() / 1000) + 600));
      const res = await fetch(`${this.url}/api/v1/transferFeeInfo?account_index=${from}&to_account_index=${to}`, { headers: { Authorization: token }, signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { transfer_fee_usdc?: number };
      if (typeof body.transfer_fee_usdc === "number") return BigInt(body.transfer_fee_usdc);
    } catch {
      /* fall through */
    }
    throw Error("Could not read Lighter's transfer fee. Try again in a moment.");
  }

  /** Between the master and a lane, either way. Free, and signed with the trading key alone. Done once the sender's balance shows it. */
  moveWithin(from: number, to: number, amount: bigint, memo: string): Promise<string> {
    return this.serial(async () => {
      if (amount <= 0n) return "";
      const before = (await this.held(from)).collateral;
      const nonce = await this.venue.nextNonce(from, this.config.apiKeyIndex);
      const tx = this.signer(from).transfer({ to, amount, fee: 0n, memo: memoOf(memo), nonce });
      const { hash } = await this.venue.send(tx.txType || TX.transfer, tx.txInfo);
      await this.until(from, (now) => now <= before - amount + 1n);
      return hash;
    });
  }

  /** Out of the master to somebody else's account: the wallet co-signs. `fee` is Lighter's, taken on top. */
  payOut(to: number, amount: bigint, fee: bigint, memo: string): Promise<string> {
    const from = this.config.master;
    return this.serial(async () => {
      const before = (await this.held(from)).collateral;
      const nonce = await this.venue.nextNonce(from, this.config.apiKeyIndex);
      const tx = this.signer(from).transfer({ to, amount, fee, memo: memoOf(memo), nonce });
      const signature = await signL1(this.config.walletKey, tx.messageToSign);
      const { hash } = await this.venue.send(tx.txType || TX.transfer, withL1Sig(tx.txInfo, signature));
      await this.until(from, (now) => now <= before - amount + 1n);
      return hash;
    });
  }

  /**
   * Everything a lane holds, back to the master. What is left once a round is
   * flat, and what a failed round has to give back. Nothing held, nothing sent.
   */
  async sweep(lane: number, memo: string): Promise<bigint> {
    const { collateral, positions } = await this.held(lane);
    if (positions > 0) throw Error(`Lane ${lane} still holds a position; not sweeping it.`);
    if (collateral <= 0n) return 0n;
    await this.moveWithin(lane, this.config.master, collateral, memo);
    return collateral;
  }

  /** Wait for an account's balance to satisfy `ok`, reading it every 400ms. */
  async until(account: number, ok: (collateral: bigint) => boolean, ms = 20_000): Promise<bigint> {
    const end = Date.now() + ms;
    let last = 0n;
    while (Date.now() < end) {
      last = (await this.held(account).catch(() => null))?.collateral ?? last;
      if (ok(last)) return last;
      await Bun.sleep(400);
    }
    throw Error("Lighter has not shown the transfer yet.");
  }

  // --- money in from a user --------------------------------------------------

  /**
   * Step one of adding money: a transfer from the user's own Lighter account to
   * the treasury, signed with their trading key and waiting for their wallet.
   * The page shows the fee and has them sign `messageToSign`.
   */
  async prepareDeposit(o: { address: string; account: number; apiKeyIndex: number; privateKey: string; amount: bigint }) {
    const user = Signer.open({ url: this.url, privateKey: o.privateKey, chainId: this.chainId, accountIndex: o.account, apiKeyIndex: o.apiKeyIndex });
    const fee = await this.transferFee(o.account, this.config.master, user);
    const available = micro((await this.venue.balance(o.account)).collateral);
    if (available < o.amount + fee) throw Error(`Your Lighter balance is ${(Number(available) / 1e6).toFixed(2)} USDC; adding ${(Number(o.amount) / 1e6).toFixed(2)} needs ${(Number(fee) / 1e6).toFixed(2)} more for Lighter's transfer fee.`);
    const id = crypto.randomUUID();
    const nonce = await this.venue.nextNonce(o.account, o.apiKeyIndex);
    const tx = user.transfer({ to: this.config.master, amount: o.amount, fee, memo: memoOf(`dep:${id.slice(0, 26)}`), nonce });
    this.deposits.set(id, { address: o.address.toLowerCase(), amount: o.amount, fee, txInfo: tx.txInfo, expires: Date.now() + 5 * 60_000 });
    return { id, fee, messageToSign: tx.messageToSign };
  }

  /**
   * Step two: the user signed. Send it, and answer once the master's balance
   * shows it arrived, so the Boost balance is only ever credited with money
   * the treasury can see. One deposit at a time, so the rise is this one's.
   */
  confirmDeposit(id: string, address: string, signature: string): Promise<{ amount: bigint; hash: string }> {
    const pending = this.deposits.get(id);
    if (!pending || pending.address !== address.toLowerCase()) return Promise.reject(Error("That deposit has expired. Start again."));
    if (pending.expires < Date.now()) {
      this.deposits.delete(id);
      return Promise.reject(Error("That deposit has expired. Start again."));
    }
    this.deposits.delete(id);
    return this.serial(async () => {
      const before = (await this.held(this.config.master)).collateral;
      const { hash } = await this.venue.send(TX.transfer, withL1Sig(pending.txInfo, signature));
      await this.until(this.config.master, (now) => now >= before + pending.amount - 1n, 30_000);
      return { amount: pending.amount, hash };
    });
  }
}
