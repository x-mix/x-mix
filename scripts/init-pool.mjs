#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import web3 from '@solana/web3.js';

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = web3;

const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';
const DEFAULT_PROGRAM_ID = 'XmixQ4DB8MtKcEFhyjWs1gZtdaF3YDuF4ieGLJ3xotv';
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);
const INIT_POOL_DISCRIMINATOR = createHash('sha256')
  .update('global:initialize_pool')
  .digest()
  .subarray(0, 8);

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

function parsePubkey(value, fieldName) {
  try {
    return new PublicKey(String(value).trim());
  } catch {
    throw new Error(`invalid ${fieldName}: ${value}`);
  }
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

function resolveAssetType(args) {
  const raw = String(args.asset || args['asset-type'] || '').trim().toLowerCase();
  if (!raw || raw === 'sol') {
    return 0;
  }
  if (raw === 'spl' || raw === 'usdc' || raw === 'token') {
    return 1;
  }
  if (raw === '0' || raw === '1') {
    return Number(raw);
  }
  throw new Error(`unsupported asset type: ${raw} (use sol or spl)`);
}

function deriveAta(owner, mint, tokenProgram) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

async function resolveTokenProgram(connection, mint, commitment, override) {
  if (override) return parsePubkey(override, 'token program');
  const info = await connection.getAccountInfo(mint, commitment);
  if (!info) throw new Error(`mint not found: ${mint.toBase58()}`);
  if (info.owner.equals(new PublicKey(TOKEN_PROGRAM_ID))) return info.owner;
  if (info.owner.equals(new PublicKey(TOKEN_2022_PROGRAM_ID))) return info.owner;
  throw new Error(
    `unsupported mint owner: ${info.owner.toBase58()} (mint=${mint.toBase58()})`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl = String(args['rpc-url'] || process.env.RPC_URL || DEFAULT_RPC_URL).trim();
  const keypairPath = String(args.keypair || process.env.KEYPAIR_PATH || '').trim();
  const feeCollectorRaw = String(
    args['fee-collector'] || process.env.FEE_COLLECTOR || ''
  ).trim();
  const programId = parsePubkey(
    args['program-id'] || process.env.PROGRAM_ID || DEFAULT_PROGRAM_ID,
    'program id'
  );
  const assetType = resolveAssetType(args);
  const commitment = String(args.commitment || process.env.COMMITMENT || 'confirmed').trim();
  const dryRun = args['dry-run'] === true;

  if (!keypairPath) {
    throw new Error('missing keypair path: --keypair or KEYPAIR_PATH');
  }
  if (!feeCollectorRaw) {
    throw new Error('missing fee collector: --fee-collector or FEE_COLLECTOR');
  }
  const feeCollector = parsePubkey(feeCollectorRaw, 'fee collector');

  let mintRaw = args.mint || process.env.MINT;
  if (!mintRaw && assetType === 0) {
    mintRaw = WRAPPED_SOL_MINT;
  }
  if (!mintRaw) {
    throw new Error('missing mint: --mint or MINT');
  }
  const mint = parsePubkey(mintRaw, 'mint');

  const authority = readKeypair(keypairPath);
  const connection = new Connection(rpcUrl, commitment);
  const tokenProgram = await resolveTokenProgram(
    connection,
    mint,
    commitment,
    args['token-program']
  );

  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), mint.toBytes(), Uint8Array.from([assetType])],
    programId
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), pool.toBytes()],
    programId
  );
  const vaultAta = deriveAta(vault, mint, tokenProgram);

  const existingPool = await connection.getAccountInfo(pool, commitment);
  if (existingPool) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          status: 'already_initialized',
          pool: pool.toBase58(),
          vault: vault.toBase58(),
          vaultAta: vaultAta.toBase58(),
          mint: mint.toBase58(),
          assetType,
        },
        null,
        2
      )
    );
    return;
  }

  const data = Buffer.concat([INIT_POOL_DISCRIMINATOR, Buffer.from([assetType])]);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: feeCollector, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
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
        authority: authority.publicKey.toBase58(),
        feeCollector: feeCollector.toBase58(),
        mint: mint.toBase58(),
        assetType,
        pool: pool.toBase58(),
        vault: vault.toBase58(),
        vaultAta: vaultAta.toBase58(),
        tokenProgram: tokenProgram.toBase58(),
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
  console.log(`initialize pool signature: ${sig}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
