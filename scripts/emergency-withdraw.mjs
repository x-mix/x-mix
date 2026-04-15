#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

const DEFAULT_PROGRAM_ID = 'XmixQ4DB8MtKcEFhyjWs1gZtdaF3YDuF4ieGLJ3xotv';
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';
const DEFAULT_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const WITHDRAW_DISCRIMINATOR = Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]);
const VAULT_ACCOUNT_LEN = 8 + 128;
const U64_MAX = (1n << 64n) - 1n;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function readKeypair(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  const secret = JSON.parse(raw);
  if (!Array.isArray(secret)) {
    throw new Error(`invalid keypair json: ${abs}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function parsePubkey(value, fieldName) {
  try {
    return new PublicKey(String(value).trim());
  } catch {
    throw new Error(`invalid ${fieldName}: ${value}`);
  }
}

function parseDecimalToRaw(input, decimals) {
  const value = String(input ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`invalid decimal amount: ${input}`);
  }

  const [wholeRaw, fractionRaw = ''] = value.split('.');
  if (fractionRaw.length > decimals) {
    throw new Error(`too many decimal places: got ${fractionRaw.length}, max ${decimals}`);
  }

  const whole = BigInt(wholeRaw || '0');
  const fraction = BigInt((fractionRaw + '0'.repeat(decimals)).slice(0, decimals) || '0');
  const base = 10n ** BigInt(decimals);
  return whole * base + fraction;
}

function parsePoolState(data) {
  if (!data || data.length < 2160) {
    throw new Error(`invalid pool account data length: ${data?.length ?? 0}`);
  }

  const authority = new PublicKey(data.subarray(8, 40));
  const mint = new PublicKey(data.subarray(40, 72));
  const vault = new PublicKey(data.subarray(72, 104));
  const assetType = data.readUInt8(2156);
  const paused = data.readUInt8(2159) !== 0;

  return { authority, mint, vault, assetType, paused };
}

async function resolveTokenProgram(connection, mint, override, commitment) {
  if (override) {
    return parsePubkey(override, 'token program');
  }

  const info = await connection.getAccountInfo(mint, commitment);
  if (!info) {
    throw new Error(`mint not found: ${mint.toBase58()}`);
  }

  if (
    info.owner.toBase58() === DEFAULT_TOKEN_PROGRAM ||
    info.owner.toBase58() === TOKEN_2022_PROGRAM
  ) {
    return info.owner;
  }

  throw new Error(
    `unsupported mint owner: ${info.owner.toBase58()} (mint=${mint.toBase58()})`
  );
}

function deriveAta(owner, mint, tokenProgram) {
  const ataProgram = new PublicKey(ASSOCIATED_TOKEN_PROGRAM);
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ataProgram
  );
  return ata;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.log(
      'Usage: node scripts/emergency-withdraw.mjs --pool <POOL> [--amount-lamports <LAMPORTS>|--amount-sol <SOL>|--amount-ui <UI>] [--mint <MINT>] [--vault <VAULT>] [--program-id <PROGRAM_ID>] [--keypair <KEYPAIR_PATH>] [--rpc-url <RPC_URL>] [--commitment confirmed] [--token-program <TOKEN_PROGRAM_ID>] [--authority-token-account <ATA>] [--dry-run]'
    );
    process.exit(0);
  }

  const rpcUrl =
    String(args['rpc-url'] || args.rpc || process.env.RPC_URL || DEFAULT_RPC_URL).trim();
  const keypairPath = String(args.keypair || process.env.KEYPAIR_PATH || '').trim();
  const poolInput = String(args.pool || process.env.POOL || '').trim();
  const programId = parsePubkey(args['program-id'] || process.env.PROGRAM_ID || DEFAULT_PROGRAM_ID, 'program id');
  const commitment = String(args.commitment || process.env.COMMITMENT || 'confirmed').trim();
  const dryRun = args['dry-run'] === true;

  if (!keypairPath) throw new Error('missing keypair path: --keypair or KEYPAIR_PATH');
  if (!poolInput) throw new Error('missing pool: --pool or POOL');

  const authority = readKeypair(keypairPath);
  const pool = parsePubkey(poolInput, 'pool');
  const connection = new Connection(rpcUrl, commitment);

  const poolAcc = await connection.getAccountInfo(pool, commitment);
  if (!poolAcc) throw new Error(`pool not found: ${pool.toBase58()}`);

  const poolState = parsePoolState(poolAcc.data);
  if (!poolState.authority.equals(authority.publicKey)) {
    throw new Error(
      `authority mismatch: onchain=${poolState.authority.toBase58()} signer=${authority.publicKey.toBase58()}`
    );
  }
  if (poolState.paused) {
    throw new Error('pool is paused; withdraw is blocked by program validation');
  }

  const mint = args.mint
    ? parsePubkey(args.mint, 'mint')
    : poolState.mint;
  if (!mint.equals(poolState.mint)) {
    throw new Error(`mint mismatch: onchain=${poolState.mint.toBase58()} input=${mint.toBase58()}`);
  }

  const vault = args.vault
    ? parsePubkey(args.vault, 'vault')
    : poolState.vault;
  if (!vault.equals(poolState.vault)) {
    throw new Error(`vault mismatch: onchain=${poolState.vault.toBase58()} input=${vault.toBase58()}`);
  }

  const [expectedVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), pool.toBuffer()],
    programId
  );
  if (!vault.equals(expectedVault)) {
    throw new Error(`vault PDA mismatch: expected=${expectedVault.toBase58()} got=${vault.toBase58()}`);
  }

  const tokenProgram = await resolveTokenProgram(connection, mint, args['token-program'], commitment);
  const vaultAta = deriveAta(vault, mint, tokenProgram);

  let amount;
  if (args['amount-lamports'] || args.amount) {
    amount = BigInt(String(args['amount-lamports'] || args.amount));
  } else if (args['amount-sol']) {
    amount = parseDecimalToRaw(String(args['amount-sol']), 9);
  } else if (args['amount-ui']) {
    const mintAcc = await connection.getParsedAccountInfo(mint, commitment);
    const parsed = mintAcc.value?.data;
    const decimals =
      parsed && typeof parsed === 'object' && 'parsed' in parsed
        ? Number(parsed.parsed?.info?.decimals ?? NaN)
        : NaN;
    if (!Number.isFinite(decimals) || decimals < 0) {
      throw new Error('failed to resolve mint decimals for --amount-ui');
    }
    amount = parseDecimalToRaw(String(args['amount-ui']), decimals);
  } else {
    throw new Error('missing amount: use --amount-lamports, --amount-sol, or --amount-ui');
  }

  if (amount <= 0n) throw new Error('amount must be > 0');
  if (amount > U64_MAX) throw new Error('amount exceeds u64 max');

  let authorityTokenAccount = null;

  if (poolState.assetType === 0) {
    const vaultInfo = await connection.getAccountInfo(vault, commitment);
    if (!vaultInfo) throw new Error(`vault not found: ${vault.toBase58()}`);

    const minRent = BigInt(await connection.getMinimumBalanceForRentExemption(VAULT_ACCOUNT_LEN, commitment));
    const vaultLamports = BigInt(vaultInfo.lamports);
    const maxWithdrawable = vaultLamports > minRent ? vaultLamports - minRent : 0n;
    if (amount > maxWithdrawable) {
      throw new Error(
        `insufficient withdrawable SOL in vault: requested=${amount} max=${maxWithdrawable} lamports`
      );
    }

    authorityTokenAccount = args['authority-token-account']
      ? parsePubkey(args['authority-token-account'], 'authority token account')
      : programId;
  } else if (poolState.assetType === 1) {
    authorityTokenAccount = args['authority-token-account']
      ? parsePubkey(args['authority-token-account'], 'authority token account')
      : deriveAta(authority.publicKey, mint, tokenProgram);

    const vaultAtaBalance = await connection.getTokenAccountBalance(vaultAta, commitment).catch(() => null);
    if (!vaultAtaBalance?.value?.amount) {
      throw new Error(`vault ATA missing or unreadable: ${vaultAta.toBase58()}`);
    }
    const available = BigInt(vaultAtaBalance.value.amount);
    if (amount > available) {
      throw new Error(`insufficient token balance in vault ATA: requested=${amount} available=${available}`);
    }
  } else {
    throw new Error(`unsupported asset type: ${poolState.assetType}`);
  }

  const data = Buffer.alloc(16);
  WITHDRAW_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: false },
      { pubkey: authorityTokenAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(ASSOCIATED_TOKEN_PROGRAM), isSigner: false, isWritable: false },
    ],
    data,
  });

  console.log(
    JSON.stringify(
      {
        rpcUrl,
        commitment,
        dryRun,
        programId: programId.toBase58(),
        pool: pool.toBase58(),
        vault: vault.toBase58(),
        mint: mint.toBase58(),
        tokenProgram: tokenProgram.toBase58(),
        vaultAta: vaultAta.toBase58(),
        authority: authority.publicKey.toBase58(),
        authorityTokenAccount: authorityTokenAccount.toBase58(),
        assetType: poolState.assetType === 0 ? 'sol' : 'spl',
        amountLamportsOrRaw: amount.toString(),
      },
      null,
      2
    )
  );

  if (dryRun) {
    console.log('dry-run enabled, transaction not sent');
    return;
  }

  const latest = await connection.getLatestBlockhash(commitment);
  const tx = new Transaction({
    feePayer: authority.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(ix);

  tx.sign(authority);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    commitment
  );

  console.log(`withdraw signature: ${sig}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
