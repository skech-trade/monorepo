import { describe, expect, test } from "bun:test";
import { chainIdFor, network, networkOf, rpcFor } from "./network";

describe("network", () => {
  test("blank is testnet, names are case-blind, anything else throws", () => {
    expect(network(undefined).chainId).toBe(10143);
    expect(network("").chainId).toBe(10143);
    expect(network(" Mainnet ").chainId).toBe(143);
    expect(() => network("main")).toThrow("testnet or mainnet");
  });
  test("only testnet has a faucet", () => {
    expect(network("testnet").faucet).toBe("https://faucet.circle.com/");
    expect(network("mainnet").faucet).toBeNull();
  });
  test("chain ids map back", () => {
    expect(networkOf(143)?.name).toBe("mainnet");
    expect(networkOf(31337)).toBeNull();
  });
  test("the network picks the chain; anvil may override; the other network may not", () => {
    expect(chainIdFor({ SKECH_NETWORK: "mainnet" })).toBe(143);
    expect(chainIdFor({ SKECH_NETWORK: "testnet", ENGINE_CHAIN_ID: "31337" })).toBe(31337);
    expect(chainIdFor({ SKECH_NETWORK: "testnet", ENGINE_CHAIN_ID: "10143" })).toBe(10143);
    expect(() => chainIdFor({ SKECH_NETWORK: "mainnet", ENGINE_CHAIN_ID: "10143" })).toThrow("remove ENGINE_CHAIN_ID");
  });
  test("RPC: one-off, then the network's private endpoint, then public", () => {
    expect(rpcFor({ MONAD_RPC_URL: "http://x" }, 143)).toBe("http://x");
    expect(rpcFor({ MONAD_TESTNET_RPC_URL: "http://t", MONAD_MAINNET_RPC_URL: "http://m" }, 143)).toBe("http://m");
    expect(rpcFor({ MONAD_TESTNET_RPC_URL: "http://t" }, 143)).toBe("https://rpc.monad.xyz");
    expect(rpcFor({}, 31337)).toBe("http://127.0.0.1:8545");
  });
});
