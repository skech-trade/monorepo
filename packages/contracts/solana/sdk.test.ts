import { expect, test } from "bun:test";
import { address } from "@solana/kit";
import vectors from "./tests/vectors/piece.json";
import { DEFAULT_CONFIG, domainFor, ed25519Instruction, pieceBytes, SKECH_PROGRAM_ADDRESS } from "./sdk";

test("the client is for the program the vectors come from", () => {
  expect(SKECH_PROGRAM_ADDRESS as string).toBe(address(vectors.program));
});

test("the domain is what the program computes", async () => {
  expect([...(await domainFor(SKECH_PROGRAM_ADDRESS, "devnet"))]).toEqual(vectors.domain);
});

test("a piece's signed bytes are its Borsh encoding, as the program reads it", async () => {
  const bytes = pieceBytes({
    domain: Uint8Array.from(vectors.domain),
    player: address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
    drawing: 1_790_000_123_456n,
    index: 7,
    market: 0,
    difficulty: 40,
    openAt: 1_790_000_001_000n,
    perDot: 100_000,
    unit: 20_000_000n,
    priceSeen: 8_300_012_345_678n,
    priceTime: 1_790_000_000_450n,
    strokeHash: new Uint8Array(32).fill(0xab),
    sections: [
      { second: 1, lo: 415_000, width: 5, stake: 50_000 },
      { second: 30, lo: 414_990, width: 12, stake: 4_294_967_295 },
    ],
  });
  expect([...bytes]).toEqual(vectors.piece);
});

test("the Ed25519 instruction points at the piece inside place", () => {
  const ix = ed25519Instruction(new Uint8Array(32).fill(1), new Uint8Array(64).fill(2), 2, 172);
  const d = ix.data!;
  const v = new DataView(d.buffer, d.byteOffset);
  expect(d.length).toBe(112);
  expect([d[0], v.getUint16(2, true), v.getUint16(4, true), v.getUint16(6, true), v.getUint16(8, true), v.getUint16(10, true), v.getUint16(12, true), v.getUint16(14, true)]).toEqual([1, 48, 0xffff, 16, 0xffff, 8, 172, 2]);
});

test("the default config is the EVM game's, as SkechGame.initialize writes it", async () => {
  const sol = await Bun.file(new URL("../evm/src/SkechGame.sol", import.meta.url)).text();
  const init = sol.slice(sol.indexOf("function initialize("));
  const body = init.slice(init.indexOf("Config({") + 8, init.indexOf("})"));
  const evm = Object.fromEntries(
    body
      .split("\n")
      .map((l) => l.split("//")[0].trim().replace(/,$/, ""))
      .filter(Boolean)
      .map((l) => l.split(":").map((x) => x.trim()))
      .map(([k, v]) => [k, BigInt(v.replaceAll("_", ""))]),
  );
  const { maxSessionSecs: _, ...shared } = DEFAULT_CONFIG;
  expect(Object.fromEntries(Object.entries(shared).map(([k, v]) => [k, BigInt(v)]))).toEqual(evm);
});
