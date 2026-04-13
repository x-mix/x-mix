use anchor_lang::prelude::*;

pub mod instructions;
pub mod state;
pub mod utils;

pub use instructions::*;
pub use state::*;
pub use utils::*;

#[allow(unused_imports)]
use solana_security_txt::security_txt;

declare_id!("XmixQ4DB8MtKcEFhyjWs1gZtdaF3YDuF4ieGLJ3xotv");

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "X Mix Program",
    project_url: "https://github.com/x-mix/x-mix",
    contacts: "email:openfeel@proton.me",
    policy: "https://github.com/x-mix/x-mix",
    preferred_languages: "en",
    source_code: "https://github.com/x-mix/x-mix"
}

#[program]
mod x_mix {
  use super::*;

  pub fn initialize_pool(ctx: Context<Initialize>, asset_type: AssetType) -> Result<()> {
    Initialize::initialize(ctx, asset_type)
  }

  pub fn deposit(
    ctx: Context<Deposit>,
    amount: u64,
    commitment: [u8; 32],
    new_root: [u8; 32],
  ) -> Result<()> {
    Deposit::deposit(ctx, amount, commitment, new_root)
  }

  pub fn transfer(
    ctx: Context<Transfer>,
    proof: ProofData,
    public_inputs: [[u8; 32]; 7], // All 7 public inputs from circuit (already field-reduced)
    nullifier_hash: [u8; 32],
    relayer_fee: u64,
    recipient_amount: u64,
  ) -> Result<()> {
    Transfer::transfer(
      ctx,
      proof,
      public_inputs,
      nullifier_hash,
      relayer_fee,
      recipient_amount,
    )
  }

  pub fn update_root(ctx: Context<UpdateRoot>, root: [u8; 32]) -> Result<()> {
    UpdateRoot::update_root_history(ctx, root)
  }

  pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    Withdraw::withdraw(ctx, amount)
  }

  pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
    SetPause::set_pause(ctx, paused)
  }

  pub fn rotate_authority(
    ctx: Context<RotateAuthority>,
    new_authority: Pubkey,
  ) -> Result<()> {
    RotateAuthority::rotate_authority(ctx, new_authority)
  }
}
