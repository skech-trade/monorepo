import { expect, test } from "bun:test";
import { addressOf, readJson } from "./http";

test("an address is forty hex digits, and comes back lowercased", () => {
  expect(addressOf("0xABCDEF0123456789abcdef0123456789ABCDEF01")).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
  for (const v of [null, undefined, 42, "", "0x123", "abcdef0123456789abcdef0123456789abcdef0123", "0xabcdef0123456789abcdef0123456789abcdef0g"]) {
    expect(addressOf(v)).toBeNull();
  }
});

test("a body is an object or nothing", async () => {
  const post = (body: string) => new Request("http://localhost/", { method: "POST", body });
  expect(await readJson(post('{"address":"0x1"}'))).toEqual({ address: "0x1" });
  for (const body of ["null", "7", '"x"', "not json", ""]) expect(await readJson(post(body))).toBeNull();
});
