import { CString, dlopen, FFIType, ptr, read } from "bun:ffi";

/**
 * Lighter's own signer, called from TypeScript.
 *
 * The signer is Go compiled to a C shared library and is published only
 * inside Lighter's Python wheel; `native/fetch-signer.sh` takes it out of
 * there and `native/build.sh` compiles a small shim over it, because every
 * signing call returns a struct by value and Bun's FFI cannot take one back.
 *
 * Nothing about the signatures is reimplemented here. They come out of
 * Lighter's binary exactly as the Python and Go SDKs get them; this file only
 * carries arguments in and strings out.
 */

const LIB = process.env.LIGHTER_SHIM ?? `${import.meta.dir}/../native/vendor/shim.${process.platform === "darwin" ? "dylib" : "so"}`;

const lib = dlopen(LIB, {
  shim_create_client: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32, FFIType.i32, FFIType.i64], returns: FFIType.ptr },
  shim_check_client: { args: [FFIType.i32, FFIType.i64], returns: FFIType.ptr },
  shim_sign_create_order: {
    args: [FFIType.i32, FFIType.i64, FFIType.i64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32,
           FFIType.i64, FFIType.u8, FFIType.i64, FFIType.i32, FFIType.i64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  shim_sign_update_leverage: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u8, FFIType.i64, FFIType.i32, FFIType.i64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  shim_sign_cancel_all: {
    args: [FFIType.i32, FFIType.i64, FFIType.i32, FFIType.u8, FFIType.i64, FFIType.i32, FFIType.i64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  shim_generate_api_key: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  shim_sign_change_pub_key: {
    args: [FFIType.cstring, FFIType.u8, FFIType.i64, FFIType.i32, FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  shim_auth_token: { args: [FFIType.i64, FFIType.i32, FFIType.i64, FFIType.ptr], returns: FFIType.ptr },
  shim_free: { args: [FFIType.ptr], returns: FFIType.void },
});

const cstr = (s: string) => ptr(Buffer.from(`${s}\0`, "utf8"));

/** Read a string the shim allocated, then hand the memory back. */
function taken(p: number | bigint | null): string | null {
  const n = Number(p ?? 0);
  if (!n) return null;
  const s = new CString(n as never).toString();
  lib.symbols.shim_free(n as never);
  return s;
}

/** One out-pointer slot for the shim to fill. */
const slot = () => new BigUint64Array(1);
const value = (s: BigUint64Array) => taken(read.ptr(ptr(s), 0));

/** Every order type Lighter takes. Numbers are the venue's, not ours. */
export const ORDER = { limit: 0, market: 1, stopLoss: 2, stopLossLimit: 3, takeProfit: 4, takeProfitLimit: 5, twap: 6 } as const;
export const TIF = { ioc: 0, gtt: 1, postOnly: 2 } as const;
/**
 * How long an order lives. An immediate-or-cancel one is gone the moment it
 * is filled or not, so it expires at zero; anything that rests uses the
 * venue's twenty-eight day default, which it spells as minus one. Sending
 * minus one on an IOC order comes back as "OrderExpiry is invalid".
 */
export const EXPIRY = { ioc: 0n, resting: -1n } as const;
export const MARGIN_MODE = { cross: 0, isolated: 1 } as const;

export type Signed = { txInfo: string; txHash: string };

/** A trading keypair. The public half is registered; the private half signs. */
export type ApiKey = { privateKey: string; publicKey: string };

/**
 * A fresh trading key, belonging to nobody yet.
 *
 * One per wallet is what lets somebody trade their own Lighter account rather
 * than a shared one. Registering it is the separate step below, and it needs
 * the account's owner to agree with their Ethereum wallet.
 */
export function generateApiKey(): ApiKey {
  const priv = slot();
  const pub = slot();
  const err = taken(lib.symbols.shim_generate_api_key(ptr(priv), ptr(pub)));
  if (err) throw new Error(`lighter signer: ${err}`);
  const privateKey = value(priv);
  const publicKey = value(pub);
  if (!privateKey || !publicKey) throw new Error("lighter signer: no key came back");
  return { privateKey, publicKey };
}

export class Signer {
  constructor(
    private readonly accountIndex: bigint,
    private readonly apiKeyIndex: number,
  ) {}

  /**
   * Load a key. `chainId` is 300 on testnet and 304 on mainnet; the signer
   * bakes it into every signature, so a wrong one produces signatures the
   * venue rejects without saying why.
   */
  static open(opts: { url: string; privateKey: string; chainId: number; accountIndex: number | bigint; apiKeyIndex: number; check?: boolean }): Signer {
    const account = BigInt(opts.accountIndex);
    const err = taken(lib.symbols.shim_create_client(cstr(opts.url), cstr(opts.privateKey), opts.chainId, opts.apiKeyIndex, account));
    if (err) throw new Error(`lighter signer: ${err}`);
    const signer = new Signer(account, opts.apiKeyIndex);
    /*
      Checked by default, because a key that is not the registered one signs
      orders the venue silently refuses. Skipped for exactly one case: a key
      that has just been generated and is signing its own registration, which
      by definition is not registered yet.
    */
    if (opts.check !== false) signer.check();
    return signer;
  }

  /** Throws unless this key is the one registered at this index on this account. */
  check() {
    const err = taken(lib.symbols.shim_check_client(this.apiKeyIndex, this.accountIndex));
    if (err) throw new Error(`lighter signer: ${err}`);
  }

  /**
   * Register a public key against this account, at this key index.
   *
   * The account's owner has to agree, and they prove it with the Ethereum
   * wallet that owns the account: `messageToSign` comes back for that wallet
   * to sign, and the signature goes into the transaction before it is sent.
   * Nothing here can produce that signature, which is the point of it.
   */
  changePubKey(publicKey: string, nonce = -1n): Signed & { messageToSign: string } {
    const info = slot();
    const hash = slot();
    const message = slot();
    const err = taken(
      lib.symbols.shim_sign_change_pub_key(cstr(publicKey), 0, nonce, this.apiKeyIndex, this.accountIndex, ptr(info), ptr(hash), ptr(message)),
    );
    if (err) throw new Error(`lighter signer: ${err}`);
    return { txInfo: value(info) ?? "", txHash: value(hash) ?? "", messageToSign: value(message) ?? "" };
  }

  /**
   * Sign an order. `baseAmount` is in the market's size steps and `price` in
   * its price steps, both integers, because that is what the venue receives.
   * For a market order the price is the worst fill you will accept.
   */
  createOrder(o: {
    marketIndex: number;
    clientOrderIndex: bigint;
    baseAmount: bigint;
    price: number;
    isAsk: boolean;
    type?: number;
    timeInForce?: number;
    reduceOnly?: boolean;
    triggerPrice?: number;
    expiry?: bigint;
    nonce?: bigint;
  }): Signed {
    const info = slot();
    const hash = slot();
    const err = taken(
      lib.symbols.shim_sign_create_order(
        o.marketIndex,
        o.clientOrderIndex,
        o.baseAmount,
        o.price,
        o.isAsk ? 1 : 0,
        o.type ?? ORDER.market,
        o.timeInForce ?? TIF.ioc,
        o.reduceOnly ? 1 : 0,
        o.triggerPrice ?? 0,
        o.expiry ?? ((o.timeInForce ?? TIF.ioc) === TIF.ioc ? EXPIRY.ioc : EXPIRY.resting),
        0,
        o.nonce ?? -1n,
        this.apiKeyIndex,
        this.accountIndex,
        ptr(info),
        ptr(hash),
      ),
    );
    return this.done(err, info, hash);
  }

  /** Isolated margin at this leverage, which above 20x the venue requires explicitly. */
  updateLeverage(marketIndex: number, leverage: number, mode: number = MARGIN_MODE.isolated, nonce = -1n): Signed {
    const info = slot();
    const hash = slot();
    // The venue takes initial margin in basis points, which is what leverage means to it.
    const fraction = Math.round(10_000 / leverage);
    const err = taken(lib.symbols.shim_sign_update_leverage(marketIndex, fraction, mode, 0, nonce, this.apiKeyIndex, this.accountIndex, ptr(info), ptr(hash)));
    return this.done(err, info, hash);
  }

  cancelAll(marketIndex: number, timeInForce = 0, at = 0n, nonce = -1n): Signed {
    const info = slot();
    const hash = slot();
    const err = taken(lib.symbols.shim_sign_cancel_all(timeInForce, at, marketIndex, 0, nonce, this.apiKeyIndex, this.accountIndex, ptr(info), ptr(hash)));
    return this.done(err, info, hash);
  }

  /** A bearer token for the read endpoints that want one. */
  authToken(deadline: bigint): string {
    const out = slot();
    const err = taken(lib.symbols.shim_auth_token(deadline, this.apiKeyIndex, this.accountIndex, ptr(out)));
    const token = value(out);
    if (err || !token) throw new Error(`lighter signer: ${err ?? "no token"}`);
    return token;
  }

  private done(err: string | null, info: BigUint64Array, hash: BigUint64Array): Signed {
    const txInfo = value(info);
    const txHash = value(hash);
    if (err) throw new Error(`lighter signer: ${err}`);
    if (!txInfo || !txHash) throw new Error("lighter signer: nothing came back");
    return { txInfo, txHash };
  }
}
