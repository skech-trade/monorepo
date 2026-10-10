//! SKT: what losing earns back. A player who goes past their deepest net loss so far mints SKT on the difference;
//! SKT never moves and is always staked, and every SKT earns an equal part of the holders' share of the fees.
//!
//! - **The fees.** Of the stake fee, `holder_fee_bps` (3 of 4 points) is the holders'; of the profit fee,
//!   `holder_profit_fee_bps` (8 of 10). The house keeps the rest and every rounding. While anything is owed as IOU
//!   the holders' share goes to the pool, to pay it off; while no SKT exists, to the treasury.
//! - **The accumulator.** Each share raises `acc` by `share · ACC_SCALE / supply`, rounded down. A holder's earnings
//!   are `skt · (acc − acc_at) / ACC_SCALE`, rounded down, counted into `unclaimed` before their balance changes and
//!   before a claim. So no holder is ever paid more than their part of what was accrued.
//! - **The mint.** A player's net result is what settling credited them (paid, and owed at face) less the stakes it
//!   decided; a band given back counts on neither side, and fees are part of the loss. SKT mints only when the net
//!   loss goes past its deepest so far (`worst`), on the difference: a win never takes SKT back, and a loss mints
//!   nothing until it is past the old low. So a player mints at most 100 SKT for every dollar of the deepest net loss
//!   they were ever at, however they got there.
//! - **The curve.** The rate is `100 · (S / (S + G))²` SKT a dollar, where G is the tracked gain (every player's net
//!   loss added up, `Rewards::gain`; 0 while it is negative or anything is owed as IOU) and S is `mint_scale`. What
//!   a new low of L mints is the integral of that rate across the stretch of G it moves through, so one loss of L
//!   and two of L/2 mint the same, to the unit.

use anchor_lang::prelude::*;

use crate::error::SkechError;
use crate::events::{HolderAccrued, Minted};
use crate::state::*;
// Named, not only globbed: the prelude has a `Rewards` too (the sysvar).
use crate::state::Rewards;

/// The holders' part of a fee taken at `fee_bps` on `amount`: `holder_bps` of it, rounded down, never more than the
/// fee (which is rounded up): the house keeps the rounding.
pub fn holder_part(amount: u64, holder_bps: u16, fee_bps: u16) -> u64 {
    (amount as u128 * holder_bps.min(fee_bps) as u128 / BPS as u128) as u64
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

    /// Record a settlement's effect on `holder`'s net result: `staked` decided (bands given back not among it) and
    /// `credited` paid and owed for its hits. Mints on a new low; what was minted, SKT e6. `ious` is whether anything
    /// was owed as IOU before the settlement.
    pub fn record(&mut self, holder: &mut Holder, staked: u64, credited: u64, ious: bool) -> Result<u64> {
        let delta = credited as i128 - staked as i128;
        if delta == 0 {
            return Ok(0);
        }
        let before = self.gain as i128;
        let net = holder.net as i128 + delta;
        holder.net = i64::try_from(net).map_err(|_| SkechError::Overflow)?;
        self.gain = i64::try_from(before - delta).map_err(|_| SkechError::Overflow)?;
        let low = (-net).max(0) as u64;
        if low <= holder.worst {
            return Ok(0);
        }
        // A new low: `low − worst` of it is new. That is the last stretch of this settlement's loss, `-delta`, which
        // moved the tracked gain from `before` to `before − delta`; so the new loss is integrated over the end of it.
        let new = (low - holder.worst) as i128;
        holder.worst = low;
        let end = if ious { 0 } else { before } - delta;
        let skt = mint_amount(self.config.mint_scale, end - new, end);
        let skt = skt.min((u64::MAX - self.supply) as u128) as u64;
        // What the balance earned so far is counted before it changes.
        holder.settle_rewards(self.acc)?;
        holder.skt += skt;
        self.supply += skt;
        if skt > 0 {
            emit!(Minted { player: holder.player, skt, rate: (skt as u128 * 1_000_000 / new as u128) as u64, net_loss_new_low: low });
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

/// SKT e6 a new net loss mints: the integral of the rate across the tracked gain from `a` to `b` (USDC e6, b − a the
/// loss). The rate is 100 a unit where the gain is 0 or less, and `100 · S² / (S + g)²` above it, whose integral from
/// `lo` to `hi` is `100 · S² · (1/(S+lo) − 1/(S+hi))`. The first term is rounded down and the second up: never more
/// than the exact integral, and less by under 2 units; minted in pieces, under 1 unit a piece less than in one go.
pub fn mint_amount(scale: u64, a: i128, b: i128) -> u128 {
    if b <= a {
        return 0;
    }
    // Below a gain of 0, the full rate.
    let mut out = if a < 0 { (b.min(0) - a) as u128 * SKT_PER_USDC } else { 0 };
    let (lo, hi) = (a.max(0) as u128, b.max(0) as u128);
    if hi > lo && scale > 0 {
        let s = scale as u128;
        // S ≤ MAX_MINT_SCALE, so 100 · S² < 2^128.
        let k = SKT_PER_USDC * s * s;
        out += (k / s.saturating_add(lo)).saturating_sub(k.div_ceil(s.saturating_add(hi)));
    }
    out
}

/// The rate at tracked gain `g`, SKT per dollar times 1e6: for the curve's table, and tests.
pub fn rate_e6(scale: u64, g: i128) -> u128 {
    let (s, g) = (scale as u128, g.max(0) as u128);
    if s == 0 {
        return 0;
    }
    SKT_PER_USDC * 1_000_000 * s / (s + g) * s / (s + g)
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: u64 = 100_000_000_000; // $100,000
    const E6: i128 = 1_000_000;

    /// The integral in floating point.
    fn reference(scale: u64, a: i128, b: i128) -> f64 {
        let s = scale as f64;
        let flat = if a < 0 { (b.min(0) - a) as f64 * 100.0 } else { 0.0 };
        let (lo, hi) = (a.max(0) as f64, b.max(0) as f64);
        flat + if hi > lo { 100.0 * s * s * (1.0 / (s + lo) - 1.0 / (s + hi)) } else { 0.0 }
    }

    fn rng(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }

    #[test]
    fn the_mint_matches_the_integral_in_floating_point() {
        let cases: &[(i128, i128)] = &[
            (0, E6),
            (0, 1),
            (-5 * E6, 5 * E6),
            (-10 * E6, -E6),
            (10_000 * E6, 10_001 * E6),
            (100_000 * E6, 200_000 * E6),
            (0, 1_000_000 * E6),
            (1_000_000 * E6, 1_000_000 * E6 + 1),
            (1_000_000_000 * E6, 1_000_000_001 * E6),
            (i64::MAX as i128 - E6, i64::MAX as i128),
        ];
        for &(a, b) in cases {
            let got = mint_amount(S, a, b) as f64;
            let want = reference(S, a, b);
            assert!(got <= want + 1e-6 * want.max(1.0), "[{a}, {b}]: {got} over {want}");
            assert!(want - got < 2.0 + 1e-9 * want, "[{a}, {b}]: {got} short of {want}");
        }
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        for _ in 0..20_000 {
            let a = (rng(&mut seed) % (10_000_000 * E6 as u64)) as i128 - 1_000 * E6;
            let b = a + (rng(&mut seed) % (50_000 * E6 as u64)) as i128;
            let scale = 1 + rng(&mut seed) % (10_000_000 * E6 as u64);
            let got = mint_amount(scale, a, b) as f64;
            let want = reference(scale, a, b);
            assert!(got <= want * (1.0 + 1e-12) + 1e-6, "[{a}, {b}] at {scale}: {got} over {want}");
            assert!(want - got < 2.0 + 1e-9 * want, "[{a}, {b}] at {scale}: {got} short of {want}");
        }
    }

    #[test]
    fn a_loss_mints_the_same_in_one_go_or_in_pieces() {
        let mut seed = 42u64;
        for _ in 0..2_000 {
            let start = (rng(&mut seed) % (2_000_000 * E6 as u64)) as i128 - 50_000 * E6;
            let pieces = 1 + rng(&mut seed) % 20;
            let mut at = start;
            let mut sum = 0u128;
            for _ in 0..pieces {
                let l = (rng(&mut seed) % (20_000 * E6 as u64)) as i128;
                sum += mint_amount(S, at, at + l);
                at += l;
            }
            let whole = mint_amount(S, start, at);
            assert!(sum <= whole, "pieces {sum} over one go {whole}");
            assert!(whole - sum <= pieces as u128, "pieces {sum}, one go {whole}: more than a unit a piece apart");
        }
    }

    #[test]
    fn the_rate_is_the_table_in_the_docs() {
        // At G = 0, $10k, $50k, $100k, $300k, $1M: 100, 82.6, 44.4, 25, 6.25, 0.83 SKT a dollar.
        let at = |usd: i128| rate_e6(S, usd * E6) as f64 / 1e6;
        for (g, want) in [(0, 100.0), (10_000, 82.64), (50_000, 44.44), (100_000, 25.0), (300_000, 6.25), (1_000_000, 0.826)] {
            assert!((at(g) - want).abs() < 0.01, "rate at ${g}: {} not {want}", at(g));
        }
        // A dollar lost at G mints about the rate at G.
        // The first dollar mints 99.999 SKT: averaged across it, the rate is a hundred-thousandth under 100.
        assert_eq!(mint_amount(S, 0, E6), 99_999_000);
        assert_eq!(mint_amount(S, -E6, 0), 100 * E6 as u128);
        let at_100k = mint_amount(S, 100_000 * E6, 100_001 * E6);
        assert!((24_999_000..=25_000_000).contains(&at_100k), "{at_100k}");
        // Most a loss can mint is 100 a unit: never more, whatever the gain.
        assert!(mint_amount(S, 0, 1_000_000_000 * E6) < 100 * S as u128);
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
                // A fee, or a holder's balance changing (counted first), at random.
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
