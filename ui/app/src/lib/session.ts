"use client";

import { type Hex, hexToBytes, bytesToHex } from "viem";

/**
 * The session key: a P-256 key the browser makes and keeps, and will sign
 * with but never hand over. It lives in IndexedDB as a non-extractable
 * CryptoKey, so nothing on the page, not even this code, can read it out.
 * The game registers its public half against the player's wallet once, and
 * from then on every piece of ink is signed here, with no prompt.
 *
 * Signing is ECDSA over SHA-256 of what it is given, as WebCrypto does it;
 * the contract hashes the same way before it checks (`SkechGame._check`).
 * Monad checks P-256 natively, so this costs about what an Ethereum
 * signature does.
 */

const DB = "skech";
const STORE = "keys";
const NAME = "session:p256";
/** P-256's order, to keep `s` in the low half, as the contract insists. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export type SessionKey = {
  x: Hex;
  y: Hex;
  /** r‖s, 64 bytes, low s. */
  sign: (digest: Hex) => Promise<Hex>;
};

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function wrap(pair: CryptoKeyPair): Promise<SessionKey> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("Not a P-256 public key");
  return {
    x: bytesToHex(raw.slice(1, 33)),
    y: bytesToHex(raw.slice(33, 65)),
    sign: async (digest) => {
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new Uint8Array(hexToBytes(digest))));
      const r = sig.slice(0, 32);
      let s = BigInt(bytesToHex(sig.slice(32, 64)));
      if (s > N / 2n) s = N - s;
      return bytesToHex(new Uint8Array([...r, ...hexToBytes(`0x${s.toString(16).padStart(64, "0")}`)]));
    },
  };
}

/** Whether this browser can hold a session key at all. */
export const canHoldSession = () => typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle;

/** The browser's session key, made on first use. */
export async function sessionKey(): Promise<SessionKey> {
  const db = await open();
  let pair = (await tx<CryptoKeyPair | undefined>(db, "readonly", (s) => s.get(NAME))) ?? null;
  if (!pair) {
    pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    await tx(db, "readwrite", (s) => s.put(pair, NAME));
  }
  db.close();
  return wrap(pair);
}

/** Throw the key away: the next visit makes a new one, which needs registering again. */
export async function forgetSessionKey() {
  const db = await open();
  await tx(db, "readwrite", (s) => s.delete(NAME));
  db.close();
}
