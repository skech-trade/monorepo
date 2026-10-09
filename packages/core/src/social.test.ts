import { describe, expect, test } from "bun:test";
import { avatarSeedOf, avatarSeedProblem, BIO_MAX, cleanBio, looksLikePlayer, playerHue, playerName, usernameProblem, windowStart } from "./social";

describe("social", () => {
  test("usernames: lowercase, 3 to 24, a letter first, nothing reserved", () => {
    expect(usernameProblem("ink_maker_7")).toBeNull();
    expect(usernameProblem("abc")).toBeNull();
    expect(usernameProblem("a".repeat(24))).toBeNull();
    for (const bad of ["ab", "a".repeat(25), "Ink", "7ink", "_ink", "ink-maker", "ink maker", "ïnk", "", null, 42]) expect(usernameProblem(bad)).not.toBeNull();
    expect(usernameProblem("admin")).toBe("That username is reserved");
    expect(usernameProblem("skech_official")).toBe("That username is reserved");
  });

  test("bios: trimmed, at most 160 characters and five lines, nothing hidden", () => {
    expect(cleanBio("  draws ahead  ")).toBe("draws ahead");
    expect(cleanBio("a\r\nb")).toBe("a\nb");
    expect(cleanBio("é".repeat(BIO_MAX))).toHaveLength(BIO_MAX);
    // Characters, not UTF-16 units: an emoji is one.
    expect(cleanBio("🖊".repeat(BIO_MAX))).toBe("🖊".repeat(BIO_MAX));
    expect(() => cleanBio("x".repeat(BIO_MAX + 1))).toThrow();
    expect(() => cleanBio("a\nb\nc\nd\ne\nf")).toThrow();
    for (const hidden of ["a‮b", "a​b", "a\u0000b", "a\tb"]) expect(() => cleanBio(hidden)).toThrow();
    expect(() => cleanBio(5)).toThrow();
  });

  test("players are base58 Solana addresses, case and all", () => {
    expect(looksLikePlayer("EQmnM7EP6ewPvjq81cCKmcKKzXFi5WGuciHfDtTCpyxF")).toBe(true);
    expect(looksLikePlayer("0x0000000000000000000000000000000000000000")).toBe(false);
    expect(looksLikePlayer("EQmnM7EP6ewPvjq81cCKmcKKzXFi5WGuciHfDtTCpyx0")).toBe(false);
    expect(playerName({ player: "EQmnM7EP6ewPvjq81cCKmcKKzXFi5WGuciHfDtTCpyxF", username: null })).toBe("EQmn…pyxF");
    expect(playerName({ player: "x", username: "pen" })).toBe("pen");
    const hue = playerHue("EQmnM7EP6ewPvjq81cCKmcKKzXFi5WGuciHfDtTCpyxF");
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });

  test("avatar seeds: the address and a number, or a short safe word; none is the address", () => {
    const a = "EQmnM7EP6ewPvjq81cCKmcKKzXFi5WGuciHfDtTCpyxF";
    for (const ok of [`${a}:0`, `${a}:123456`, "pen", "ink_maker-7", null]) expect(avatarSeedProblem(ok)).toBeNull();
    for (const bad of [`${a}:1234567`, `${a}:x`, "a".repeat(33), "<svg>", "x y", "", "seed\n", "0x" + "f".repeat(64), 5, undefined]) expect(avatarSeedProblem(bad)).not.toBeNull();
    expect(avatarSeedOf({ player: a, avatarSeed: null })).toBe(a);
    expect(avatarSeedOf({ player: a, avatarSeed: `${a}:3` })).toBe(`${a}:3`);
  });

  test("windows", () => {
    expect(windowStart("all", 1e12)).toBe(0);
    expect(windowStart("24h", 1e12)).toBe(1e12 - 86_400_000);
  });
});
