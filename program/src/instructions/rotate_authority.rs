use anchor_lang::prelude::*;

use crate::{state::Pool, utils::error::XMixErrorCode};

#[derive(Accounts)]
pub struct RotateAuthority<'info> {
  #[account(mut)]
  pub authority: Signer<'info>,

  #[account(mut)]
  pub pool: AccountLoader<'info, Pool>,
}

impl RotateAuthority<'_> {
  pub fn validate(&self, new_authority: Pubkey) -> Result<()> {
    let pool = self.pool.load()?;
    require_keys_eq!(
      self.authority.key(),
      pool.authority,
      XMixErrorCode::Unauthorized
    );
    require!(
      new_authority != Pubkey::default(),
      XMixErrorCode::InvalidAuthority
    );
    Ok(())
  }

  #[access_control(ctx.accounts.validate(new_authority))]
  pub fn rotate_authority(
    ctx: Context<RotateAuthority>,
    new_authority: Pubkey,
  ) -> Result<()> {
    let mut pool = ctx.accounts.pool.load_mut()?;
    pool.authority = new_authority;
    Ok(())
  }
}
