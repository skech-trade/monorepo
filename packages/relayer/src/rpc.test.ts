import { describe, expect, test } from "bun:test";
import { createPublicClient, custom, RpcRequestError } from "viem";
import { isRateLimited, patient, redact } from "./rpc";

/** A node that turns away the first `n` requests the way Monad does, then answers. */
function node(n: number, code = -32011, message = "requests limited to 15/sec") {
  let seen = 0;
  const calls: string[] = [];
  const transport = custom({
    async request({ method }) {
      calls.push(method);
      if (seen++ < n) throw new RpcRequestError({ body: { method }, error: { code, message }, url: "https://testnet-rpc.monad.xyz" });
      return "0x279f"; // 10143
    },
  });
  return { transport, calls };
}

describe("Monad's rate limit", () => {
  test("is recognised, and nothing else is", () => {
    expect(isRateLimited(new RpcRequestError({ body: {}, error: { code: -32011, message: "requests limited to 15/sec" }, url: "x" }))).toBe(true);
    expect(isRateLimited({ status: 429 })).toBe(true);
    expect(isRateLimited(new RpcRequestError({ body: {}, error: { code: -32000, message: "nonce too low" }, url: "x" }))).toBe(false);
    expect(isRateLimited(new Error("execution reverted"))).toBe(false);
  });

  test("is waited out: the same request goes again until it is answered", async () => {
    const { transport, calls } = node(3);
    const throttled: number[] = [];
    const client = createPublicClient({ transport: patient(transport, (_, attempt) => throttled.push(attempt)) });
    expect(await client.getChainId()).toBe(10143);
    expect(calls.length).toBe(4);
    expect(throttled).toEqual([1, 2, 3]);
  });

  test("gives up after the last wait", async () => {
    const { transport, calls } = node(99);
    const client = createPublicClient({ transport: patient(transport) });
    await expect(client.getChainId()).rejects.toThrow();
    expect(calls.length).toBe(6);
  });

  test("other errors are not retried here", async () => {
    const { transport, calls } = node(1, -32000, "nonce too low");
    const client = createPublicClient({ transport: patient(transport) });
    await expect(client.getChainId()).rejects.toThrow();
    expect(calls.length).toBe(1);
  });
});

describe("QuickNode", () => {
  test("its rate limits are recognised too", () => {
    expect(isRateLimited(new RpcRequestError({ body: {}, error: { code: -32007, message: "50/second request limit reached - reduce calls per second or upgrade your account at quicknode.com" }, url: "x" }))).toBe(true);
  });
  test("an endpoint's token never reaches a log", () => {
    expect(redact("https://example-name.monad-testnet.quiknode.pro/7a0bdeadbeef/")).toBe("https://example-name.monad-testnet.quiknode.pro/…");
    expect(redact("https://testnet-rpc.monad.xyz")).toBe("https://testnet-rpc.monad.xyz");
    expect(redact("https://rpc.example/?apikey=secret")).toBe("https://rpc.example/…");
    expect(redact("not a url")).toBe("<rpc>");
  });
});
