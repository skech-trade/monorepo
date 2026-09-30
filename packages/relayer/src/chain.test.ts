/**
 * Sending, against a node that loses track of a transaction: the send times out, and the transaction lands all
 * the same. The relayer must wait on that very transaction, not send the call again under a new nonce (both
 * would land: a bet placed twice, or placed and never settled).
 */
import { afterAll, expect, test } from "bun:test";
import { keccak256, type Hex } from "viem";
import { ChainClient } from "./chain";
import type { Config } from "./config";

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcab2ff4f6c7cd9b0d" as Hex; // anvil's first key
const GAME = "0x0000000000000000000000000000000000000abc";
const calls: string[] = [];
const sent: Hex[] = [];
let receiptAfter = 2;

const receiptOf = (hash: Hex) => ({
  transactionHash: hash,
  transactionIndex: "0x0",
  blockHash: `0x${"11".repeat(32)}`,
  blockNumber: "0x10",
  from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  to: GAME,
  cumulativeGasUsed: "0x5208",
  gasUsed: "0x5208",
  effectiveGasPrice: "0x3b9aca00",
  contractAddress: null,
  logs: [],
  logsBloom: `0x${"00".repeat(256)}`,
  status: "0x1",
  type: "0x2",
});

const rpc = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const one = (m: { id: number; method: string; params: unknown[] }) => {
      calls.push(m.method);
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
      switch (m.method) {
        case "eth_chainId":
          return ok("0x7a69");
        case "eth_getTransactionCount":
          return ok("0x5");
        case "eth_sendRawTransactionSync":
          sent.push(m.params[0] as Hex);
          return { jsonrpc: "2.0", id: m.id, error: { code: 4, message: "timeout: the transaction was not included in 8000 ms" } };
        case "eth_sendRawTransaction":
          return ok(keccak256(m.params[0] as Hex));
        case "eth_getTransactionReceipt":
          return ok(receiptAfter-- > 0 ? null : receiptOf(m.params[0] as Hex));
        default:
          return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no ${m.method}` } };
      }
    };
    return Response.json(Array.isArray(body) ? body.map(one) : one(body));
  },
});
afterAll(() => rpc.stop(true));

test("a send that times out is waited on by its hash, and never sent again under another nonce", async () => {
  const chain = new ChainClient({ key: KEY, chainId: 31337, rpcUrl: `http://127.0.0.1:${rpc.port}`, game: GAME } as unknown as Config, () => {});
  const receipt = await chain.send("collectFees", [], "collect", undefined, 50_000n);
  expect(sent).toHaveLength(1);
  expect(receipt.transactionHash).toBe(keccak256(sent[0]));
  // The same bytes again, while waiting, and nothing else signed.
  expect(calls.filter((c) => c === "eth_sendRawTransactionSync")).toHaveLength(1);
  expect(calls.filter((c) => c === "eth_getTransactionCount")).toHaveLength(1);
}, 10_000);
