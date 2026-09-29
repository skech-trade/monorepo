/**
 * Nonces, kept here: asking the node before every transaction is a round
 * trip, and Monad's docs say not to. Lost on a nonce error and asked again.
 */
import type { PublicClient, Address } from "viem";

export class Nonces {
  private next: number | null = null;
  private syncing: Promise<number> | null = null;
  constructor(private readonly client: PublicClient, private readonly account: Address) {}

  async take(): Promise<number> {
    if (this.next === null) await this.sync();
    return this.next!++;
  }

  /** Forget what we think and ask the node: after a nonce error, or a transaction that never landed. */
  sync(): Promise<number> {
    this.syncing ??= this.client.getTransactionCount({ address: this.account, blockTag: "pending" }).then((n) => {
      this.next = n;
      this.syncing = null;
      return n;
    });
    return this.syncing;
  }
}
