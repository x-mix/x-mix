use anchor_lang::prelude::*;

use crate::{state::Pool, utils::error::XMixErrorCode};

#[derive(Accounts)]
pub struct SetPause<'info> {
  #[account(mut)]
  pub authority: Signer<'info>,

  #[account(mut)]
  pub pool: AccountLoader<'info, Pool>,
}

impl SetPause<'_> {
  pub fn validate(&self) -> Result<()> {
    let pool = self.pool.load()?;
    require_keys_eq!(
      self.authority.key(),
      pool.authority,
      XMixErrorCode::Unauthorized
    );
    Ok(())
  }

  #[access_control(ctx.accounts.validate())]
  pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
    let mut pool = ctx.accounts.pool.load_mut()?;
    pool.paused = if paused { 1 } else { 0 };
    Ok(())
  }
}
