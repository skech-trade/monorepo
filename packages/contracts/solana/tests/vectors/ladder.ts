/**
 * The ladder as `@skech/core` computes it, printed for the Solana program's tests to check its own against:
 *
 *   bun packages/contracts/solana/tests/vectors/ladder.ts > packages/contracts/solana/tests/vectors/ladder.json
 */
import { rungE2 } from "@skech/core/chain";

const chances = [1, 999, 1_000_000, 5_000_000, 7_812_500, 10_000_000, 20_000_000, 33_333_333, 50_000_000, 83_000_000, 100_000_000, 124_999_999, 125_000_000, 200_000_000, 333_333_333, 500_000_000, 664_000_000, 750_000_000, 905_454_545, 999_999_999, 1_000_000_000];
const momenta = [0, 1, 250_000, -500_000, 1_000_000, -1_999_999, 2_000_000, 5_000_000, -40_000_000];
const rows: [number, number, boolean, number, number][] = [];
for (const c of chances) for (let d = 0; d <= 100; d += 3) for (const w of [false, true]) for (const m of momenta) rows.push([c, d, w, m, rungE2(c, d, w, m)]);
console.log(JSON.stringify(rows));
