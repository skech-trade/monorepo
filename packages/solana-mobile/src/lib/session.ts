import { ed25519 } from "@noble/curves/ed25519";
import { getAddressDecoder } from "@solana/kit";
import * as SecureStore from "expo-secure-store";

/**
 * The session key: an Ed25519 key the app makes once and keeps in the phone's secure store (the Keychain on
 * iPhones, the Keystore-backed store on Android), readable by this app alone and only on this device. The game
 * registers its public half against the player's wallet once, and from then on every piece of ink is signed
 * here, with no prompt. It can place pieces, up to the allowance the wallet set, and never withdraw.
 *
 * On the web it is a P-256 key WebCrypto keeps (Monad checks P-256); Solana checks Ed25519 natively, so here it is
 * Ed25519, verified by the chain's precompile over the piece exactly as it sits in the transaction.
 */

const NAME = "skech.session.ed25519";
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));

export type SessionKey = {
  /** Its public half, base58, as the game records it. */
  address: string;
  /** An Ed25519 signature over `message`, 64 bytes. */
  sign: (message: Uint8Array) => Uint8Array;
};

let cached: SessionKey | null = null;

/** The phone's session key, made on first use. */
export async function sessionKey(): Promise<SessionKey> {
  if (cached) return cached;
  let secret = await SecureStore.getItemAsync(NAME);
  if (!secret) {
    secret = hex(ed25519.utils.randomSecretKey());
    await SecureStore.setItemAsync(NAME, secret, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }
  const priv = unhex(secret);
  const address = getAddressDecoder().decode(ed25519.getPublicKey(priv));
  cached = { address, sign: (message) => ed25519.sign(message, priv) };
  return cached;
}

/** Throw the key away: the next session needs registering again. */
export async function forgetSessionKey() {
  cached = null;
  await SecureStore.deleteItemAsync(NAME);
}
