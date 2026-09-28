//! A second opinion on every Coinbase trade before it is signed.
//!
//! Coinbase is the price: it is what the game's chances were measured on, and
//! it is fast. Binance and Kraken attest to it. Each keeps its newest trade
//! here; when a Coinbase trade lands, it is signed as is if the attesters'
//! median is within the band of it. If not, the median is signed instead, so
//! one venue printing a bad trade cannot put that trade on chain. With no
//! attester heard from lately, nothing is signed at all.

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// An attester's price older than this no longer counts.
const FRESH: Duration = Duration::from_secs(5);

#[derive(Clone, Default)]
pub struct Board(Arc<Mutex<BTreeMap<&'static str, (f64, Instant)>>>);

impl Board {
    pub fn set(&self, name: &'static str, price: f64) {
        if price.is_finite() && price > 0.0 {
            self.0.lock().unwrap().insert(name, (price, Instant::now()));
        }
    }

    /// Each attester heard from in the last few seconds, and its newest price.
    pub fn fresh(&self) -> Vec<(&'static str, f64)> {
        self.0.lock().unwrap().iter().filter(|(_, (_, at))| at.elapsed() <= FRESH).map(|(name, (p, _))| (*name, *p)).collect()
    }
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// The attesters agree with Coinbase: sign Coinbase's price.
    Agrees,
    /// They don't: sign their median instead, to the cent.
    Differs { median: f64 },
    /// No attester to check against: sign nothing.
    Alone,
}

/// `band` is a fraction: 0.0005 is 0.05%.
pub fn decide(coinbase: f64, attesters: &[f64], band: f64) -> Verdict {
    if attesters.is_empty() {
        return Verdict::Alone;
    }
    let mut sorted = attesters.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    let median = if sorted.len() % 2 == 1 { sorted[mid] } else { (sorted[mid - 1] + sorted[mid]) / 2.0 };
    if ((coinbase - median) / median).abs() <= band {
        Verdict::Agrees
    } else {
        Verdict::Differs { median: (median * 100.0).round() / 100.0 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BAND: f64 = 0.0005;

    #[test]
    fn within_the_band_coinbase_stands() {
        assert_eq!(decide(83_433.33, &[83_430.00], BAND), Verdict::Agrees);
        assert_eq!(decide(83_433.33, &[83_470.00, 83_401.10], BAND), Verdict::Agrees);
    }

    #[test]
    fn outside_it_the_median_is_signed() {
        // 0.1% off: a bad print on Coinbase.
        assert_eq!(decide(83_516.76, &[83_430.004], BAND), Verdict::Differs { median: 83_430.0 });
        assert_eq!(decide(84_000.0, &[83_430.0, 83_440.0, 90_000.0], BAND), Verdict::Differs { median: 83_440.0 });
    }

    #[test]
    fn one_bad_attester_is_outvoted() {
        assert_eq!(decide(83_433.33, &[83_430.0, 83_436.0, 70_000.0], BAND), Verdict::Agrees);
    }

    #[test]
    fn no_attester_no_signature() {
        assert_eq!(decide(83_433.33, &[], BAND), Verdict::Alone);
    }

    #[test]
    fn stale_prices_drop_off_the_board() {
        let board = Board::default();
        board.set("binance", 83_430.0);
        board.set("kraken", f64::NAN);
        assert_eq!(board.fresh(), vec![("binance", 83_430.0)]);
        board.0.lock().unwrap().get_mut("binance").unwrap().1 -= FRESH + Duration::from_millis(1);
        assert!(board.fresh().is_empty());
    }
}
