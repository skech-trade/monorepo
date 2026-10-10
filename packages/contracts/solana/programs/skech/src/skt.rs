//! SKT: what losing earns back. Every band that misses mints SKT at its settlement, on its basis; SKT never moves and is
//! always staked, and every SKT earns an equal part of the holders' share of the fees.
//!
//! - **The fees.** Of the stake fee, `holder_fee_bps` (3 of 4 points) is the holders'; of the profit fee,
//!   `holder_profit_fee_bps` (8 of 10). The house keeps the rest and every rounding. While anything is owed as IOU
//!   the holders' share goes to the pool, to pay it off; while no SKT exists, to the treasury. The mint is never
//!   changed by what is owed.
//! - **The accumulator.** Each share raises `acc` by `share · ACC_SCALE / supply`, rounded down. A holder's earnings
//!   are `skt · (acc − acc_at) / ACC_SCALE`, rounded down, counted into `unclaimed` before their balance changes and
//!   before a claim. So no holder is ever paid more than their part of what was accrued.
//! - **The basis.** A band of stake `s`, chance `p` (the oracle's, as quoted) and rung `m` that misses counts
//!   `s · [(1 − p·m) + f·p·(m − 1)] / (1 − p)`, with `f` the profit fee; a hit counts nothing. In expectation that is
//!   `s · [(1 − p·m) + f·p·(m − 1)]`, the band's expected loss with the profit fee a hit pays, whatever `p`: a 1% long
//!   shot and ink at the price earn the same SKT per dollar they can expect to lose. The stake fee is not added: it is
//!   taken from the stake a hit pays on, so it is in `s(1 − p·m)` already, and adding it would mint on ink that
//!   loses nothing (the audit's farm table: it makes near-certain ink mint more than a dollar's basis per real dollar).
//! - **The curve.** A dollar of basis mints `100 · (S / (S + G))²` SKT, where G is the tracked gain (every basis
//!   minted on so far, `Rewards::gain`) and S is `mint_scale`. A settlement's basis B
//!   mints the integral of that rate from G to G + B, `100 · S² · B / ((S + G)(S + G + B))`, and moves G on by B: one
//!   basis of B and two of B/2 mint the same, to the unit.

use anchor_lang::prelude::*;

use crate::error::SkechError;
use crate::events::{HolderAccrued, Minted};
use crate::ladder::CHANCE_ONE;
use crate::state::*;
// Named, not only globbed: the prelude has a `Rewards` too (the sysvar).
use crate::state::Rewards;

/// The holders' part of a fee taken at `fee_bps` on `amount`: `holder_bps` of it, rounded down, never more than the
/// fee (which is rounded up): the house keeps the rounding.
pub fn holder_part(amount: u64, holder_bps: u16, fee_bps: u16) -> u64 {
    let bps = holder_bps.min(fee_bps) as u64;
    // In u64 when it fits, which is always but for stakes past $1.8 trillion: u128 division costs compute.
    match amount.checked_mul(bps) {
        Some(x) => x / BPS,
        None => (amount as u128 * bps as u128 / BPS as u128) as u64,
    }
}

/// What a band that missed counts toward SKT, USDC e6: `stake · [(1 − p·m) + f·p·(m − 1)] / (1 − p)`, rounded down, with
/// `p` the chance in billionths, `m` the rung (x100) and `f` the profit fee (`profit_fee_bps`): the band's expected loss
/// with the profit fee a hit pays, over its chance of missing. Never less than 0 (a band returning more than its stake,
/// which the program no longer offers) nor more than the stake.
pub fn miss_basis(stake: u64, chance_e9: u32, rung_e2: u16, profit_fee_bps: u16) -> u64 {
    let (p, one, r) = (chance_e9 as u128, CHANCE_ONE as u128, rung_e2 as u128);
    if p >= one {
        return 0;
    }
    // In units of 1e-15: 1 = 1e4 · 100 · 1e9; p·m = 1e4 · P · R; f·p·(m − 1) = F · P · (R − 100); 1 − p = 1e6 (1e9 − P).
    // Each under 2^58, and the stake under 2^64: the product fits a u128.
    let bps = BPS as u128;
    let edge = (bps * 100 * one + profit_fee_bps as u128 * p * r.saturating_sub(100)).saturating_sub(bps * p * r);
    let under = bps * 100 * (one - p);
    (stake as u128 * edge / under).min(stake as u128) as u64
}

/// Where the holders' share of a fee goes now.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    /// To the holders, by the accumulator.
    Holders,
    /// To the pool: something is owed as IOU, and is paid first.
    Pool,
    /// To the treasury: there is no SKT to share it.
    Treasury,
}

pub fn route(pool: &Pool, rewards: &Rewards) -> Route {
    if pool.iou_shares > 0 {
        Route::Pool
    } else if rewards.supply == 0 {
        Route::Treasury
    } else {
        Route::Holders
    }
}

impl Rewards {
    /// The holders' share of a stake's fee: money that is in nobody's balance or pool yet.
    pub fn share_stake_fee(&mut self, pool: &mut Pool, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        match route(pool, self) {
            Route::Pool => pool.pool = pool.pool.checked_add(amount).ok_or(SkechError::Overflow)?,
            Route::Treasury => pool.fees = pool.fees.checked_add(amount).ok_or(SkechError::Overflow)?,
            Route::Holders => self.accrue(amount)?,
        }
        Ok(())
    }

    /// The holders' share of a profit's fee. It is in the pool, which pays the hit gross; it leaves the pool only as
    /// far as the pool has it left after the player and the treasury, as the treasury's cut does, and never as a debt.
    /// Owed IOUs, it simply stays there.
    pub fn share_profit_fee(&mut self, pool: &mut Pool, amount: u64) -> Result<()> {
        let taken = amount.min(pool.pool);
        if taken == 0 {
            return Ok(());
        }
        match route(pool, self) {
            Route::Pool => {}
            Route::Treasury => {
                pool.pool -= taken;
                pool.fees = pool.fees.checked_add(taken).ok_or(SkechError::Overflow)?;
            }
            Route::Holders => {
                pool.pool -= taken;
                self.accrue(taken)?;
            }
        }
        Ok(())
    }

    /// Share `amount` among every SKT there is. `acc` is rounded down: what the rounding leaves stays in
    /// `holder_funds`, never anyone's.
    fn accrue(&mut self, amount: u64) -> Result<()> {
        debug_assert!(self.supply > 0);
        // amount ≤ u64::MAX, so amount · 1e18 < 2^128; and every amount ever is ≤ u64::MAX in all, so acc never
        // reaches 2^128 either.
        self.acc = self.acc.checked_add(amount as u128 * ACC_SCALE / self.supply as u128).ok_or(SkechError::Overflow)?;
        self.holder_funds = self.holder_funds.checked_add(amount).ok_or(SkechError::Overflow)?;
        self.accrued_total = self.accrued_total.checked_add(amount).ok_or(SkechError::Overflow)?;
        emit!(HolderAccrued { amount, acc: self.acc, supply: self.supply });
        Ok(())
    }

    /// Mint `holder` SKT on a settlement's `basis`, USDC e6, from the tracked gain on, and move the tracked gain on by it:
    /// the curve's exact integral, whatever is owed. What was minted, SKT e6.
    pub fn mint(&mut self, holder: &mut Holder, basis: u64) -> Result<u64> {
        if basis == 0 {
            return Ok(0);
        }
        let skt = mint_amount(self.config.mint_scale, self.gain, basis);
        let skt = skt.min((u64::MAX - self.supply) as u128) as u64;
        self.gain = self.gain.saturating_add(basis);
        // What the balance earned so far is counted before it changes.
        holder.settle_rewards(self.acc)?;
        holder.skt += skt;
        holder.basis = holder.basis.saturating_add(basis);
        self.supply += skt;
        if skt > 0 {
            let rate = match skt.checked_mul(1_000_000) {
                Some(x) => x / basis,
                None => (skt as u128 * 1_000_000 / basis as u128) as u64,
            };
            emit!(Minted { player: holder.player, skt, rate, basis });
        }
        Ok(skt)
    }
}

impl Holder {
    /// Count what this balance has earned since `acc_at` into `unclaimed`, rounded down.
    pub fn settle_rewards(&mut self, acc: u128) -> Result<()> {
        if acc > self.acc_at && self.skt > 0 {
            let d = acc - self.acc_at;
            let skt = self.skt as u128;
            // skt · d / SCALE without the product overflowing: d = q · SCALE + r.
            let earned = skt
                .checked_mul(d / ACC_SCALE)
                .and_then(|x| x.checked_add(skt * (d % ACC_SCALE) / ACC_SCALE))
                .ok_or(SkechError::Overflow)?;
            self.unclaimed = self.unclaimed.checked_add(u64::try_from(earned).map_err(|_| SkechError::Overflow)?).ok_or(SkechError::Overflow)?;
        }
        self.acc_at = acc;
        Ok(())
    }
}

/// SKT e6 a basis of `basis` mints from tracked gain `from` (both USDC e6): the integral of `100 · S² / (S + g)²` from
/// `from` to `from + basis`, `100 · S² · (1/(S + from) − 1/(S + from + basis))`. The first term is rounded down and the
/// second up: never more than the exact integral, and less by under 2 units; minted in pieces, less than in one go by
/// under a unit a piece.
pub fn mint_amount(scale: u64, from: u64, basis: u64) -> u128 {
    if basis == 0 || scale == 0 {
        return 0;
    }
    let s = scale as u128;
    // S ≤ MAX_MINT_SCALE, so 100 · S² < 2^128; S + from + basis < 2^66.
    let k = SKT_PER_USDC * s * s;
    let (lo, hi) = (s + from as u128, s + from as u128 + basis as u128);
    (k / lo).saturating_sub(k.div_ceil(hi))
}

/// The rate at tracked gain `g`, SKT per dollar times 1e6: for the curve's table, and tests.
pub fn rate_e6(scale: u64, g: u64) -> u128 {
    let (s, g) = (scale as u128, g as u128);
    if s == 0 {
        return 0;
    }
    SKT_PER_USDC * 1_000_000 * s / (s + g) * s / (s + g)
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: u64 = 1_000_000_000_000; // $1,000,000, the default
    const E6: u64 = 1_000_000;

    /// The integral in floating point, in the form that does not cancel: 100 · S² · B / ((S + a)(S + a + B)).
    fn reference(scale: u64, from: u64, basis: u64) -> f64 {
        let (s, a, b) = (scale as f64, from as f64, basis as f64);
        100.0 * (s / (s + a)) * (s / (s + a + b)) * b
    }

    fn rng(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }

    #[test]
    fn the_mint_matches_the_integral_in_floating_point() {
        let cases: &[(u64, u64)] = &[
            (0, E6),
            (0, 1),
            (1_000_000 * E6, E6),
            (10_000_000 * E6, 10_000_000 * E6),
            (0, 100_000_000 * E6),
            // Around $100M of tracked gain, a hundred times the default scale, where the curve has all but run out.
            (100_000_000 * E6, E6),
            (100_000_000 * E6, 1_000_000 * E6),
            (1_000_000_000 * E6, E6),
            (u64::MAX / 2, E6),
            // One enormous settlement: every u64 of basis at once.
            (0, u64::MAX),
            (u64::MAX / 2, u64::MAX / 2),
        ];
        for &(from, basis) in cases {
            let got = mint_amount(S, from, basis) as f64;
            let want = reference(S, from, basis);
            assert!(got <= want * (1.0 + 1e-12) + 1e-6, "{from} + {basis}: {got} over {want}");
            assert!(want - got < 2.0 + 1e-9 * want, "{from} + {basis}: {got} short of {want}");
        }
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        for _ in 0..20_000 {
            let from = rng(&mut seed) % (10_000_000 * E6);
            let basis = rng(&mut seed) % (50_000 * E6);
            let scale = 1 + rng(&mut seed) % (10_000_000 * E6);
            let got = mint_amount(scale, from, basis) as f64;
            let want = reference(scale, from, basis);
            assert!(got <= want * (1.0 + 1e-12) + 1e-6, "{from} + {basis} at {scale}: {got} over {want}");
            assert!(want - got < 2.0 + 1e-9 * want, "{from} + {basis} at {scale}: {got} short of {want}");
        }
    }

    fn skech_max() -> u64 {
        MAX_MINT_SCALE
    }

    #[test]
    fn a_basis_mints_the_same_in_one_go_or_in_pieces() {
        let mut seed = 42u64;
        for _ in 0..2_000 {
            let start = rng(&mut seed) % (2_000_000 * E6);
            let pieces = 1 + rng(&mut seed) % 20;
            let (mut at, mut sum) = (start, 0u128);
            for _ in 0..pieces {
                let b = rng(&mut seed) % (20_000 * E6);
                sum += mint_amount(S, at, b);
                at += b;
            }
            let whole = mint_amount(S, start, at - start);
            assert!(sum <= whole, "pieces {sum} over one go {whole}");
            assert!(whole - sum <= pieces as u128, "pieces {sum}, one go {whole}: more than a unit a piece apart");
        }
    }

    #[test]
    fn the_rate_is_the_table_in_the_docs() {
        // At G = 0, $100k, $500k, $1M, $3M, $10M: 100, 82.6, 44.4, 25, 6.25, 0.83 SKT a dollar.
        let at = |usd: u64| rate_e6(S, usd * E6) as f64 / 1e6;
        for (g, want) in [(0, 100.0), (100_000, 82.64), (500_000, 44.44), (1_000_000, 25.0), (3_000_000, 6.25), (10_000_000, 0.826)] {
            assert!((at(g) - want).abs() < 0.01, "rate at ${g}: {} not {want}", at(g));
        }
        // The first dollar mints all but a millionth of 100 SKT.
        assert_eq!(mint_amount(S, 0, E6), 99_999_900);
        let at_1m = mint_amount(S, 1_000_000 * E6, E6);
        assert!((24_999_900..=25_000_000).contains(&at_1m), "{at_1m}");
        let at_10m = mint_amount(S, 10_000_000 * E6, E6);
        assert!((826_440..=826_447).contains(&at_10m), "{at_10m}");
        // Far past the scale, at $100M: (1/101)² of the rate.
        let at_100m = mint_amount(S, 100_000_000 * E6, E6);
        assert!((9_800..=9_804).contains(&at_100m), "{at_100m}");
        // However much is lost, even every u64 of it in one settlement, the whole curve is worth 100 · S, to everyone
        // together: 100 million SKT at the default, and never an overflow.
        assert!(mint_amount(S, 0, 1_000_000_000 * E6) < 100 * S as u128);
        let all = mint_amount(S, 0, u64::MAX);
        assert!(all < 100 * S as u128 && all > 99 * S as u128, "{all}");
        // At the largest scale the admin may set, too.
        let big = skech_max();
        assert!(mint_amount(big, 0, u64::MAX) <= 100 * big as u128 && mint_amount(big, u64::MAX, u64::MAX) > 0);
    }

    /// `stake · [(1 − p·m) + f·p·(m − 1)] / (1 − p)` in floating point, at least 0 and at most the stake.
    fn basis_reference(stake: u64, chance: u32, rung: u16, fee_bps: u16) -> f64 {
        let (p, m, f) = (chance as f64 / 1e9, rung as f64 / 100.0, fee_bps as f64 / 1e4);
        if p >= 1.0 {
            return 0.0;
        }
        (stake as f64 * ((1.0 - p * m) + f * p * (m - 1.0)).max(0.0) / (1.0 - p)).min(stake as f64)
    }

    #[test]
    fn a_miss_counts_its_odds_weighted_loss_with_the_profit_fee() {
        // A 1% long shot at 96x, 10% profit fee: 1 − 0.96 + 0.1 · 0.01 · 95 = 13.5¢ a dollar expected; it misses 99
        // times in 100, each counting 13.5/0.99.
        assert_eq!(miss_basis(1_000_000, 10_000_000, 9600, 1000), 136_363);
        // With no profit fee, as before: 4¢, counted 4/0.99.
        assert_eq!(miss_basis(1_000_000, 10_000_000, 9600, 0), 40_404);
        // Ink at 50% paying 1.5x: 25¢ + 0.1 · 0.5 · 0.5 = 27.5¢ a dollar expected, counted twice over on the half that misses.
        assert_eq!(miss_basis(1_000_000, 500_000_000, 150, 1000), 550_000);
        // 90% at 1.1x: 1¢ + 0.1 · 0.9 · 0.1 = 1.9¢ a dollar expected, ten times over on the tenth that misses.
        assert_eq!(miss_basis(1_000_000, 900_000_000, 110, 1000), 190_000);
        // Certain: nothing. Paying its fair multiple: only the profit fee it would pay, 0.1 · 0.5 · 1 / 0.5.
        assert_eq!(miss_basis(1_000_000, 1_000_000_000, 100, 1000), 0);
        assert_eq!(miss_basis(1_000_000, 500_000_000, 200, 1000), 100_000);
        assert_eq!(miss_basis(1_000_000, 500_000_000, 200, 0), 0);
        // Returning more than its stake (no longer offered): nothing. No chance at all: the stake.
        assert_eq!(miss_basis(1_000_000, 600_000_000, 200, 0), 0);
        assert_eq!(miss_basis(1_000_000, 0, 9600, 1000), 1_000_000);
        // The most a section stakes (u32::MAX) at the most a fee may be (50%): no overflow, never over the stake.
        assert!(miss_basis(u32::MAX as u64, 1, 12800, 5000) <= u32::MAX as u64);
        assert!(miss_basis(u64::MAX, 999_999_999, 12800, 5000) <= u64::MAX);
        let mut seed = 5u64;
        for _ in 0..100_000 {
            let stake = rng(&mut seed) % 10_000_000_000;
            let chance = (rng(&mut seed) % 1_000_000_001) as u32;
            let rung = 100 + (rng(&mut seed) % 12_701) as u16;
            let fee = (rng(&mut seed) % 5001) as u16;
            let got = miss_basis(stake, chance, rung, fee);
            let want = basis_reference(stake, chance, rung, fee);
            assert!(got as f64 <= want * (1.0 + 1e-12) + 1e-6 && want - (got as f64) < 1.0 + 1e-9 * want, "{stake} at {chance}, {rung}, fee {fee}: {got}, {want}");
            assert!(got <= stake, "never more than the stake");
        }
    }

    #[test]
    fn in_expectation_a_miss_counts_the_bands_expected_loss_whatever_its_odds() {
        // (1 − p) · basis = s · [(1 − p·m) + f·p·(m − 1)], what the band loses on average with the profit fee a hit
        // pays, to within the rounding of one basis, for every chance and rung the ladder offers at 4%.
        let stake = 1_000_000_000u64;
        for fee in [0u16, 1000, 2500] {
            for d in [50u8, 51, 55, 70, 85, 100] {
                for chance in (1..=1000u32).map(|k| k * 1_000_000).chain([1, 999, 7_812_500, 999_999_999]) {
                    let rung = crate::ladder::rung_for(chance, d, false, 0);
                    if rung == 0 || !crate::ladder::within_fee(chance, rung, 400) {
                        continue;
                    }
                    let expected_basis = (CHANCE_ONE - chance) as u128 * miss_basis(stake, chance, rung, fee) as u128;
                    // In 1e-15 of a stake: 1e15 − 1e4·P·R + F·P·(R − 100).
                    let (p, r) = (chance as u128, rung as u128);
                    let edge = 1_000_000_000_000_000u128 + fee as u128 * p * (r - 100) - 10_000 * p * r;
                    let expected_loss = stake as u128 * edge / 1_000_000;
                    assert!(expected_basis <= expected_loss && expected_loss - expected_basis < CHANCE_ONE as u128, "fee {fee}, d {d}, chance {chance}, rung {rung}: {expected_basis} for {expected_loss}");
                }
            }
        }
    }

    #[test]
    fn holder_parts_never_exceed_the_fee() {
        let mut seed = 7u64;
        for _ in 0..50_000 {
            let amount = rng(&mut seed) % 10_000_000_000;
            let fee_bps = (rng(&mut seed) % 2001) as u16;
            let holder_bps = (rng(&mut seed) % 2001) as u16;
            let fee = (amount * fee_bps as u64).div_ceil(BPS);
            assert!(holder_part(amount, holder_bps, fee_bps) <= fee);
        }
        assert_eq!(holder_part(100_000, 300, 400), 3_000);
        assert_eq!(holder_part(25_000, 800, 1000), 2_000);
        // A stake of 49 at 4%: a fee of 2 (1.96 rounded up), 1 of it the holders' (1.47 down).
        assert_eq!(((49u64 * 400).div_ceil(BPS), holder_part(49, 300, 400)), (2, 1));
    }

    fn rewards(supply: u64) -> Rewards {
        Rewards { config: RewardsConfig::DEFAULT, supply, acc: 0, holder_funds: 0, accrued_total: 0, claimed_total: 0, gain: 0, bump: 0, _reserved: [0; 64] }
    }

    #[test]
    fn earnings_never_exceed_what_was_accrued() {
        let mut seed = 99u64;
        for _ in 0..200 {
            let n = 1 + (rng(&mut seed) % 6) as usize;
            let mut holders: Vec<Holder> = (0..n).map(|_| Holder { skt: 1 + rng(&mut seed) % 1_000_000_000_000, ..Default::default() }).collect();
            let mut r = rewards(holders.iter().map(|h| h.skt).sum());
            for _ in 0..50 {
                // A fee, or a holder's balance growing (counted first), at random.
                if rng(&mut seed) % 3 == 0 {
                    let i = (rng(&mut seed) % n as u64) as usize;
                    holders[i].settle_rewards(r.acc).unwrap();
                    let more = rng(&mut seed) % 1_000_000_000;
                    holders[i].skt += more;
                    r.supply += more;
                } else {
                    r.accrue(rng(&mut seed) % 10_000_000_000).unwrap();
                }
            }
            let mut earned = 0u64;
            for h in &mut holders {
                h.settle_rewards(r.acc).unwrap();
                earned += h.unclaimed;
            }
            assert!(earned <= r.accrued_total, "{earned} paid of {} accrued", r.accrued_total);
            // And the dust left over is small: under a unit for each holder and each fee.
            assert!(r.accrued_total - earned <= 50 * n as u64 + 50, "{} left unpaid", r.accrued_total - earned);
        }
    }
}
