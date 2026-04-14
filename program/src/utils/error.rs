use anchor_lang::prelude::*;

#[error_code]
pub enum XMixErrorCode {
  #[msg("Invalid proof")]
  InvalidProof,
  #[msg("Unknown merkle root")]
  UnknownRoot,
  #[msg("Invalid amount")]
  InvalidAmount,
  #[msg("Account doesn't have sufficient funds to perform this operation.")]
  InsufficientFunds,
  #[msg("Missing token account")]
  MissingTokenAccount,
  #[msg("Invalid relayer account")]
  InvalidRelayerAccount,
  #[msg("Overflow")]
  Overflow,
  #[msg("Underflow")]
  Underflow,
  #[msg("Invalid number of public inputs")]
  InvalidPublicInputs,
  #[msg("Invalid asset type deserialized")]
  InvalidAssetType,
  #[msg("Invalid merkle tree address")]
  InvalidMerkleTreeAddress,
  #[msg("Invalid merkle tree structure or out of bounds access")]
  InvalidMerkleTree,
  #[msg("Poseidon hash error")]
  PoseidonHashError,
  #[msg("Merkle tree is full")]
  MerkleTreeFull,
  #[msg("Invalid merkle proof")]
  InvalidMerkleProof,
  #[msg("Public input does not match instruction parameter")]
  PublicInputMismatch,
  #[msg("Invalid mint provided to instruction")]
  InvalidMint,
  #[msg("The deposit amount doesn't meet the required min deposit threshold!")]
  DepositTooSmall,
  #[msg("Address not allowed to perform operation!")]
  Unauthorized,
  #[msg("Invalid authority provided")]
  InvalidAuthority,
  #[msg("Pool is paused")]
  PoolPaused,
}
