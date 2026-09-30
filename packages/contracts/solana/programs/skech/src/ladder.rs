//! ladder-v1: what a section of ink pays, from its measured chance and the market's difficulty.
//!
//! The same integers as `SkechLadder.sol` and `rungE2` in `packages/core/src/chain.ts`, so what the app
//! shows, what Monad pays and what Solana pays cannot drift. `tests/src/ladder.rs` checks this against
//! vectors printed by the TypeScript.
//!
//!   best   = 1.20 - 0.40 * d/100          what ink exactly on a rung returns, per dollar (e3 here)
//!   floor  = 1.10, easing to 1.00 from d = 70 to 100   the least any ink pays (e2 here)
//!   margin = 0.11 * min(2, |momentum|)    taken off the side the price just moved toward
//!   fair   = (best - margin) / chance
//!   rung   = the highest rung <= fair, or the floor if fair is under it
//!   a section never pays more than 256 dots: a big one stakes only what that pays for

/// The rungs, x100: 1.1x, 1.5x, 2x, 3x, 4x, 6x, 8x, 12x, 16x, 24x, 32x, 48x, 64x, 96x, 128x.
pub const RUNGS: [u16; 15] = [110, 150, 200, 300, 400, 600, 800, 1200, 1600, 2400, 3200, 4800, 6400, 9600, 12800];
/// The most one section pays, in dots.
pub const MAX_DOTS: u64 = 256;
/// The momentum margin, x1000, per unit of momentum, over at most two units.
pub const MARGIN_E3: u64 = 110;
pub const CHANCE_ONE: u32 = 1_000_000_000;

/// What ink exactly on a rung returns per dollar at difficulty `d`, x1000: 1200 - 4d.
pub fn best_e3(d: u8) -> u64 {
    1200 - 4 * d as u64
}

/// The least any hit pays at difficulty `d`, x100: 110 up to 70, easing to 100 at 100 (rounded, as the app rounds).
pub fn floor_e2(d: u8) -> u16 {
    if d <= 70 {
        return 110;
    }
    110 - (((d as u64 - 70) * 10 + 15) / 30) as u16
}

/// The rung, x100, a section of chance `chance_e9` (in billionths) earns at difficulty `d`; 0 when it is not offered.
/// `with_it`: the section is on the side the price just moved toward, where the margin comes off.
/// `momentum_e6`: the last three seconds' move in units of volatility, x1e6, signed.
pub fn rung_for(chance_e9: u32, d: u8, with_it: bool, momentum_e6: i64) -> u16 {
    if chance_e9 == 0 || chance_e9 > CHANCE_ONE || d > 100 {
        return 0;
    }
    let margin_e9: u128 = if with_it { MARGIN_E3 as u128 * momentum_e6.unsigned_abs().min(2_000_000) as u128 } else { 0 };
    // best_e3 is at least 800 and the margin at most 0.22, so this is positive: fair x1000, rounded down.
    let fair_e3 = ((best_e3(d) as u128 * 1_000_000 - margin_e9) * CHANCE_ONE as u128) / (chance_e9 as u128 * 1_000_000);
    let mut best = floor_e2(d);
    for r in RUNGS {
        if r as u128 * 10 > fair_e3 {
            break;
        }
        if r > best {
            best = r;
        }
    }
    best
}

/// The most a section paying `rung_e2` may stake at `per_dot`, so it never pays past MAX_DOTS dots.
pub fn max_stake(per_dot: u64, rung_e2: u16) -> u64 {
    ((per_dot as u128 * MAX_DOTS as u128 * 100) / rung_e2 as u128) as u64
}

/// What a hit on `stake` at `rung_e2` pays, before fees.
pub fn gross(stake: u64, rung_e2: u16) -> u64 {
    ((stake as u128 * rung_e2 as u128) / 100) as u64
}

/// Whether a band is on the side the price has just moved toward, where the momentum margin comes off.
pub fn with_momentum(lo: u64, hi: u64, price: u64, momentum_e6: i64) -> bool {
    let mid = (lo as u128 + hi as u128) / 2;
    (mid > price as u128 && momentum_e6 > 0) || (mid < price as u128 && momentum_e6 < 0)
}

/// Whether a second's range reaches a band: from the second before's close to its high and low, one unit wider
/// each way, inclusive, as the band was priced.
pub fn crosses(prev_close: u64, high: u64, low: u64, lo: u64, hi: u64, unit: u64) -> bool {
    let high = high.max(prev_close) as u128;
    let low = low.min(prev_close) as u128;
    high + unit as u128 >= lo as u128 && low <= hi as u128 + unit as u128
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rungs_are_the_ladder() {
        // 1.1, 1.5, then doubling with one rung between each pair, as SkechLadder.rung computes them.
        for (i, r) in RUNGS.iter().enumerate() {
            let want = match i {
                0 => 110,
                1 => 150,
                _ if i % 2 == 0 => 200u16 << (i / 2 - 1),
                _ => 300u16 << ((i - 3) / 2),
            };
            assert_eq!(*r, want);
        }
    }

    #[test]
    fn edges() {
        assert_eq!(rung_for(0, 51, false, 0), 0);
        assert_eq!(rung_for(CHANCE_ONE + 1, 51, false, 0), 0);
        assert_eq!(rung_for(500_000_000, 101, false, 0), 0);
        // A sure thing pays the floor.
        assert_eq!(rung_for(CHANCE_ONE, 0, false, 0), 110);
        assert_eq!(floor_e2(100), 100);
        // 50% at d=51: fair 1.992x, rung 1.5x (HOW-IT-WORKS, fees and the pool).
        assert_eq!(rung_for(500_000_000, 51, false, 0), 150);
        assert_eq!(max_stake(100_000, 150), 17_066_666);
        assert_eq!(gross(50_000, 150), 75_000);
    }
}
