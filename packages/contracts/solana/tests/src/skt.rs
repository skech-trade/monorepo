//! SKT on chain: the fee split, the accumulator across holders who join at different times, claims, IOUs first, the
//! high-water mark, the curve, refunds, and that a long shot mints no more SKT per dollar lost than ink at the price.
//! Then the whole game at random, its books checked after every step.

use std::collections::HashMap;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AnchorDeserialize, Discriminator};
use base64::Engine;
use litesvm::types::TransactionMetadata;
use solana_signer::Signer;

use crate::harness::*;
use skech::error::SkechError;
use skech::piece::QuoteArgs;
use skech::skt::mint_amount;
use skech::state::{RewardsConfig, ACC_SCALE};

const PRICE: u64 = 83_000 * E8;
/// The band at the price ($83,000 on the $0.20 grid), and one $1,000 above it.
const AT: u32 = 415_000;
const FAR: u32 = AT + 5000;
/// Where a bar sits to hit only the band at the price, only the far one, or neither.
const HIT_AT: u64 = PRICE;
const HIT_FAR: u64 = 84_000 * E8 + 40_000_000;
const MISS: u64 = 82_000 * E8;
const HALF: u32 = 500_000_000;
const LONG: u32 = 10_000_000;

/// The program's events of one kind in a transaction's logs.
fn events<E: AnchorDeserialize + Discriminator>(logs: &[String]) -> Vec<E> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
        .filter(|b| b.starts_with(E::DISCRIMINATOR))
        .map(|b| E::deserialize(&mut &b[8..]).unwrap())
        .collect()
}

/// A band: (lo in grid units, stake e6, chance e9).
type Band = (u32, u32, u32);

fn key(p: &Player) -> Pubkey {
    p.wallet.pubkey()
}

/// Rounds of play: a fresh second to open on, pieces placed in it, one bar for its first second, everything settled.
struct Table {
    g: Game,
    drawing: u64,
}

impl Table {
    fn new(g: Game) -> Table {
        Table { g, drawing: 0 }
    }

    /// The next second to open on, ten seconds on, with the clock there.
    fn open(&mut self) -> i64 {
        let t = self.g.now + 10;
        self.g.set_time(t);
        (t + 1) * 1000
    }

    /// Place `bands` for `p`, all in the piece's first second. The bet, if it went in.
    fn place(&mut self, p: &Player, open_at: i64, bands: &[Band]) -> Option<Pubkey> {
        self.drawing += 1;
        let sections: Vec<(u8, u32, u16, u32)> = bands.iter().map(|&(lo, stake, _)| (1, lo, 5, stake)).collect();
        let piece = self.g.piece(p, self.drawing, 0, open_at, &sections);
        let quote = QuoteArgs { price: PRICE, momentum: 0, received_at: open_at - 300, chances: bands.iter().map(|b| b.2).collect() };
        self.g.place(p, &piece, &quote).ok().map(|_| bet_pda(&key(p), self.drawing, 0).0)
    }

    /// Post the bar at `price` for the round's first second and settle `bets` on it, past their placing window: six
    /// to a transaction. Every transaction's logs.
    fn settle(&mut self, open_at: i64, price: u64, bets: &[(Pubkey, Pubkey)]) -> TransactionMetadata {
        self.g.set_time(open_at / 1000 + 4);
        let mut out = self.g.post_and_settle(open_at + 1000, price, price, price, price, &bets[..bets.len().min(6)]).unwrap_or_else(|f| panic!("settle: {:?} {:?}", f.err, f.meta.logs));
        for chunk in bets.chunks(6).skip(1) {
            let m = self.g.settle_on(false, chunk).unwrap_or_else(|f| panic!("settle: {:?} {:?}", f.err, f.meta.logs));
            out.logs.extend(m.logs);
        }
        out
    }

    /// One player, one piece, one bar.
    fn play(&mut self, p: &Player, bands: &[Band], price: u64) -> TransactionMetadata {
        let open_at = self.open();
        let bet = self.place(p, open_at, bands).expect("placed");
        self.settle(open_at, price, &[(bet, key(p))])
    }

    fn claim(&mut self, p: &Player) -> u64 {
        let before = self.g.player_state(p).balance;
        let w = p.wallet.insecure_clone();
        self.g.send(&[self.g.claim_ix(p)], &[&w]).unwrap_or_else(|f| panic!("claim: {:?} {:?}", f.err, f.meta.logs));
        self.g.player_state(p).balance - before
    }

    /// What `wallet`'s SKT has earned and not been paid, as a claim would count it now.
    fn claimable(&self, wallet: &Pubkey) -> u64 {
        let (h, acc) = (self.g.holder(wallet), self.g.rewards().acc);
        h.unclaimed + if acc > h.acc_at { (h.skt as u128 * (acc - h.acc_at) / ACC_SCALE) as u64 } else { 0 }
    }

    fn set_rewards(&mut self, r: RewardsConfig) {
        let admin = self.g.admin.insecure_clone();
        self.g.send(&[self.g.set_rewards_config_ix(r)], &[&admin]).expect("rewards config");
    }

    fn redeem_ix(&self, holder: &Pubkey, caller: Pubkey) -> anchor_lang::solana_program::instruction::Instruction {
        self.g.ix(
            skech::accounts::Redeem { caller, game: game_pda(), pool: pool_pda(), holder: player_pda(holder), caller_player: None, system_program: anchor_lang::system_program::ID },
            skech::instruction::Redeem { shares: u128::MAX },
        )
    }

    /// vault == balances + pool + the treasury's uncollected fees + what is set aside for holders.
    fn books_balance(&self, players: &[&Player]) {
        let (pool, rewards) = (self.g.pool(), self.g.rewards());
        let balances: u64 = players.iter().map(|p| self.g.player_state(p).balance).sum();
        assert_eq!(token_balance(&self.g.svm, &self.g.vault()), balances + pool.pool + pool.fees + rewards.holder_funds, "every USDC accounted for");
    }
}

#[test]
fn the_stake_fee_splits_3_and_1_and_the_profit_fee_8_and_2() {
    let mut t = Table::new(Game::new());
    let (a, b) = (t.g.player(10 * E6, 5 * E6), t.g.player(30 * E6, 25 * E6));
    // No SKT yet: the holders' 3 points of B's fee go to the treasury with the house's 1.
    let open_at = t.open();
    let bet = t.place(&b, open_at, &[(FAR, 1_000_000, HALF)]).unwrap();
    assert_eq!((t.g.pool().fees, t.g.rewards().holder_funds), (40_000, 0));
    t.settle(open_at, HIT_AT, &[(bet, key(&b))]);
    assert!(t.g.rewards().supply > 0, "B's dollar lost minted SKT");

    // A's nickel: a 0.2¢ fee, 0.15¢ of it the holders' and 0.05¢ the treasury's.
    let (fees, pool) = (t.g.pool().fees, t.g.pool().pool);
    let open_at = t.open();
    let bet = t.place(&a, open_at, &[(AT, 50_000, HALF)]).unwrap();
    assert_eq!(t.g.pool().fees - fees, 500);
    assert_eq!(t.g.rewards().holder_funds, 1_500);
    assert_eq!(t.g.pool().pool - pool, 48_000);
    // It hits at 1.5x: a 2.5¢ profit, its 0.25¢ fee 0.2¢ the holders' and 0.05¢ the treasury's; the pool pays 7.5¢.
    let m = t.settle(open_at, HIT_AT, &[(bet, key(&a))]);
    assert_eq!(t.g.pool().fees - fees, 1_000);
    assert_eq!(t.g.rewards().holder_funds, 3_500);
    assert_eq!(t.g.pool().pool, pool + 48_000 - 75_000);
    let accrued: Vec<skech::events::HolderAccrued> = events(&m.logs);
    assert_eq!(accrued.iter().map(|e| e.amount).collect::<Vec<_>>(), vec![2_000]);
    t.books_balance(&[&a, &b]);
    // B holds all the SKT: a claim pays B all of it but the accumulator's rounding, and a second pays nothing.
    let paid = t.claim(&b);
    assert!((3_498..=3_500).contains(&paid), "{paid}");
    assert_eq!(t.claim(&b), 0);
    // A never lost: no SKT, and its holder (opened by its settlement) has nothing to claim.
    assert_eq!(t.claim(&a), 0);
    t.books_balance(&[&a, &b]);
}

/// Every holder's fair part of every share, exactly (times 1e18), from the SKT each held when it came: observed around
/// each transaction, which here holds one bet, so a share is never split by a mint in the same transaction.
struct Fair {
    wallets: Vec<Pubkey>,
    owed: Vec<u128>,
    shares: u64,
}

impl Fair {
    fn around<T>(&mut self, t: &mut Table, f: impl FnOnce(&mut Table) -> T) -> T {
        let skt: Vec<u64> = self.wallets.iter().map(|w| t.g.holder(w).skt).collect();
        let (supply, before) = (t.g.rewards().supply, t.g.rewards().accrued_total);
        let out = f(t);
        let share = (t.g.rewards().accrued_total - before) as u128;
        if share > 0 {
            self.shares += 1;
            for (i, s) in skt.iter().enumerate() {
                self.owed[i] += share * *s as u128 * ACC_SCALE / supply as u128;
            }
        }
        out
    }

    fn play(&mut self, t: &mut Table, p: &Player, bands: &[Band], price: u64) {
        let open_at = t.open();
        let bet = self.around(t, |t| t.place(p, open_at, bands)).expect("placed");
        self.around(t, |t| t.settle(open_at, price, &[(bet, key(p))]));
    }
}

#[test]
fn holders_who_join_at_different_times_earn_their_part_of_every_share_and_no_more() {
    let mut t = Table::new(Game::new());
    let payer = t.g.player(100 * E6, 100 * E6);
    let hs: Vec<Player> = (0..3).map(|_| t.g.player(50 * E6, 50 * E6)).collect();
    let mut fair = Fair { wallets: hs.iter().map(key).chain([key(&payer)]).collect(), owed: vec![0; 4], shares: 0 };
    let mut claimed = [0u64; 3];
    // SKT is always staked and never moves: a holder joins by losing, and its balance only grows. Holder 0 joins; the
    // payer's fees come; holder 1 joins; more; holder 0 claims and holder 2 joins; holder 0 loses again; more.
    fair.play(&mut t, &hs[0], &[(FAR, 2_000_000, HALF)], HIT_AT);
    for _ in 0..3 {
        fair.play(&mut t, &payer, &[(AT, 300_000, HALF)], HIT_AT);
    }
    fair.play(&mut t, &hs[1], &[(FAR, 5_000_000, HALF)], HIT_AT);
    for _ in 0..3 {
        fair.play(&mut t, &payer, &[(AT, 200_000, HALF), (AT, 50_000, HALF)], HIT_AT);
    }
    claimed[0] += t.claim(&hs[0]);
    fair.play(&mut t, &hs[2], &[(FAR, 1_000_000, HALF)], HIT_AT);
    fair.play(&mut t, &hs[0], &[(FAR, 3_000_000, HALF)], HIT_AT);
    for _ in 0..4 {
        fair.play(&mut t, &payer, &[(AT, 500_000, HALF)], HIT_AT);
    }
    for (i, h) in hs.iter().enumerate() {
        claimed[i] += t.claim(h);
        assert_eq!(t.claim(h), 0, "holder {i}: a second claim pays nothing");
    }
    for i in 0..3 {
        let owed = (fair.owed[i] / ACC_SCALE) as u64;
        // Never more than its part; less by the rounding only, a unit or so for each share and each count.
        assert!(claimed[i] <= owed, "holder {i}: claimed {} of its {owed}", claimed[i]);
        assert!(owed - claimed[i] <= 2 * fair.shares, "holder {i}: claimed {} of its {owed}", claimed[i]);
        assert!(claimed[i] > 0);
    }
    // The payer never lost, so never held any.
    assert_eq!(t.g.holder(&key(&payer)).skt, 0);
    let r = t.g.rewards();
    assert_eq!(r.claimed_total, claimed.iter().sum::<u64>());
    assert_eq!(r.holder_funds, r.accrued_total - r.claimed_total);
    assert!(r.holder_funds <= 6 * fair.shares, "only the rounding is left: {}", r.holder_funds);
    let all: Vec<&Player> = hs.iter().chain([&payer]).collect();
    t.books_balance(&all);
}

#[test]
fn with_no_skt_the_holders_share_goes_to_the_treasury() {
    let mut t = Table::new(Game::new());
    let (a, funder) = (t.g.player(10 * E6, 5 * E6), t.g.player(30 * E6, 25 * E6));
    let open_at = t.open();
    let lose = t.place(&funder, open_at, &[(FAR, 1_000_000, HALF)]).unwrap();
    let win = t.place(&a, open_at, &[(AT, 100_000, HALF)]).unwrap();
    // Settled together, A's hit first, while there is still no SKT: every fee is the treasury's, the profit's too.
    t.settle(open_at, HIT_AT, &[(win, key(&a)), (lose, key(&funder))]);
    assert_eq!(t.g.rewards().accrued_total, 0);
    assert_eq!(t.g.pool().fees, 40_000 + 4_000 + 5_000, "4% of both stakes and 10% of A's 5¢ profit");
    assert!(t.g.rewards().supply > 0, "the funder's loss minted, after");
    t.books_balance(&[&a, &funder]);
}

#[test]
fn while_anything_is_owed_the_holders_share_pays_it_off_instead() {
    let mut t = Table::new(Game::new());
    let (a, b, c) = (t.g.player(10 * E6, 5 * E6), t.g.player(30 * E6, 25 * E6), t.g.player(30 * E6, 25 * E6));
    t.play(&b, &[(FAR, 100_000, HALF)], HIT_AT);
    assert!(t.g.rewards().supply > 0);
    // A's 1% shot at 96x pays far more than the pool has: owed.
    t.play(&a, &[(AT, 50_000, LONG)], HIT_AT);
    assert!(t.g.pool().iou_shares > 0);
    let accrued = t.g.rewards().accrued_total;
    // C's dollar: 4¢ of fee, the holders' 3¢ to the pool, not to B's SKT.
    let (pool, fees) = (t.g.pool().pool, t.g.pool().fees);
    let open_at = t.open();
    let bet = t.place(&c, open_at, &[(FAR, 1_000_000, HALF)]).unwrap();
    assert_eq!(t.g.pool().pool - pool, 960_000 + 30_000);
    assert_eq!(t.g.pool().fees - fees, 10_000);
    assert_eq!(t.g.rewards().accrued_total, accrued, "nothing accrued");
    t.settle(open_at, HIT_AT, &[(bet, key(&c))]);
    // C's own hit while owed: its profit fee's holder share stays in the pool too.
    let (pool, fees) = (t.g.pool().pool, t.g.pool().fees);
    let m = t.play(&c, &[(AT, 100_000, HALF)], HIT_AT);
    let s: Vec<skech::events::Settled> = events(&m.logs);
    assert_eq!(s[0].paid, 145_000);
    assert_eq!(t.g.pool().fees - fees, 1_000 + 1_000, "the treasury's 1 of 4 and 2 of 10 only");
    assert_eq!(t.g.pool().pool, pool + 96_000 + 3_000 - 145_000 - 1_000, "the pool keeps the holders' 3 of 4 points and 8 of 10");
    assert_eq!(t.g.rewards().accrued_total, accrued, "still nothing accrued");
    // Paid off, the holders' share accrues again.
    let top_up = t.g.player(1000 * E6, 1000 * E6);
    t.play(&top_up, &[(FAR, 15_000_000, HALF)], HIT_AT);
    t.g.send(&[t.redeem_ix(&key(&a), t.g.relayer.pubkey())], &[]).expect("redeemed");
    assert_eq!(t.g.pool().iou_shares, 0);
    let before = t.g.rewards().accrued_total;
    t.play(&c, &[(FAR, 100_000, HALF)], HIT_AT);
    assert_eq!(t.g.rewards().accrued_total - before, 3_000);
    t.books_balance(&[&a, &b, &c, &top_up]);
}

#[test]
fn only_a_new_low_mints_and_only_past_the_old_one() {
    let mut t = Table::new(Game::new());
    let a = t.g.player(10 * E6, 10 * E6);
    let funder = t.g.player(30 * E6, 25 * E6);
    t.play(&funder, &[(FAR, 5_000_000, HALF)], HIT_AT);
    let skt = |t: &Table| t.g.holder(&key(&a)).skt;
    // A loss: mints.
    let m = t.play(&a, &[(FAR, 100_000, HALF)], HIT_AT);
    let minted: Vec<skech::events::Minted> = events(&m.logs);
    assert_eq!(minted.len(), 1);
    assert_eq!((minted[0].player, minted[0].skt, minted[0].net_loss_new_low), (key(&a), skt(&t), 100_000));
    let first = skt(&t);
    assert!(first > 0);
    // A win: takes nothing back, mints nothing. Net −100,000 − 100,000 + 145,000.
    let m = t.play(&a, &[(AT, 100_000, HALF)], HIT_AT);
    assert!(events::<skech::events::Minted>(&m.logs).is_empty());
    assert_eq!((skt(&t), t.g.holder(&key(&a)).net), (first, -55_000));
    // Back to the old low exactly: nothing.
    let m = t.play(&a, &[(FAR, 45_000, HALF)], HIT_AT);
    assert!(events::<skech::events::Minted>(&m.logs).is_empty());
    assert_eq!((skt(&t), t.g.holder(&key(&a)).net, t.g.holder(&key(&a)).worst), (first, -100_000, 100_000));
    // Past it by 30,000: the 30,000 mints, and only it.
    let g0 = t.g.rewards().gain as i128;
    let m = t.play(&a, &[(FAR, 30_000, HALF)], HIT_AT);
    let minted: Vec<skech::events::Minted> = events(&m.logs);
    let want = mint_amount(RewardsConfig::DEFAULT.mint_scale, g0, g0 + 30_000) as u64;
    assert_eq!((minted[0].skt, minted[0].net_loss_new_low), (want, 130_000));
    assert_eq!(skt(&t), first + want);
    // At most 100 SKT a dollar of the deepest net loss, ever.
    assert!(skt(&t) as u128 <= 100 * 130_000);
}

#[test]
fn the_curve_decays_as_the_tracked_gain_grows() {
    let mut t = Table::new(Game::new());
    // S = $1, so a few dollars of loss walk the whole curve.
    t.set_rewards(RewardsConfig { mint_scale: E6, ..RewardsConfig::DEFAULT });
    let (funder, x) = (t.g.player(50 * E6, 50 * E6), t.g.player(10 * E6, 10 * E6));
    let cent = |t: &mut Table| -> skech::events::Minted {
        let m = t.play(&x, &[(FAR, 10_000, HALF)], HIT_AT);
        events::<skech::events::Minted>(&m.logs).remove(0)
    };
    // G = 0: 100 a dollar.
    let at0 = cent(&mut t);
    assert_eq!(at0.skt as u128, mint_amount(E6, 0, 10_000));
    assert!((99_000_000..=100_000_000).contains(&at0.rate), "{}", at0.rate);
    // G = S: (1/2)² of it, 25 a dollar.
    t.play(&funder, &[(FAR, 990_000, HALF)], HIT_AT);
    assert_eq!(t.g.rewards().gain, 1_000_000);
    let at_s = cent(&mut t);
    assert_eq!(at_s.skt as u128, mint_amount(E6, 1_000_000, 1_010_000));
    assert!((24_500_000..=25_000_000).contains(&at_s.rate), "{}", at_s.rate);
    // G = 3S: (1/4)², 6.25 a dollar.
    t.play(&funder, &[(FAR, 1_990_000, HALF)], HIT_AT);
    assert_eq!(t.g.rewards().gain, 3_000_000);
    let at_3s = cent(&mut t);
    assert_eq!(at_3s.skt as u128, mint_amount(E6, 3_000_000, 3_010_000));
    assert!((6_200_000..=6_250_000).contains(&at_3s.rate), "{}", at_3s.rate);
    // However much more is lost, by anyone, the whole curve is worth 100 · S: 100 SKT here, to everyone together.
    t.play(&funder, &[(FAR, 15_000_000, HALF)], HIT_AT);
    assert!(t.g.rewards().supply <= 100 * E6, "{}", t.g.rewards().supply);
}

#[test]
fn a_win_owed_as_iou_counts_at_face_so_losses_into_it_mint_nothing() {
    let mut t = Table::new(Game::new());
    let (a, b) = (t.g.player(10 * E6, 10 * E6), t.g.player(30 * E6, 25 * E6));
    t.play(&b, &[(FAR, 100_000, HALF)], HIT_AT);
    // A's long shot: paid what the pool has, the rest owed. Credited in full: no SKT for the stake it took.
    let m = t.play(&a, &[(AT, 50_000, LONG)], HIT_AT);
    let s: Vec<skech::events::Settled> = events(&m.logs);
    assert!(s[0].owed > 0);
    let h = t.g.holder(&key(&a));
    assert_eq!((h.skt, h.net), (0, (s[0].paid + s[0].owed) as i64 - 50_000));
    // Losses that only eat into what A is owed, its net still up: nothing.
    for _ in 0..5 {
        t.play(&a, &[(FAR, 200_000, HALF)], HIT_AT);
    }
    let h = t.g.holder(&key(&a));
    assert!(h.net > 0);
    assert_eq!((h.skt, h.worst), (0, 0));
    // The IOU paid off a day later, growth and all: no change to A's SKT either way.
    let top_up = t.g.player(1000 * E6, 1000 * E6);
    t.play(&top_up, &[(FAR, 15_000_000, HALF)], HIT_AT);
    t.g.set_time(t.g.now + 86_400);
    let w = a.wallet.insecure_clone();
    t.g.send(&[t.redeem_ix(&key(&a), key(&a))], &[&w]).expect("redeemed");
    assert_eq!(t.g.player_state(&a).iou_shares, 0);
    assert_eq!(t.g.holder(&key(&a)), h);
}

#[test]
fn stakes_given_back_mint_nothing() {
    let mut t = Table::new(Game::new());
    let a = t.g.player(10 * E6, 10 * E6);
    // Two bands, seconds 1 and 2; second 1 misses, second 2 is never posted and is given back by expire.
    let open_at = t.open();
    t.drawing += 1;
    let piece = t.g.piece(&a, t.drawing, 0, open_at, &[(1, FAR, 5, 70_000), (2, FAR, 5, 30_000)]);
    let quote = QuoteArgs { price: PRICE, momentum: 0, received_at: open_at - 300, chances: vec![HALF, HALF] };
    t.g.place(&a, &piece, &quote).unwrap();
    let bet = bet_pda(&key(&a), t.drawing, 0).0;
    t.g.set_time(t.g.now + 3);
    t.g.post_and_settle(open_at + 1000, MISS, MISS, MISS, MISS, &[]).unwrap();
    t.g.set_time((open_at + 3000) / 1000 + skech::state::BAR_LATE + 1);
    let m = t.g.settle_on(true, &[(bet, key(&a))]).unwrap();
    let s: Vec<skech::events::Settled> = events(&m.logs);
    assert_eq!((s[0].miss_mask, s[0].expired_mask, s[0].refunded), (0b01, 0b10, 30_000));
    let h = t.g.holder(&key(&a));
    // Only the 70,000 that missed: the 30,000 given back is neither staked nor credited.
    assert_eq!((h.net, h.worst), (-70_000, 70_000));
    assert_eq!(h.skt as u128, mint_amount(RewardsConfig::DEFAULT.mint_scale, 0, 70_000));
    // A piece given back whole mints nothing.
    let b = t.g.player(10 * E6, 10 * E6);
    let open_at = t.open();
    let bet = t.place(&b, open_at, &[(FAR, 50_000, HALF)]).unwrap();
    t.g.set_time((open_at + 2000) / 1000 + skech::state::BAR_LATE + 1);
    t.g.settle_on(true, &[(bet, key(&b))]).unwrap();
    assert_eq!(t.g.player_state(&b).balance, 10 * E6);
    let h = t.g.holder(&key(&b));
    assert_eq!((h.skt, h.net, h.worst), (0, 0, 0));
}

#[test]
fn only_settling_with_the_players_own_holder_goes_through() {
    let mut t = Table::new(Game::new());
    let (a, b) = (t.g.player(10 * E6, 10 * E6), t.g.player(10 * E6, 10 * E6));
    t.play(&b, &[(FAR, 100_000, HALF)], HIT_AT);
    let open_at = t.open();
    let bet = t.place(&a, open_at, &[(FAR, 100_000, HALF)]).unwrap();
    t.g.set_time(open_at / 1000 + 4);
    // A's bet with B's holder, and with an address that is no holder: both refused.
    for wrong in [holder_pda(&key(&b)), Pubkey::new_unique()] {
        let mut ix = t.g.post_and_settle_ix(open_at + 1000, MISS, MISS, MISS, MISS, &[(bet, key(&a))]);
        let n = ix.accounts.len();
        ix.accounts[n - 1].pubkey = wrong;
        assert_eq!(custom_error(&t.g.send(&[ix], &[])), Some(code(SkechError::BadSettleAccounts)));
    }
    // A pair with no holder at all: refused.
    let mut ix = t.g.post_and_settle_ix(open_at + 1000, MISS, MISS, MISS, MISS, &[(bet, key(&a))]);
    ix.accounts.pop();
    assert_eq!(custom_error(&t.g.send(&[ix], &[])), Some(code(SkechError::BadSettleAccounts)));
    // With its own, fine.
    t.g.post_and_settle(open_at + 1000, MISS, MISS, MISS, MISS, &[(bet, key(&a))]).unwrap();
    assert!(t.g.holder(&key(&a)).skt > 0);
}

#[test]
fn config_keeps_the_holders_split_inside_the_fee() {
    let mut t = Table::new(Game::new());
    let admin = t.g.admin.insecure_clone();
    let bad = Some(code(SkechError::BadConfig));
    // The holders' share above its fee, either way round, or no curve: refused.
    for r in [
        RewardsConfig { holder_fee_bps: 401, ..RewardsConfig::DEFAULT },
        RewardsConfig { holder_profit_fee_bps: 1001, ..RewardsConfig::DEFAULT },
        RewardsConfig { mint_scale: 0, ..RewardsConfig::DEFAULT },
        RewardsConfig { mint_scale: skech::state::MAX_MINT_SCALE + 1, ..RewardsConfig::DEFAULT },
    ] {
        assert_eq!(custom_error(&t.g.send(&[t.g.set_rewards_config_ix(r)], &[&admin])), bad, "{r:?}");
    }
    let mut c = t.g.game().config;
    c.fee_bps = 299;
    assert_eq!(custom_error(&t.g.send(&[t.g.set_config_ix(c)], &[&admin])), bad);
    c.fee_bps = 300;
    c.profit_fee_bps = 799;
    assert_eq!(custom_error(&t.g.send(&[t.g.set_config_ix(c)], &[&admin])), bad);
    // At the edge, fine: every point of both fees to holders.
    let all = RewardsConfig { holder_fee_bps: 400, holder_profit_fee_bps: 1000, ..RewardsConfig::DEFAULT };
    t.g.send(&[t.g.set_rewards_config_ix(all)], &[&admin]).unwrap();
    assert_eq!(t.g.rewards().config, all);
    // Only the admin; and Rewards starts once.
    let stranger = solana_keypair::Keypair::new();
    let mut ix = t.g.set_rewards_config_ix(RewardsConfig::DEFAULT);
    ix.accounts[0].pubkey = stranger.pubkey();
    assert_eq!(custom_error(&t.g.send(&[ix], &[&stranger])), Some(code(SkechError::NotAdmin)));
    assert!(t.g.send(&[t.g.init_rewards_ix(skech::state::Config::DEFAULT, RewardsConfig::DEFAULT)], &[&admin]).is_err());
}

#[test]
fn a_game_set_up_before_skt_moves_to_its_terms_in_one_step() {
    // A game as devnet has it: running at 1% and 5%, with no Rewards.
    let mut g = Game::deployed();
    let admin = g.admin.insecure_clone();
    g.send(&[g.initialize_ix(&admin.pubkey())], &[&admin]).unwrap();
    let market = g.ix(
        skech::accounts::InitMarket { admin: admin.pubkey(), game: game_pda(), market: market_pda(0), bars: bars_pda(0), system_program: anchor_lang::system_program::ID },
        skech::instruction::InitMarket { id: 0, name: "BTC-USD".into(), difficulty: 51 },
    );
    g.send(&[market], &[&admin]).unwrap();
    g.domain = g.game().domain;
    let old = skech::state::Config { fee_bps: 100, profit_fee_bps: 500, ..skech::state::Config::DEFAULT };
    let mut game = g.game();
    game.config = old;
    let mut data = vec![];
    anchor_lang::AccountSerialize::try_serialize(&game, &mut data).unwrap();
    let mut account = g.svm.get_account(&game_pda()).unwrap();
    account.data[..data.len()].copy_from_slice(&data);
    g.svm.set_account(game_pda(), account).unwrap();
    assert_eq!(g.game().config, old);
    // Until SKT starts, nothing is placed.
    let p = g.player(10 * E6, 5 * E6);
    let piece = g.piece(&p, 1, 0, (g.now + 1) * 1000, &[(1, AT, 5, 50_000)]);
    let quote = g.quote(&piece, HALF);
    assert!(g.place(&p, &piece, &quote).is_err(), "no Rewards, no placing");
    // SKT's split does not fit in 1% and 5%: refused; with terms that hold it, in the same instruction, fine.
    assert_eq!(custom_error(&g.send(&[g.init_rewards_ix(old, RewardsConfig::DEFAULT)], &[&admin])), Some(code(SkechError::BadConfig)));
    g.send(&[g.init_rewards_ix(skech::state::Config::DEFAULT, RewardsConfig::DEFAULT)], &[&admin]).unwrap();
    assert_eq!((g.game().config, g.rewards().config), (skech::state::Config::DEFAULT, RewardsConfig::DEFAULT));
    g.place(&p, &piece, &quote).expect("placed");
}

/* ---- farming ---- */

/// One strategy's game: a funder's loss first (so the pool pays every hit and the curve has moved), then `cycles` of
/// the strategy, each a hit and then misses, ending at a new low.
struct Farmed {
    skt: u64,
    worst: u64,
    /// Every losing band's stake added up: what a mint on every loss would have counted.
    lost: u64,
    /// The tracked gain the player started at, and how many times they minted.
    from: i128,
    mints: u64,
}

fn farm(scale: u64, cycles: usize, hit: Band, misses: usize, miss: Band) -> Farmed {
    let mut t = Table::new(Game::new());
    t.set_rewards(RewardsConfig { mint_scale: scale, ..RewardsConfig::DEFAULT });
    let funder = t.g.player(100 * E6, 100 * E6);
    t.play(&funder, &[(FAR, 10_000_000, HALF)], HIT_AT);
    let from = t.g.rewards().gain as i128;
    let p = t.g.player(100 * E6, 100 * E6);
    let (mut lost, mut mints) = (0u64, 0u64);
    for _ in 0..cycles {
        let m = t.play(&p, &[hit], HIT_AT);
        mints += events::<skech::events::Minted>(&m.logs).len() as u64;
        for _ in 0..misses {
            let m = t.play(&p, &[miss], MISS);
            mints += events::<skech::events::Minted>(&m.logs).len() as u64;
            lost += miss.1 as u64;
        }
    }
    let h = t.g.holder(&key(&p));
    assert_eq!(t.g.pool().iou_shares, 0, "never owed: the windows are the tracked gain's own");
    Farmed { skt: h.skt, worst: h.worst, lost, from, mints }
}

#[test]
fn a_long_shot_farms_no_more_skt_per_dollar_lost_than_ink_at_the_price() {
    // The long shot: 1% at 96x, 1.1¢ a band, a hit then 99 misses: 9.515¢ back for 11¢ in, −1.485¢ a cycle. Near the
    // price: 50% at 1.5x, 2.7¢ a band, a hit then a miss: 3.915¢ back for 5.4¢ in, ten times, −1.485¢. The same real
    // loss by very different roads: the long shot loses 7 times as much on the way.
    let scale = 5 * E6;
    let long = farm(scale, 3, (AT, 11_000, LONG), 99, (FAR, 11_000, LONG));
    let near = farm(scale, 30, (AT, 27_000, HALF), 1, (FAR, 27_000, HALF));
    assert_eq!((long.worst, near.worst), (3 * 148_500, 3 * 148_500));
    assert_eq!(long.from, near.from);
    // Each mints the curve's integral over its deepest loss, less a unit at most a mint: the same SKT for the same loss.
    let curve = mint_amount(scale, long.from, long.from + long.worst as i128) as u64;
    for (name, f) in [("long shot", &long), ("near the price", &near)] {
        assert!(f.skt <= curve && curve - f.skt <= f.mints, "{name}: {} SKT for {}, minted {} times; the curve {curve}", f.skt, f.worst, f.mints);
    }
    let per_dollar = |f: &Farmed| f.skt as f64 / f.worst as f64;
    let tolerance = (long.mints + near.mints) as f64 / long.worst as f64;
    assert!((per_dollar(&long) - per_dollar(&near)).abs() <= tolerance, "SKT a dollar: {} and {}", per_dollar(&long), per_dollar(&near));
    println!(
        "SKT per dollar of real loss: long shot {:.6} ({} mints), near the price {:.6} ({} mints); a mint on every loss would give the long shot {:.1}x",
        per_dollar(&long),
        long.mints,
        per_dollar(&near),
        near.mints,
        mint_amount(scale, long.from, long.from + long.lost as i128) as f64 / long.skt as f64
    );
    // Minting on every losing band instead would have paid the long shot for the 7x it lost on the way.
    assert!(long.lost > 7 * long.worst);
    let naive = mint_amount(scale, long.from, long.from + long.lost as i128) as u64;
    assert!(naive > 3 * long.skt, "a mint on every loss: {naive}, for {}", long.skt);
}

#[test]
fn whatever_the_order_skt_is_the_curve_over_the_deepest_loss() {
    // Long shots in a random order: the deepest loss may come before a late win, and SKT is minted on it, but never
    // more than the curve gives for the deepest net loss the player was ever at.
    let mut t = Table::new(Game::new());
    let funder = t.g.player(200 * E6, 200 * E6);
    t.play(&funder, &[(FAR, 10_000_000, HALF)], HIT_AT);
    let p = t.g.player(100 * E6, 100 * E6);
    let mut rng = Rng(12345);
    let mut mints = 0u64;
    let from = t.g.rewards().gain as i128;
    for _ in 0..300 {
        let price = if rng.below(100) < 2 { HIT_AT } else { MISS };
        let m = t.play(&p, &[(AT, 11_000, LONG)], price);
        mints += events::<skech::events::Minted>(&m.logs).len() as u64;
    }
    assert_eq!(t.g.pool().iou_shares, 0);
    let h = t.g.holder(&key(&p));
    let curve = mint_amount(RewardsConfig::DEFAULT.mint_scale, from, from + h.worst as i128) as u64;
    assert!(h.skt <= curve && curve - h.skt <= mints, "{} for a deepest loss worth {curve}", h.skt);
    assert!(h.skt as u128 <= 100 * h.worst as u128);
}

/* ---- the whole game at random ---- */

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// A player's net result and its low, as the test counts them from what it sent and the events: apart from the
/// program's own count.
#[derive(Default, Clone, Copy)]
struct Book {
    net: i64,
    worst: u64,
}

/// `long_shots`: one band in that many is a 1% shot at 96x; the fewer, the more often the pool is owing.
fn random_game(seed: u64, steps: usize, long_shots: u64) -> (u64, u64) {
    let mut t = Table::new(Game::new());
    let mut rng = Rng(seed);
    let players: Vec<Player> = (0..4).map(|_| t.g.player(40 * E6, 1000 * E6)).collect();
    let mut books = vec![Book::default(); players.len()];
    let mut stakes_of: HashMap<Pubkey, Vec<u64>> = HashMap::new();
    let (mut withdrawn, mut rounds, mut expired, mut owed_steps) = (0u64, 0u64, 0u64, 0u64);
    let idx = |w: &Pubkey| players.iter().position(|p| key(p) == *w).unwrap();
    for step in 0..steps {
        match rng.below(10) {
            0..=5 => {
                // A round: some players place, one bar, all settled; now and then the bar never comes and it is expired.
                rounds += 1;
                let open_at = t.open();
                let mut bets = vec![];
                for p in &players {
                    if rng.below(3) == 0 {
                        continue;
                    }
                    let n = 1 + rng.below(3) as usize;
                    // Long shots now and then, small, so the pool runs short and IOUs come and go without staying.
                    let bands: Vec<Band> = (0..n)
                        .map(|_| match rng.below(long_shots) {
                            0 => (AT, 1_000 + rng.below(20_000) as u32, LONG),
                            x if x % 3 == 1 => (FAR, 1_000 + rng.below(400_000) as u32, HALF),
                            _ => (AT, 1_000 + rng.below(400_000) as u32, HALF),
                        })
                        .collect();
                    if let Some(bet) = t.place(p, open_at, &bands) {
                        let b: skech::state::Bet = t.g.account(&bet).unwrap();
                        stakes_of.insert(bet, b.sections.iter().map(|s| s.stake).collect());
                        bets.push((bet, key(p)));
                    }
                }
                let logs = if rng.below(8) == 0 {
                    expired += 1;
                    t.g.set_time((open_at + 2000) / 1000 + skech::state::BAR_LATE + 1);
                    let mut all = vec![];
                    for chunk in bets.chunks(6) {
                        all.extend(t.g.settle_on(true, chunk).unwrap().logs);
                    }
                    all
                } else {
                    let price = [HIT_AT, HIT_FAR, MISS][rng.below(3) as usize];
                    t.settle(open_at, price, &bets).logs
                };
                for s in events::<skech::events::Settled>(&logs) {
                    let stakes = &stakes_of[&s.bet];
                    let decided: u64 = (0..stakes.len()).filter(|i| (s.hit_mask | s.miss_mask) & (1 << i) != 0).map(|i| stakes[i]).sum();
                    let credited = s.paid + s.owed - s.refunded;
                    let b = &mut books[idx(&s.player)];
                    b.net += credited as i64 - decided as i64;
                    b.worst = b.worst.max((-b.net).max(0) as u64);
                }
            }
            6 => {
                let p = &players[rng.below(4) as usize];
                if t.g.account::<skech::state::Holder>(&holder_pda(&key(p))).is_some() {
                    t.claim(p);
                }
            }
            7 => {
                // Pay off whatever the pool can.
                for p in &players {
                    if t.g.player_state(p).iou_shares > 0 {
                        let _ = t.g.send(&[t.redeem_ix(&key(p), t.g.relayer.pubkey())], &[]);
                    }
                }
            }
            8 => {
                let p = &players[rng.below(4) as usize];
                let w = p.wallet.insecure_clone();
                let bal = t.g.player_state(p).balance;
                if rng.below(2) == 0 && bal > 0 {
                    let amount = 1 + rng.below(bal.min(5 * E6));
                    t.g.send(&[t.g.withdraw_ix(p, amount, p.usdc)], &[&w]).unwrap();
                    withdrawn += amount;
                } else {
                    t.g.send(&[t.g.deposit_ix(p, 1 + rng.below(3 * E6))], &[&w]).unwrap();
                }
            }
            _ => {
                let collect = t.g.ix(
                    skech::accounts::CollectFees { game: game_pda(), pool: pool_pda(), vault: t.g.vault(), treasury: t.g.treasury, usdc_mint: t.g.mint, token_program: anchor_spl::token::spl_token::ID },
                    skech::instruction::CollectFees {},
                );
                t.g.send(&[collect], &[]).unwrap();
            }
        }
        // The books, after every step.
        let at = format!("seed {seed}, step {step}");
        let (pool, r) = (t.g.pool(), t.g.rewards());
        if pool.iou_shares > 0 {
            owed_steps += 1;
        }
        let balances: u64 = players.iter().map(|p| t.g.player_state(p).balance).sum();
        assert_eq!(token_balance(&t.g.svm, &t.g.vault()), balances + pool.pool + pool.fees + r.holder_funds, "{at}: vault == balances + pool + fees + holder funds");
        let claimable: u64 = players.iter().map(|p| t.claimable(&key(p))).sum();
        assert!(r.claimed_total + claimable <= r.accrued_total, "{at}: claimed {} + claimable {claimable} over accrued {}", r.claimed_total, r.accrued_total);
        assert_eq!(r.holder_funds, r.accrued_total - r.claimed_total, "{at}: holder funds");
        let supply: u64 = players.iter().map(|p| t.g.holder(&key(p)).skt).sum();
        assert_eq!(supply, r.supply, "{at}: the supply is every holder's SKT");
        let mut gain = 0i64;
        for (i, p) in players.iter().enumerate() {
            let h = t.g.holder(&key(p));
            assert_eq!((h.net, h.worst), (books[i].net, books[i].worst), "{at}: player {i}'s net and its low, as the test counts them");
            assert!(h.skt as u128 <= 100 * h.worst as u128, "{at}: player {i} minted {} for a deepest loss of {}", h.skt, h.worst);
            gain -= h.net;
        }
        assert_eq!(r.gain, gain, "{at}: the tracked gain is every player's net loss");
    }
    let r = t.g.rewards();
    println!(
        "seed {seed:#x}, a long shot in {long_shots}: {steps} steps, {rounds} rounds ({expired} expired), owed after {owed_steps} steps; {} SKT minted, {} accrued to holders, {} claimed, {} withdrawn",
        r.supply, r.accrued_total, r.claimed_total, withdrawn
    );
    assert!(r.supply > 0, "the run minted SKT");
    (owed_steps, r.claimed_total)
}

#[test]
fn the_books_balance_at_every_step_of_a_random_game() {
    // Mostly paid at once, and mostly owing: both must hold their books, and between them use every path.
    let (mut owed, mut claimed) = (0, 0);
    for seed in [1u64, 2, 3, 0xdead_beef, 0x5eed, 0xfeed_f00d] {
        for long_shots in [12, 4] {
            let (o, c) = random_game(seed, 250, long_shots);
            owed += o;
            claimed += c;
        }
    }
    assert!(owed > 500 && claimed > 0, "owed for {owed} steps, {claimed} claimed");
}
