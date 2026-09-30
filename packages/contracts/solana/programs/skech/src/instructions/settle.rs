//! The price, a second at a time, and settling on it. The oracle posts each second once it is over; every band in
//! that second is then decided by one rule, hit or miss. A bet whose last band is decided is closed, and its rent
//! goes back to whoever paid it.

use anchor_lang::prelude::*;

use crate::error::SkechError;
use crate::events::{BarPosted, Owed, Settled};
use crate::ladder;
use crate::state::*;

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
    /// Gets back the rent of the bets closed here: must be who paid it.
    /// CHECK: compared with each bet's `rent_payer`.
    #[account(mut)]
    pub rent_receiver: UncheckedAccount<'info>,
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
    /// CHECK: compared with each bet's `rent_payer`.
    #[account(mut)]
    pub rent_receiver: UncheckedAccount<'info>,
}

fn post(game: &Game, bars: &mut Bars, market: u8, bar: &BarInput) -> Result<()> {
    require!(bars.market == market, SkechError::BadBar);
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
    // One second follows from the last: the previous bar's close is this one's opening price.
    if let Some(prev) = bars.at(bar.second - 1000) {
        require!(prev.close == bar.prev_close, SkechError::BarDiscontinuous);
    }
    bars.put(new);
    emit!(BarPosted { market, second: bar.second, prev_close: bar.prev_close, high: bar.high, low: bar.low, close: bar.close });
    Ok(())
}

pub fn post_bar(ctx: Context<PostBar>, market: u8, bar: BarInput) -> Result<()> {
    require!(!ctx.accounts.game.paused, SkechError::Paused);
    require!(ctx.accounts.market_account.active, SkechError::MarketInactive);
    let mut bars = ctx.accounts.bars.load_mut()?;
    post(&ctx.accounts.game, &mut bars, market, &bar)
}

/// The relayer's one transaction a second: the bar, then every bet with ink in it, as (bet, player) pairs in the
/// remaining accounts.
pub fn post_bar_and_settle<'info>(ctx: Context<'_, '_, 'info, 'info, PostBarAndSettle<'info>>, market: u8, bar: BarInput) -> Result<()> {
    let a = ctx.accounts;
    require!(!a.game.paused, SkechError::Paused);
    require!(a.market_account.active, SkechError::MarketInactive);
    {
        let mut bars = a.bars.load_mut()?;
        post(&a.game, &mut bars, market, &bar)?;
    }
    let bars = a.bars.load()?;
    settle_all(ctx.program_id, &a.game, &bars, &mut a.pool, &a.rent_receiver, ctx.remaining_accounts, market)
}

/// Settle bets on the bars already posted: bands in a posted second are hit or missed; the rest wait. Anyone may.
pub fn settle<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>, market: u8) -> Result<()> {
    let a = ctx.accounts;
    require!(!a.game.paused, SkechError::Paused);
    let bars = a.bars.load()?;
    require!(bars.market == market, SkechError::BadBar);
    settle_all(ctx.program_id, &a.game, &bars, &mut a.pool, &a.rent_receiver, ctx.remaining_accounts, market)
}

fn settle_all<'info>(program_id: &Pubkey, game: &Game, bars: &Bars, pool: &mut Pool, rent_receiver: &UncheckedAccount<'info>, pairs: &'info [AccountInfo<'info>], market: u8) -> Result<()> {
    require!(pairs.len() % 2 == 0, SkechError::BadSettleAccounts);
    let now = Clock::get()?.unix_timestamp;
    for pair in pairs.chunks(2) {
        settle_one(program_id, game, bars, pool, rent_receiver, &pair[0], &pair[1], market, now)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn settle_one<'info>(program_id: &Pubkey, game: &Game, bars: &Bars, pool: &mut Pool, rent_receiver: &UncheckedAccount<'info>, bet_info: &AccountInfo<'info>, player_info: &AccountInfo<'info>, market: u8, now: i64) -> Result<()> {
    // Already closed (settled in an earlier transaction): nothing to do, and not an error, so a retry is harmless.
    if bet_info.owner != program_id || bet_info.data_is_empty() {
        return Ok(());
    }
    require!(bet_info.is_writable && player_info.is_writable && player_info.owner == program_id, SkechError::BadSettleAccounts);
    let mut bet = Bet::try_deserialize(&mut &bet_info.try_borrow_data()?[..])?;
    let mut player = Player::try_deserialize(&mut &player_info.try_borrow_data()?[..])?;
    require_keys_eq!(player.authority, bet.player, SkechError::BadSettleAccounts);
    require!(bet.market == market, SkechError::BadSettleAccounts);

    let live = bet.live_mask;
    let (mut hits, mut decided) = (0u32, 0u32);
    let (mut gross_pay, mut stake_hit) = (0u64, 0u64);
    for (i, s) in bet.sections.iter().enumerate() {
        let bit = 1u32 << i;
        if live & bit == 0 {
            continue;
        }
        let Some(b) = bars.at(bet.open_at + s.second as i64 * 1000) else { continue };
        decided |= bit;
        if ladder::crosses(b.prev_close, b.high, b.low, s.lo, s.hi, bet.unit) {
            hits |= bit;
            stake_hit += s.stake;
            gross_pay += ladder::gross(s.stake, s.rung);
        }
    }
    if decided == 0 {
        return Ok(());
    }
    bet.live_mask = live & !decided;
    bet.hit_mask |= hits;
    let (mut paid, mut owed) = (0, 0);
    if gross_pay > 0 {
        let profit = gross_pay - stake_hit;
        // Rounded up, as on Monad: a small profit never slips under the fee.
        let profit_fee = (profit * game.config.profit_fee_bps as u64).div_ceil(BPS);
        (paid, owed) = pay(pool, &mut player, gross_pay - profit_fee, now);
        // The player is paid first. The house's cut comes after, out of what the pool has left, and is never owed: a
        // shortfall is never made worse by a debt growing to the house.
        let cut = profit_fee.min(pool.pool);
        pool.pool -= cut;
        pool.fees += cut;
    }
    player.try_serialize(&mut &mut player_info.try_borrow_mut_data()?[..])?;
    let closed = bet.live_mask == 0;
    if closed {
        // Every band decided: the bet is done. Its rent goes back to whoever paid it.
        require_keys_eq!(rent_receiver.key(), bet.rent_payer, SkechError::BadSettleAccounts);
        let lamports = bet_info.lamports();
        **rent_receiver.to_account_info().try_borrow_mut_lamports()? += lamports;
        **bet_info.try_borrow_mut_lamports()? = 0;
        bet_info.assign(&anchor_lang::system_program::ID);
        bet_info.resize(0)?;
    } else {
        bet.try_serialize(&mut &mut bet_info.try_borrow_mut_data()?[..])?;
    }
    emit!(Settled { bet: bet_info.key(), player: bet.player, hit_mask: hits, miss_mask: decided & !hits, paid, owed, closed });
    Ok(())
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
