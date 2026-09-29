/**
 * Checking signatures before paying gas to put them on chain: a piece by its
 * session key (an Ethereum key, or the browser's P-256 key over SHA-256 of
 * the digest), and the price a player saw, by the engine.
 */
import { p256 } from "@noble/curves/p256";
import { TYPES, type Piece } from "@skech/core/chain";
import { type Address, type Hex, hashTypedData, hexToBytes, recoverAddress, sha256, type TypedDataDomain, verifyTypedData } from "viem";
import type { Session } from "./chain";

export const pieceDigest = (domain: TypedDataDomain, piece: Piece) => hashTypedData({ domain, types: TYPES, primaryType: "Piece", message: piece });

const ZERO = "0x0000000000000000000000000000000000000000";

/** Whether `sig` is the session's signature over the piece. */
export async function verifyPiece(domain: TypedDataDomain, piece: Piece, sig: Hex, session: Session): Promise<boolean> {
  const digest = pieceDigest(domain, piece);
  if (session.key !== ZERO) {
    if (sig.length !== 132) return false;
    try {
      return (await recoverAddress({ hash: digest, signature: sig })).toLowerCase() === session.key.toLowerCase();
    } catch {
      return false;
    }
  }
  if (sig.length !== 130) return false;
  try {
    const pub = hexToBytes(`0x04${session.x.slice(2)}${session.y.slice(2)}`);
    // Signed as WebCrypto signs: ECDSA over SHA-256 of the digest, r||s, s in the low half (as the contract insists).
    return p256.verify(hexToBytes(sig), hexToBytes(sha256(digest)), pub, { prehash: false, lowS: true });
  } catch {
    return false;
  }
}

/** Whether the engine signed this price at this time, under the game's domain. */
export function verifyPrice(domain: TypedDataDomain, signer: Address, market: string, priceE8: bigint, time: bigint, sig: Hex): Promise<boolean> {
  return verifyTypedData({ address: signer, domain, types: TYPES, primaryType: "Price", message: { market, price: priceE8, time }, signature: sig }).catch(() => false);
}
