import { describe, expect, test } from "bun:test";
import { parseDestination } from "./destination";

const A = "0x6d5a88C06e0345Eb673bc96A86918a89a0FB710b";
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

describe("parseDestination", () => {
  test("a plain address, any case, with stray whitespace", () => {
    expect(parseDestination(`  ${A.toLowerCase()}\n`)).toEqual({ address: A });
  });
  test("EIP-681 native forms", () => {
    expect(parseDestination(`ethereum:${A}`)).toEqual({ address: A, chainId: undefined, amount: undefined });
    expect(parseDestination(`ethereum:${A}@10143`)).toEqual({ address: A, chainId: 10143, amount: undefined });
    expect(parseDestination(`ethereum:pay-${A}@10143?value=1e18`)).toEqual({ address: A, chainId: 10143, amount: undefined });
    expect(parseDestination(`ethereum:${A}?amount=12.345`)).toEqual({ address: A, chainId: undefined, amount: 12.34 });
  });
  test("an EIP-681 USDC transfer gives the recipient and the amount", () => {
    expect(parseDestination(`ethereum:${USDC}@10143/transfer?address=${A}&uint256=5e6`, USDC)).toEqual({ address: A, token: USDC, chainId: 10143, amount: 5 });
    expect(parseDestination(`ethereum:${USDC}@10143/transfer?address=${A}`, USDC)).toEqual({ address: A, token: USDC, chainId: 10143, amount: undefined });
  });
  test("refuses what it cannot send to", () => {
    expect(parseDestination("")).toEqual({ error: "Paste or scan an address" });
    expect(parseDestination("hello")).toEqual({ error: "That isn't an address" });
    expect(parseDestination("0x1234")).toEqual({ error: "That isn't an address" });
    expect(parseDestination(`ethereum:${A}@1/transfer?address=${A}`, USDC)).toEqual({ error: "That code is for a different token, not USDC" });
    expect(parseDestination(`ethereum:${USDC}/transfer?uint256=1`, USDC)).toEqual({ error: "That code has no address to send to" });
    expect(parseDestination(`ethereum:${A}/approve?address=${A}`)).toEqual({ error: "That code asks for something other than a transfer" });
  });
});
