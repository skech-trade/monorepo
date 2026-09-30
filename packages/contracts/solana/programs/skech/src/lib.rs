use anchor_lang::prelude::*;

declare_id!("2k9WY5YR357AGVVoBW6ouFHijEypTj8953fzSdD7HfRV");

#[program]
pub mod skech {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
