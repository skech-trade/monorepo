//! The price, a second at a time, and settling on it. The oracle posts each second once it is over; every band in
//! that second is then decided by one rule, hit or miss. A bet whose last band is decided is closed, once its piece
//! can no longer be placed, and its rent goes back to whoever paid it. A band whose second was never posted, and now
//! never can be, is given back by `expire`.

use anchor_lang::prelude::*;

use crate::error::SkechError;
use crate::events::{BarPosted, Owed, Settled};
use crate::ladder;
use crate::skt;
use crate::state::*;
// Named, not only globbed: the prelude has a `Rewards` too (the sysvar).
use crate::state::Rewards;
use crate::instructions::place::create_pda_at;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct BarInput {
    pub second: i64,
    pub prev_close: u64,
    pub high: u64,
    pub low: u64,
    pub close: u64,
}

#[derive(Accounts)]
#[instruction(market: u8)]
pub struct PostBar<'info> {
    pub oracle: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = oracle @ SkechError::NotOracle)]
    pub game: Box<Account<'info, Game>>,
    #[account(seeds = [MARKET_SEED, &[market]], bump = market_account.bump)]
    pub market_account: Box<Account<'info, Market>>,
    #[account(mut, seeds = [BARS_SEED, &[market]], bump)]
    pub bars: AccountLoader<'info, Bars>,
}

#[derive(Accounts)]
#[instruction(market: u8)]
pub struct PostBarAndSettle<'info> {
    pub oracle: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = oracle @ SkechError::NotOracle)]
    pub game: Box<Account<'info, Game>>,
    #[account(seeds = [MARKET_SEED, &[market]], bump = market_account.bump)]
    pub market_account: Box<Account<'info, Market>>,
    #[account(mut, seeds = [BARS_SEED, &[market]], bump)]
    pub bars: AccountLoader<'info, Bars>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [REWARDS_SEED], bump = rewards.bump)]
    pub rewards: Box<Account<'info, Rewards>>,
    /// Gets back the rent of the bets closed here: only those it paid for are closed.
    /// CHECK: compared with each bet's `rent_payer`.
    #[account(mut)]
    pub rent_receiver: UncheckedAccount<'info>,
    /// Pays the rent of a player's `Holder` the first time a settlement decides a band of theirs. The oracle, usually.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market: u8)]
pub struct Settle<'info> {
    #[account(seeds = [GAME_SEED], bump = game.bump)]
    pub game: Box<Account<'info, Game>>,
    #[account(seeds = [BARS_SEED, &[market]], bump)]
    pub bars: AccountLoader<'info, Bars>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [REWARDS_SEED], bump = rewards.bump)]
    pub rewards: Box<Account<'info, Rewards>>,
    /// CHECK: compared with each bet's `rent_payer`.
    #[account(mut)]
    pub rent_receiver: UncheckedAccount<'info>,
    /// Pays the rent of a player's `Holder` the first time a settlement decides a band of theirs: whoever settles.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// What every bet in a settlement shares.
struct Batch<'a, 'info> {
    program_id: &'a Pubkey,
    game: &'a Game,
    bars: &'a Bars,
    pool: &'a mut Pool,
    rewards: &'a mut Rewards,
    rent_receiver: &'a UncheckedAccount<'info>,
    payer: &'a Signer<'info>,
    system_program: &'a Program<'info, System>,
    market: u8,
    now: i64,
    expire: bool,
}

fn post(game: &Game, bars: &mut Bars, market: u8, bar: &BarInput) -> Result<()> {
    require!(bar.second > 0 && bar.second % 1000 == 0 && bar.low > 0 && bar.prev_close > 0, SkechError::BadBar);
    require!(bar.low <= bar.high && bar.close >= bar.low && bar.close <= bar.high, SkechError::BadBar);
    // A second is posted once it is over, by this chain's clock, give or take the grace: never ahead of the ink in it.
    let now_ms = Clock::get()?.unix_timestamp * 1000;
    require!(bar.second + 1000 <= now_ms + game.config.place_grace_ms as i64, SkechError::BadBar);
    let new = Bar { second: bar.second, prev_close: bar.prev_close, high: bar.high, low: bar.low, close: bar.close };
    if let Some(existing) = bars.at(bar.second) {
        // Posting the same bar twice is fine; a different one for the same second is not.
        require!(*existing == new, SkechError::BarConflict);
        return Ok(());
    }
    // Not so late that a bet in it may have been given its stake back, or that its slot may hold a newer second.
    require!(!Bars::too_late(bar.second, now_ms), SkechError::BarLate);
    // One second follows from the last: the previous bar's close is this one's opening price.
    if let Some(prev) = bars.at(bar.second - 1000) {
        require!(prev.close == bar.prev_close, SkechError::BarDiscontinuous);
    }
    require!(bars.put(new), SkechError::BarLate);
    emit!(BarPosted { market, second: bar.second, prev_close: bar.prev_close, high: bar.high, low: bar.low, close: bar.close });
    Ok(())
}

/// Post a second's bar. A market closed to new pieces is still posted, so the bets already in it are decided.
pub fn post_bar(ctx: Context<PostBar>, market: u8, bar: BarInput) -> Result<()> {
    require!(!ctx.accounts.game.paused, SkechError::Paused);
    let mut bars = ctx.accounts.bars.load_mut()?;
    post(&ctx.accounts.game, &mut bars, market, &bar)
}

/// The relayer's one transaction a second: the bar, then every bet with ink in it, as (bet, player, holder) triples
/// in the remaining accounts.
pub fn post_bar_and_settle<'info>(ctx: Context<'_, '_, 'info, 'info, PostBarAndSettle<'info>>, market: u8, bar: BarInput) -> Result<()> {
    let a = ctx.accounts;
    require!(!a.game.paused, SkechError::Paused);
    {
        let mut bars = a.bars.load_mut()?;
        post(&a.game, &mut bars, market, &bar)?;
    }
    let bars = a.bars.load()?;
    let mut b = Batch { program_id: ctx.program_id, game: &a.game, bars: &bars, pool: &mut a.pool, rewards: &mut a.rewards, rent_receiver: &a.rent_receiver, payer: &a.payer, system_program: &a.system_program, market, now: Clock::get()?.unix_timestamp, expire: false };
    settle_all(&mut b, ctx.remaining_accounts)
}

/// Settle bets on the bars already posted: bands in a posted second are hit or missed; the rest wait. Anyone may.
pub fn settle<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>, market: u8) -> Result<()> {
    settle_or_expire(ctx, market, false)
}

/// Settle bets as `settle` does, and give back the stake of every band whose second was never posted and is now too
/// late to be (`BAR_LATE`), all of it, as Monad's `expire` does. Anyone may, so a player's stake never waits on an
/// oracle that has stopped.
pub fn expire<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>, market: u8) -> Result<()> {
    settle_or_expire(ctx, market, true)
}

fn settle_or_expire<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>, market: u8, expire: bool) -> Result<()> {
    let a = ctx.accounts;
    require!(!a.game.paused, SkechError::Paused);
    let bars = a.bars.load()?;
    let mut b = Batch { program_id: ctx.program_id, game: &a.game, bars: &bars, pool: &mut a.pool, rewards: &mut a.rewards, rent_receiver: &a.rent_receiver, payer: &a.payer, system_program: &a.system_program, market, now: Clock::get()?.unix_timestamp, expire };
    settle_all(&mut b, ctx.remaining_accounts)
}

fn settle_all<'info>(b: &mut Batch<'_, 'info>, accounts: &'info [AccountInfo<'info>]) -> Result<()> {
    require!(accounts.len() % 3 == 0, SkechError::BadSettleAccounts);
    // Every Holder the batch needs is opened before anything is settled: a call to the system program after a closed
    // bet's rent has been moved by hand would leave this instruction's lamports out of balance, which the runtime refuses.
    for t in accounts.chunks(3) {
        open_holder(b, &t[0], &t[2])?;
    }
    for t in accounts.chunks(3) {
        settle_one(b, &t[0], &t[1], &t[2])?;
    }
    Ok(())
}

fn settle_one<'info>(b: &mut Batch<'_, 'info>, bet_info: &AccountInfo<'info>, player_info: &AccountInfo<'info>, holder_info: &AccountInfo<'info>) -> Result<()> {
    let (program_id, now) = (b.program_id, b.now);
    // Already closed (settled in an earlier transaction): nothing to do, and not an error, so a retry is harmless.
    if bet_info.owner != program_id || bet_info.data_is_empty() {
        return Ok(());
    }
    require!(bet_info.is_writable && player_info.is_writable && player_info.owner == program_id, SkechError::BadSettleAccounts);
    let mut bet = Bet::try_deserialize(&mut &bet_info.try_borrow_data()?[..])?;
    let mut player = Player::try_deserialize(&mut &player_info.try_borrow_data()?[..])?;
    require_keys_eq!(player.authority, bet.player, SkechError::BadSettleAccounts);
    require!(bet.market == b.market, SkechError::BadSettleAccounts);

    let live = bet.live_mask;
    let (mut hits, mut decided, mut expired) = (0u32, 0u32, 0u32);
    let (mut gross_pay, mut stake_hit, mut stake_back, mut stake_decided) = (0u64, 0u64, 0u64, 0u64);
    for (i, s) in bet.sections.iter().enumerate() {
        let bit = 1u32 << i;
        if live & bit == 0 {
            continue;
        }
        let second = bet.open_at + s.second as i64 * 1000;
        let Some(bar) = b.bars.at(second) else {
            if b.expire && Bars::too_late(second, now * 1000) {
                decided |= bit;
                expired |= bit;
                stake_back += s.stake;
            }
            continue;
        };
        decided |= bit;
        stake_decided += s.stake;
        if ladder::crosses(bar.prev_close, bar.high, bar.low, s.lo, s.hi, bet.unit) {
            hits |= bit;
            stake_hit += s.stake;
            gross_pay += ladder::gross(s.stake, s.rung);
        }
    }
    // A bet is not closed while its piece could still be placed: that would let the same piece go in again. Nor
    // here if someone else paid its rent: it waits for them, and the rest of the batch goes on.
    let closable = now * 1000 > bet.open_at + b.game.config.place_grace_ms as i64 && b.rent_receiver.key() == bet.rent_payer;
    if decided == 0 && !(live == 0 && closable) {
        return Ok(());
    }
    bet.live_mask = live & !decided;
    bet.hit_mask |= hits;
    // Whether anything was owed before this bet was settled: if so, a loss here mints as if the tracked gain were 0.
    let ious = b.pool.iou_shares > 0;
    let (mut paid, mut owed, mut credited) = (0, 0, 0);
    if gross_pay > 0 {
        let c = &b.game.config;
        let profit = gross_pay - stake_hit;
        // Rounded up, as on Monad: a small profit never slips under the fee.
        let profit_fee = (profit * c.profit_fee_bps as u64).div_ceil(BPS);
        credited = gross_pay - profit_fee;
        (paid, owed) = pay(b.pool, &mut player, credited, now);
        // The player is paid first. The house's cut comes after, out of what the pool has left, and is never owed: a
        // shortfall is never made worse by a debt growing to the house. The holders' share is taken the same way.
        let to_holders = skt::holder_part(profit, b.rewards.config.holder_profit_fee_bps, c.profit_fee_bps);
        let cut = (profit_fee - to_holders).min(b.pool.pool);
        b.pool.pool -= cut;
        b.pool.fees += cut;
        b.rewards.share_profit_fee(b.pool, to_holders)?;
    }
    let mut refunded = 0;
    if stake_back > 0 {
        // All of it, as on Monad: a band its bar never came for never ran. The pool gives back the fee as well.
        refunded = stake_back;
        let (p, o) = pay(b.pool, &mut player, refunded, now);
        paid += p;
        owed += o;
    }
    if decided != 0 {
        player.try_serialize(&mut &mut player_info.try_borrow_mut_data()?[..])?;
        // The player's net result: the stakes decided here (a band given back is neither staked nor credited) against
        // what the hits credited them, paid or owed.
        if stake_decided > 0 {
            let mut holder = holder_of(b, holder_info, bet.player)?;
            holder.settle_rewards(b.rewards.acc)?;
            b.rewards.record(&mut holder, stake_decided, credited, ious)?;
            holder.try_serialize(&mut &mut holder_info.try_borrow_mut_data()?[..])?;
        }
    }
    let closed = bet.live_mask == 0 && closable;
    if closed {
        // Every band decided: the bet is done. Its rent goes back to whoever paid it.
        let lamports = bet_info.lamports();
        **b.rent_receiver.to_account_info().try_borrow_mut_lamports()? += lamports;
        **bet_info.try_borrow_mut_lamports()? = 0;
        bet_info.assign(&anchor_lang::system_program::ID);
        bet_info.resize(0)?;
    } else {
        bet.try_serialize(&mut &mut bet_info.try_borrow_mut_data()?[..])?;
    }
    emit!(Settled { bet: bet_info.key(), player: bet.player, hit_mask: hits, miss_mask: decided & !hits & !expired, paid, owed, closed, expired_mask: expired, refunded });
    Ok(())
}

/// Open the `Holder` of a live bet's player at the payer's cost, if it is not there yet: at its address only, for
/// that player only.
fn open_holder<'info>(b: &Batch<'_, 'info>, bet_info: &AccountInfo<'info>, info: &AccountInfo<'info>) -> Result<()> {
    if bet_info.owner != b.program_id || bet_info.data_is_empty() || (info.owner == b.program_id && !info.data_is_empty()) {
        return Ok(());
    }
    // The bet's player, the first field after its discriminator.
    let player = {
        let data = bet_info.try_borrow_data()?;
        require!(data.len() >= 40 && data[..8] == *Bet::DISCRIMINATOR, SkechError::BadSettleAccounts);
        Pubkey::new_from_array(data[8..40].try_into().unwrap())
    };
    let (address, bump) = Pubkey::find_program_address(&[HOLDER_SEED, player.as_ref()], b.program_id);
    require!(address == info.key() && info.is_writable, SkechError::BadSettleAccounts);
    create_pda_at(b.payer, info, b.system_program, Holder::SPACE, b.program_id, &[HOLDER_SEED, player.as_ref(), &[bump]])?;
    let holder = Holder { player, acc_at: b.rewards.acc, bump, ..Default::default() };
    holder.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])
}

/// The player's `Holder`. Only the program makes an account with a Holder's discriminator, and only at the player's
/// own address: one that names this player is theirs.
fn holder_of<'info>(b: &Batch<'_, 'info>, info: &AccountInfo<'info>, player: Pubkey) -> Result<Holder> {
    require!(info.is_writable && info.owner == b.program_id, SkechError::BadSettleAccounts);
    let h = Holder::try_deserialize(&mut &info.try_borrow_data()?[..])?;
    require_keys_eq!(h.player, player, SkechError::BadSettleAccounts);
    Ok(h)
}

/// Pay `due` from the pool: in USDC into the player's balance as far as it goes, the rest as IOU shares.
pub fn pay(pool: &mut Pool, player: &mut Player, due: u64, now: i64) -> (u64, u64) {
    let paid = due.min(pool.pool);
    pool.pool -= paid;
    player.balance += paid;
    let owed = due - paid;
    if owed > 0 {
        let shares = pool.shares_for(owed, now);
        pool.iou_shares += shares;
        player.iou_shares += shares;
        player.iou_basis += owed;
        emit!(Owed { to: player.authority, value: owed, shares });
    }
    (paid, owed)
}
