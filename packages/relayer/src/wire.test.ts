/**
 * Nothing an app sends can throw: each message is an object of a known type with every field it is read for in
 * shape, or it is answered with why, in the reply the app is waiting for.
 */
import { describe, expect, test } from "bun:test";
import { big, MONAD, read, refusal, SOLANA, U64_MAX } from "./wire";

const PLAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const hex = (bytes: number, fill = "ab") => `0x${fill.repeat(bytes)}`;
const section = { second: 2, lo: "8359140000000", hi: "8359200000000", stake: "50000" };
const piece = {
  player: PLAYER,
  drawing: "1790000000000",
  index: 3,
  market: 0,
  difficulty: 55,
  openAt: "1790000001000",
  perDot: "100000",
  unit: "20000000",
  priceSeen: "8359150000000",
  priceTime: "1790000000500",
  sections: [section],
  strokeHash: hex(32),
};
const pieceMsg = { type: "piece", piece, sessionSig: hex(64), priceSig: hex(65), stroke: hex(33) };
const monad = (m: unknown) => read(JSON.stringify(m), MONAD);
const why = (r: ReturnType<typeof read>) => ("why" in r ? r.why : null);

describe("what is not a message", () => {
  test("null, and every other JSON that is not an object, is turned away", () => {
    for (const raw of ["null", "1", '"piece"', "[]", '[{"type":"piece"}]', "true"]) expect(why(read(raw, MONAD))).toBe("Not a message");
  });
  test("text that is not JSON", () => {
    expect(why(read("{nope", MONAD))).toBe("Not JSON");
    expect(why(read(Buffer.from([0xff, 0x00]), MONAD))).toBe("Not JSON");
  });
  test("a type this relayer does not know, or none", () => {
    expect(why(monad({ type: "drain" }))).toBe("Unknown message drain");
    expect(why(monad({ type: "toString" }))).toBe("Unknown message toString");
    expect(why(monad({ type: 7 }))).toBe("Unknown message 7");
    expect(why(monad({ player: PLAYER }))).toBe("Unknown message undefined");
    // Solana's own messages are not Monad's.
    expect(why(monad({ type: "build", kind: "session" }))).toBe("Unknown message build");
  });
});

describe("a piece", () => {
  test("as the app sends it passes", () => {
    expect(why(monad(pieceMsg))).toBeNull();
  });
  test("with a section that is null, or not an object, says which", () => {
    expect(why(monad({ ...pieceMsg, piece: { ...piece, sections: [null] } }))).toBe("Bad piece.sections.0");
    expect(why(monad({ ...pieceMsg, piece: { ...piece, sections: [section, 5] } }))).toBe("Bad piece.sections.1");
    expect(why(monad({ ...pieceMsg, piece: null }))).toBe("Bad piece");
  });
  test("with more sections than a piece holds, or none", () => {
    expect(why(monad({ ...pieceMsg, piece: { ...piece, sections: Array(33).fill(section) } }))).toBe("Bad piece.sections");
    expect(why(monad({ ...pieceMsg, piece: { ...piece, sections: [] } }))).toBe("Bad piece.sections");
  });
  test("with a field of the wrong type or out of range", () => {
    expect(why(monad({ ...pieceMsg, piece: { ...piece, player: "0x12" } }))).toBe("Bad piece.player");
    expect(why(monad({ ...pieceMsg, piece: { ...piece, index: -1 } }))).toBe("Bad piece.index");
    expect(why(monad({ ...pieceMsg, piece: { ...piece, index: "3" } }))).toBe("Bad piece.index");
    expect(why(monad({ ...pieceMsg, piece: { ...piece, difficulty: 101 } }))).toBe("Bad piece.difficulty");
    expect(why(monad({ ...pieceMsg, piece: { ...piece, sections: [{ ...section, second: 31 }] } }))).toBe("Bad piece.sections.0.second");
    expect(why(monad({ ...pieceMsg, piece: { ...piece, sections: [{ ...section, lo: "1e9" }] } }))).toBe("Bad piece.sections.0.lo");
    expect(why(monad({ ...pieceMsg, priceSig: hex(64) }))).toBe("Bad priceSig");
    expect(why(monad({ ...pieceMsg, stroke: "0xabc" }))).toBe("Bad stroke");
    expect(why(monad({ ...pieceMsg, stroke: hex(33 + 2048 * 12 + 1) }))).toBe("Bad stroke");
  });
  test("a number past uint64 is refused; uint64's largest is not", () => {
    expect(why(monad({ ...pieceMsg, piece: { ...piece, perDot: (U64_MAX + 1n).toString() } }))).toBe("Bad piece.perDot");
    expect(why(monad({ ...pieceMsg, piece: { ...piece, perDot: "99999999999999999999" } }))).toBe("Bad piece.perDot");
    expect(why(monad({ ...pieceMsg, piece: { ...piece, perDot: U64_MAX.toString() } }))).toBeNull();
    expect(why(monad({ ...pieceMsg, piece: { ...piece, perDot: 2 ** 53 } }))).toBe("Bad piece.perDot");
  });
  test("big() reads a chain number, and nothing past uint64", () => {
    expect(big(U64_MAX.toString())).toBe(U64_MAX);
    expect(big((U64_MAX + 1n).toString())).toBeNull();
    expect(big("1".repeat(30))).toBeNull();
    expect(big(5)).toBe(5n);
    expect(big(2 ** 53)).toBeNull();
    expect(big(-1)).toBeNull();
    expect(big("0x10")).toBeNull();
  });
  test("is refused with an ack the app can match to what it sent", () => {
    const r = monad({ ...pieceMsg, piece: { ...piece, sections: [null] } });
    expect("why" in r && refusal(r.msg, r.why)).toEqual({ type: "ack", ok: false, why: "Bad piece.sections.0", index: 3, drawing: "1790000000000" });
  });
});

describe("what the wallet signs", () => {
  const session = { type: "session", player: PLAYER, kind: 1, key: "0x0000000000000000000000000000000000000000", x: hex(32), y: hex(32), validUntil: "1790086400", allowance: "100000000000", nonce: "0", deadline: "1790000600", sig: hex(65) };
  test("a session, and one with a field wrong, answered as session-set", () => {
    expect(why(monad(session))).toBeNull();
    const r = monad({ ...session, kind: 2 });
    expect("why" in r && refusal(r.msg, r.why)).toEqual({ type: "session-set", ok: false, why: "Bad kind" });
    expect(why(monad({ ...session, sig: hex(4097) }))).toBe("Bad sig");
  });
  test("a deposit in either form", () => {
    const auth = { type: "deposit", owner: PLAYER, amount: "1000000", validAfter: "0", validBefore: "1790000600", nonce: hex(32), sig: hex(65) };
    const permit = { type: "deposit", owner: PLAYER, amount: "1000000", deadline: "1790000600", v: 27, r: hex(32), s: hex(32) };
    expect(why(monad(auth))).toBeNull();
    expect(why(monad(permit))).toBeNull();
    expect(why(monad({ ...auth, nonce: hex(31) }))).toBe("Bad nonce");
    expect(why(monad({ ...permit, v: 256 }))).toBe("Bad v");
  });
  test("a withdrawal to a bad address", () => {
    const r = monad({ type: "withdraw", player: PLAYER, amount: "1000000", to: "me", deadline: "1790000600", sig: hex(65) });
    expect("why" in r && refusal(r.msg, r.why)).toEqual({ type: "withdrawn", ok: false, why: "Bad to" });
  });
  test("watch needs an address; activity may name one or not", () => {
    expect(why(monad({ type: "watch" }))).toBe("Bad player");
    expect(why(monad({ type: "activity" }))).toBeNull();
    expect(why(monad({ type: "activity", player: null }))).toBeNull();
    expect(why(monad({ type: "activity", player: 12 }))).toBe("Bad player");
  });
});

describe("on Solana", () => {
  const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const solana = (m: unknown) => read(JSON.stringify(m), SOLANA);
  const spiece = { ...piece, player: WALLET, perDot: 100_000, strokeHash: "ab".repeat(32), sections: [{ second: 1, lo: 417957, width: 4, stake: 50_000 }] };
  test("a piece as the phone sends it passes; a null section does not", () => {
    const m = { type: "piece", piece: spiece, sessionSig: hex(64), priceSig: hex(65), stroke: "ab".repeat(33) };
    expect(why(solana(m))).toBeNull();
    expect(why(solana({ ...m, piece: { ...spiece, sections: [null] } }))).toBe("Bad piece.sections.0");
    expect(why(solana({ ...m, piece: { ...spiece, player: "0OIl" } }))).toBe("Bad piece.player");
  });
  test("build by kind, answered as built", () => {
    expect(why(solana({ type: "build", kind: "session", player: WALLET, key: WALLET, validUntil: "1790086400", allowance: "20000000", approve: "5000000" }))).toBeNull();
    expect(why(solana({ type: "build", kind: "deposit", player: WALLET, amount: "10000000" }))).toBeNull();
    expect(why(solana({ type: "build", kind: "withdraw", player: WALLET, amount: "1000000" }))).toBeNull();
    expect(why(solana({ type: "build", kind: "revoke", player: WALLET }))).toBeNull();
    const r = solana({ type: "build", kind: "deposit", player: WALLET, amount: -1 });
    expect("why" in r && refusal(r.msg, r.why)).toEqual({ type: "built", kind: "deposit", ok: false, why: "Bad amount" });
    expect(why(solana({ type: "build", kind: "mint", player: WALLET }))).toBe("Bad kind");
  });
  test("submit, answered as submitted with its id", () => {
    expect(why(solana({ type: "submit", id: "0b9c", tx: "AQID", approve: true }))).toBeNull();
    const r = solana({ type: "submit", id: "0b9c", tx: "not base64!" });
    expect("why" in r && refusal(r.msg, r.why)).toEqual({ type: "submitted", id: "0b9c", ok: false, why: "Bad tx" });
    expect(why(solana({ type: "submit", id: "x".repeat(65), tx: "AQID" }))).toBe("Bad id");
  });
});
