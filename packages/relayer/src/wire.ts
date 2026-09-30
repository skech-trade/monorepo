/**
 * What an app may send, checked before anything reads it: a JSON object, a `type` this relayer knows, and every
 * field it goes on to read of the right type, length and range, arrays bounded. A message that fails is answered
 * with why, in the reply its sender is waiting for; nothing an app sends can throw. Both relayers' messages are
 * here. What only a handler can check (a signature, a balance, the grid) is still checked there.
 */
import { HORIZON, MAX_SECTIONS } from "@skech/core/chain";

export const U64_MAX = (1n << 64n) - 1n;

/** Null when `v` passes; otherwise where in it the fault is, "" for `v` itself. */
export type Rule = (v: unknown) => string | null;
/** A message's fields, or a function of the message for one with more than one form. */
export type Spec = Record<string, Rule> | ((m: Record<string, unknown>) => Record<string, Rule>);

const pass = null;
const fault = "";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A chain number: a decimal string or a safe integer, never above uint64. */
export const uint: Rule = (v) => {
  if (typeof v === "string") return /^\d{1,20}$/.test(v) && BigInt(v) <= U64_MAX ? pass : fault;
  return Number.isSafeInteger(v) && (v as number) >= 0 ? pass : fault;
};
export const int =
  (min: number, max: number): Rule =>
  (v) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? pass : fault;
/** 0x hex: exactly `bytes` long, or up to `most` bytes. */
export const hex =
  (bytes: number | null, most = bytes ?? 0): Rule =>
  (v) =>
    typeof v === "string" && /^0x([0-9a-fA-F]{2})*$/.test(v) && (bytes === null ? v.length <= 2 + most * 2 : v.length === 2 + bytes * 2) ? pass : fault;
/** Hex with or without its 0x, as the phone sends bytes. */
export const bytes =
  (n: number | null, most = n ?? 0): Rule =>
  (v) =>
    typeof v === "string" && /^(0x)?([0-9a-fA-F]{2})*$/.test(v) && (n === null ? v.replace(/^0x/, "").length <= most * 2 : v.replace(/^0x/, "").length === n * 2) ? pass : fault;
export const address = hex(20);
/** A Solana address as text: base58, 32 to 44 characters. Whether it decodes is the handler's to say. */
export const base58: Rule = (v) => (typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? pass : fault);
export const text =
  (most: number, re?: RegExp): Rule =>
  (v) =>
    typeof v === "string" && v.length <= most && (!re || re.test(v)) ? pass : fault;
export const oneOf =
  (...values: unknown[]): Rule =>
  (v) =>
    values.includes(v) ? pass : fault;
/** Absent, or null as the apps send a field they have no value for. */
export const optional =
  (rule: Rule): Rule =>
  (v) =>
    v === undefined || v === null ? pass : rule(v);
export const list =
  (rule: Rule, most: number, least = 0): Rule =>
  (v) => {
    if (!Array.isArray(v) || v.length < least || v.length > most) return fault;
    for (const [i, x] of v.entries()) {
      const at = rule(x);
      if (at !== null) return at ? `${i}.${at}` : String(i);
    }
    return pass;
  };
export const object =
  (fields: Record<string, Rule>): Rule =>
  (v) => {
    if (!isObject(v)) return fault;
    for (const [k, rule] of Object.entries(fields)) {
      const at = rule(v[k]);
      if (at !== null) return at ? `${k}.${at}` : k;
    }
    return pass;
  };

/** A wallet's signature: 65 bytes from a key, longer from a smart account (ERC-1271, ERC-6492). */
const walletSig = hex(null, 4096);
/** A stroke's bytes: 33 of header and up to 2,048 points of 12. */
const STROKE_BYTES = 33 + 2048 * 12;

export const MONAD: Record<string, Spec> = {
  hello: {},
  account: {},
  watch: { player: address },
  activity: { player: optional(address) },
  piece: {
    piece: object({
      player: address,
      drawing: uint,
      index: int(0, 0xffffffff),
      market: int(0, 255),
      difficulty: int(0, 100),
      openAt: uint,
      perDot: uint,
      unit: uint,
      priceSeen: uint,
      priceTime: uint,
      sections: list(object({ second: int(1, HORIZON), lo: uint, hi: uint, stake: uint }), MAX_SECTIONS, 1),
      strokeHash: hex(32),
    }),
    sessionSig: hex(null, 65),
    priceSig: hex(65),
    stroke: hex(null, STROKE_BYTES),
  },
  session: { player: address, kind: oneOf(0, 1), key: address, x: hex(32), y: hex(32), validUntil: uint, allowance: uint, deadline: uint, sig: walletSig },
  // An EIP-3009 authorization, or an EIP-2612 permit for tokens without it.
  deposit: (m): Record<string, Rule> =>
    m.nonce !== undefined
      ? { owner: address, amount: uint, validAfter: uint, validBefore: uint, nonce: hex(32), sig: walletSig }
      : { owner: address, amount: uint, deadline: uint, v: int(0, 255), r: hex(32), s: hex(32) },
  withdraw: { player: address, amount: uint, to: address, deadline: uint, sig: walletSig },
};

export const SOLANA: Record<string, Spec> = {
  hello: {},
  account: {},
  sweep: {},
  watch: { player: base58 },
  activity: { player: optional(base58) },
  piece: {
    piece: object({
      player: base58,
      drawing: uint,
      index: int(0, 0xffffffff),
      market: int(0, 255),
      difficulty: int(0, 100),
      openAt: uint,
      perDot: int(0, 0xffffffff),
      unit: uint,
      priceSeen: uint,
      priceTime: uint,
      strokeHash: bytes(32),
      sections: list(object({ second: int(1, HORIZON), lo: int(0, 0xffffffff), width: int(1, 0xffff), stake: int(1, 0xffffffff) }), MAX_SECTIONS, 1),
    }),
    sessionSig: bytes(64),
    priceSig: bytes(65),
    stroke: bytes(null, STROKE_BYTES),
  },
  build: (m) => {
    const player = { kind: oneOf("session", "deposit", "withdraw", "revoke"), player: base58 };
    if (m.kind === "session") return { ...player, key: base58, validUntil: uint, allowance: uint, approve: optional(uint) };
    if (m.kind === "deposit") return { ...player, amount: uint };
    if (m.kind === "withdraw") return { ...player, amount: uint, to: optional(base58) };
    return player;
  },
  // A signed transaction is at most 1,232 bytes: 1,644 in base64.
  submit: { id: text(64), tx: text(2048, /^[A-Za-z0-9+/]*={0,2}$/), approve: optional(oneOf(true, false)) },
};

export type Message = Record<string, unknown> & { type: string };

/** The message in `raw`, or why it is not one (with what could be read of it, to answer in kind). */
export function read(raw: string | Buffer, specs: Record<string, Spec>): { msg: Message } | { why: string; msg: Record<string, unknown> | null } {
  let msg: unknown;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return { why: "Not JSON", msg: null };
  }
  if (!isObject(msg)) return { why: "Not a message", msg: null };
  const type = msg.type;
  if (typeof type !== "string" || !Object.hasOwn(specs, type)) return { why: `Unknown message ${typeof type === "string" ? type.slice(0, 32) : String(type)}`, msg: null };
  const spec = specs[type];
  const at = object(typeof spec === "function" ? spec(msg) : spec)(msg);
  if (at !== null) return { why: `Bad ${at || "message"}`, msg };
  return { msg: msg as Message };
}

/** A refusal in the reply the sender of `msg` waits for: an ack for a piece, `session-set` for a session, and so on. */
export function refusal(msg: Record<string, unknown> | null, why: string): Record<string, unknown> {
  const piece = isObject(msg?.piece) ? msg.piece : null;
  switch (msg?.type) {
    case "piece":
      return { type: "ack", ok: false, why, index: typeof piece?.index === "number" ? piece.index : undefined, drawing: typeof piece?.drawing === "string" ? piece.drawing.slice(0, 32) : undefined };
    case "session":
      return { type: "session-set", ok: false, why };
    case "deposit":
      return { type: "deposited", ok: false, why };
    case "withdraw":
      return { type: "withdrawn", ok: false, why };
    case "build":
      return { type: "built", kind: typeof msg.kind === "string" ? msg.kind.slice(0, 16) : undefined, ok: false, why };
    case "submit":
      return { type: "submitted", id: typeof msg.id === "string" ? msg.id.slice(0, 64) : "", ok: false, why };
    default:
      return { type: "error", why };
  }
}
