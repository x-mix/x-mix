use anchor_lang::prelude::*;

// #[constant]
pub const MAX_DEPTH: u32 = 20;

#[constant]
pub const MAX_BUFFER_SIZE: u32 = 64;

#[constant]
pub const PROTOCOL_FEE_BPS: u64 = 15; // 0.15%

#[constant]
pub const MIN_SOL_DEPOSIT_AMOUNT: u64 = 50_000_000; // 0.05 SOL

// how large our circuits allow the tree to get
pub const MAX_TREE_DEPTH: u32 = 20;
pub const MAX_TREE_LEAVES: u32 = 1 << MAX_TREE_DEPTH; // 1,048,576
