//! Setting the game up and running it. Only the program's upgrade authority may initialize (so nobody can take a
//! fresh deployment before its owner does); after that the admin, a multisig on mainnet, sets everything.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::error::SkechError;
use crate::events::{ConfigSet, MarketSet};
use crate::ladder;
use crate::program::Skech;
use crate::state::*;

/// sha256("skech/v1" || program id || cluster): what every signed piece starts with.
pub fn domain_for(program_id: &Pubkey, cluster: &str) -> [u8; 32] {
    hashv(&[b"skech/v1", program_id.as_ref(), cluster.as_bytes()]).to_bytes()
}

pub fn check_config(c: &Config) -> Result<()> {
    require!(c.fee_bps <= 2000 && c.profit_fee_bps <= 5000 && c.sweep_bps <= 5000, SkechError::BadConfig);
    require!(c.min_per_dot > 0 && c.min_per_dot <= c.max_per_dot && c.max_per_dot <= u32::MAX as u64, SkechError::BadConfig);
    require!(c.max_piece_stake > 0, SkechError::BadConfig);
    require!((1000..=10_000).contains(&c.place_grace_ms) && c.late_ms <= 1000, SkechError::BadConfig);
    require!(c.max_price_age_ms > 0 && c.max_session_secs > 0, SkechError::BadConfig);
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Game::INIT_SPACE, seeds = [GAME_SEED], bump)]
    pub game: Account<'info, Game>,
    #[account(init, payer = authority, space = 8 + Pool::INIT_SPACE, seeds = [POOL_SEED], bump)]
    pub pool: Account<'info, Pool>,
    #[account(mint::token_program = token_program)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = game,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(token::mint = usdc_mint, token::token_program = token_program)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ SkechError::NotUpgradeAuthority)]
    pub program: Program<'info, Skech>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ SkechError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<Initialize>, cluster: String, oracle: Pubkey, iou_rate: u64) -> Result<()> {
    require!(!cluster.is_empty() && cluster.len() <= 32, SkechError::BadConfig);
    let game = &mut ctx.accounts.game;
    game.admin = ctx.accounts.authority.key();
    game.pending_admin = Pubkey::default();
    game.oracle = oracle;
    game.usdc_mint = ctx.accounts.usdc_mint.key();
    game.token_program = ctx.accounts.token_program.key();
    game.vault = ctx.accounts.vault.key();
    game.treasury = ctx.accounts.treasury.key();
    game.domain = domain_for(ctx.program_id, &cluster);
    game.paused = false;
    game.config = Config::DEFAULT;
    game.bump = ctx.bumps.game;
    let pool = &mut ctx.accounts.pool;
    pool.iou_index_at = INDEX_ONE;
    pool.iou_rate = iou_rate;
    pool.iou_time_at = Clock::get()?.unix_timestamp;
    pool.bump = ctx.bumps.pool;
    emit!(ConfigSet { config: game.config });
    Ok(())
}

#[derive(Accounts)]
pub struct Admin<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED], bump = game.bump, has_one = admin @ SkechError::NotAdmin)]
    pub game: Account<'info, Game>,
}

pub fn set_config(ctx: Context<Admin>, config: Config) -> Result<()> {
    check_config(&config)?;
    ctx.accounts.game.config = config;
    emit!(ConfigSet { config });
    Ok(())
}

pub fn set_oracle(ctx: Context<Admin>, oracle: Pubkey) -> Result<()> {
    require_keys_neq!(oracle, Pubkey::default(), SkechError::BadConfig);
    ctx.accounts.game.oracle = oracle;
    Ok(())
}

pub fn set_paused(ctx: Context<Admin>, paused: bool) -> Result<()> {
    ctx.accounts.game.paused = paused;
    Ok(())
}

pub fn propose_admin(ctx: Context<Admin>, admin: Pubkey) -> Result<()> {
    ctx.accounts.game.pending_admin = admin;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED], bump = game.bump, constraint = game.pending_admin == new_admin.key() @ SkechError::NotAdmin)]
    pub game: Account<'info, Game>,
}

pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let game = &mut ctx.accounts.game;
    game.admin = game.pending_admin;
    game.pending_admin = Pubkey::default();
    Ok(())
}

#[derive(Accounts)]
pub struct SetTreasury<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED], bump = game.bump, has_one = admin @ SkechError::NotAdmin)]
    pub game: Account<'info, Game>,
    #[account(token::mint = game.usdc_mint)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
}

pub fn set_treasury(ctx: Context<SetTreasury>) -> Result<()> {
    ctx.accounts.game.treasury = ctx.accounts.treasury.key();
    Ok(())
}

#[derive(Accounts)]
pub struct SetIouRate<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = admin @ SkechError::NotAdmin)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
}

/// How fast what is owed grows, from now on, x1e18 per second. What has accrued so far is kept.
pub fn set_iou_rate(ctx: Context<SetIouRate>, rate: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    pool.iou_index_at = pool.index(now);
    pool.iou_time_at = now;
    pool.iou_rate = rate;
    Ok(())
}

#[derive(Accounts)]
#[instruction(id: u8)]
pub struct InitMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = admin @ SkechError::NotAdmin)]
    pub game: Account<'info, Game>,
    #[account(init, payer = admin, space = 8 + Market::INIT_SPACE, seeds = [MARKET_SEED, &[id]], bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = admin, space = Bars::SPACE, seeds = [BARS_SEED, &[id]], bump)]
    pub bars: AccountLoader<'info, Bars>,
    pub system_program: Program<'info, System>,
}

pub fn init_market(ctx: Context<InitMarket>, id: u8, name: String, difficulty: u8) -> Result<()> {
    require!((ladder::MIN_DIFFICULTY..=100).contains(&difficulty), SkechError::BadDifficulty);
    require!(!name.is_empty() && name.len() <= 16, SkechError::BadConfig);
    let market = &mut ctx.accounts.market;
    market.id = id;
    market.active = true;
    market.difficulty = difficulty;
    market.name = name.clone();
    market.bump = ctx.bumps.market;
    ctx.accounts.bars.load_init()?.market = id;
    emit!(MarketSet { market: id, name, active: true, difficulty });
    Ok(())
}

#[derive(Accounts)]
pub struct SetMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [GAME_SEED], bump = game.bump, has_one = admin @ SkechError::NotAdmin)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [MARKET_SEED, &[market.id]], bump = market.bump)]
    pub market: Account<'info, Market>,
}

/// Open or close a market, and set how hard it is, 50 to 100: below 50, ink exactly on a rung would return more than a
/// dollar. Pieces already open keep the difficulty they were placed at.
pub fn set_market(ctx: Context<SetMarket>, active: bool, difficulty: u8) -> Result<()> {
    require!((ladder::MIN_DIFFICULTY..=100).contains(&difficulty), SkechError::BadDifficulty);
    let market = &mut ctx.accounts.market;
    market.active = active;
    market.difficulty = difficulty;
    emit!(MarketSet { market: market.id, name: market.name.clone(), active, difficulty });
    Ok(())
}
