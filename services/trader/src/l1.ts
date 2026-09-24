import { privateKeyToAccount } from "viem/accounts";

/**
 * The Ethereum half of a Lighter transaction.
 *
 * Some transactions need the account owner's wallet as well as its trading
 * key: registering a key, and moving money to an account that is not the
 * sender's own. The signer hands back `messageToSign`; the owner signs it as a
 * plain `personal_sign` message, the way Lighter's Python SDK does with
 * `encode_defunct`, and the signature goes into the transaction's `L1Sig`.
 *
 * A user's wallet signs in their browser. skech's own treasury wallet signs
 * here, with a key that only this service holds.
 */

/** The transaction with the owner's signature in the slot the signer left empty. */
export function withL1Sig(txInfo: string, signature: string): string {
  const tx = JSON.parse(txInfo) as Record<string, unknown>;
  tx.L1Sig = signature;
  return JSON.stringify(tx);
}

/** A wallet signature from a key held here. `key` is 0x-prefixed hex. */
export async function signL1(key: string, message: string): Promise<string> {
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);
  return account.signMessage({ message });
}

/** The address a wallet key belongs to, lowercased. */
export function addressOfKey(key: string): string {
  return privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`).address.toLowerCase();
}

/** A wallet signature as the page sends it: 65 bytes of hex. */
export const isSignature = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{130}$/.test(v);
