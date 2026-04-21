import fs from 'node:fs/promises';
import {
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  Connection,
} from '@solana/web3.js';
import { Logger } from 'pino';
import { RelayerConfig, RelayRequest } from './types.js';

const TRANSFER_DISCRIMINATOR = Buffer.from([163, 52, 200, 231, 140, 3, 69, 186]);
const WRAPPED_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function hexToBytes(hex: string, expectedLen: number): Buffer {
  const clean = hex.toLowerCase();
  if (clean.length !== expectedLen * 2) {
    throw new Error(`hex length mismatch; expected ${expectedLen} bytes`);
  }
  if (!/^[0-9a-f]+$/.test(clean)) {
    throw new Error('hex contains non-hex chars');
  }
  return Buffer.from(clean, 'hex');
}

function u64ToLeBuffer(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function isRetryableSendError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes('Blockhash not found') ||
    msg.includes('TransactionExpiredBlockheightExceededError') ||
    msg.includes('429') ||
    msg.includes('Node is behind')
  );
}

async function loadRelayerKeypair(path: string): Promise<Keypair> {
  const raw = await fs.readFile(path, 'utf8');
  const secret = Uint8Array.from(JSON.parse(raw) as number[]);
  return Keypair.fromSecretKey(secret);
}

function buildTransferData(request: RelayRequest): Buffer {
  const input = request.input;
  const relayerFee = BigInt(input.relayerFeeLamports);
  const recipientAmount = BigInt(input.recipientAmountLamports);

  const proofA = hexToBytes(input.proofAHex, 64);
  const proofB = hexToBytes(input.proofBHex, 128);
  const proofC = hexToBytes(input.proofCHex, 64);
  const nullifierHash = hexToBytes(input.nullifierHashHex, 32);

  const publicInputs = input.publicInputsHex.map((p) => hexToBytes(p, 32));
  if (publicInputs.length !== 7) {
    throw new Error('publicInputsHex must contain 7 items');
  }

  return Buffer.concat([
    TRANSFER_DISCRIMINATOR,
    proofA,
    proofB,
    proofC,
    ...publicInputs,
    nullifierHash,
    u64ToLeBuffer(relayerFee),
    u64ToLeBuffer(recipientAmount),
  ]);
}

function deriveVault(programId: PublicKey, pool: PublicKey): PublicKey {
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), pool.toBuffer()],
    programId
  );
  return vault;
}

function deriveNullifier(programId: PublicKey, pool: PublicKey, nullifierHash: Buffer): PublicKey {
  const [nullifier] = PublicKey.findProgramAddressSync(
    [Buffer.from('nullifier'), pool.toBuffer(), nullifierHash],
    programId
  );
  return nullifier;
}

function optionalOrSentinel(address: string | undefined, sentinel: PublicKey): PublicKey {
  if (!address) return sentinel;
  return new PublicKey(address);
}

function deriveAssociatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

async function resolveTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, 'confirmed');
  if (!info) {
    throw new Error(`mint not found: ${mint.toBase58()}`);
  }
  if (info.owner.equals(TOKEN_PROGRAM_ID)) {
    return TOKEN_PROGRAM_ID;
  }
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return TOKEN_2022_PROGRAM_ID;
  }
  throw new Error(
    `unsupported mint owner: ${info.owner.toBase58()} (mint=${mint.toBase58()})`
  );
}

async function buildTransferInstruction(
  connection: Connection,
  config: RelayerConfig,
  request: RelayRequest,
  relayerPubkey: PublicKey,
  fallback: {
    pool: string;
    mint: string;
    vault: string;
  }
): Promise<TransactionInstruction> {
  const programId = new PublicKey(config.programId);
  const input = request.input;

  const pool = new PublicKey(input.pool ?? fallback.pool);
  const mint = new PublicKey(input.mint ?? fallback.mint);
  const vault = new PublicKey(input.vault ?? fallback.vault);
  const recipient = new PublicKey(input.recipient);
  const feeCollector = new PublicKey(config.feeCollector);

  const nullifierHash = hexToBytes(input.nullifierHashHex, 32);
  const nullifier = deriveNullifier(programId, pool, nullifierHash);

  // For SOL pool, optional token accounts should remain sentinel.
  const useTokenAccounts = !mint.equals(WRAPPED_SOL_MINT);
  const tokenProgram = useTokenAccounts
    ? await resolveTokenProgram(connection, mint)
    : TOKEN_PROGRAM_ID;

  const vaultTokenAccount = optionalOrSentinel(
    useTokenAccounts
      ? input.vaultTokenAccount ??
          deriveAssociatedTokenAddress(vault, mint, tokenProgram).toBase58()
      : undefined,
    programId
  );
  const recipientTokenAccount = optionalOrSentinel(
    useTokenAccounts
      ? input.recipientTokenAccount ??
          deriveAssociatedTokenAddress(recipient, mint, tokenProgram).toBase58()
      : undefined,
    programId
  );
  const feeCollectorTokenAccount = optionalOrSentinel(
    useTokenAccounts
      ? input.feeCollectorTokenAccount ??
          deriveAssociatedTokenAddress(feeCollector, mint, tokenProgram).toBase58()
      : undefined,
    programId
  );

  const keys = [
    { pubkey: relayerPubkey, isSigner: true, isWritable: true },
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: nullifier, isSigner: false, isWritable: true },
    { pubkey: recipient, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
    { pubkey: feeCollector, isSigner: false, isWritable: true },
    { pubkey: feeCollectorTokenAccount, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data: buildTransferData(request),
  });
}

export async function executeTransfer(
  connection: Connection,
  config: RelayerConfig,
  request: RelayRequest,
  fallback: {
    pool: string;
    mint: string;
    vault: string;
  },
  logger: Logger
): Promise<string> {
  const relayer = await loadRelayerKeypair(config.relayerKeypairPath);
  const instruction = await buildTransferInstruction(
    connection,
    config,
    request,
    relayer.publicKey,
    fallback
  );

  const maxAttempts = Math.max(config.maxRelayRetries, 1);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const latest = await connection.getLatestBlockhash('confirmed');

      const tx = new Transaction({
        feePayer: relayer.publicKey,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }).add(instruction);

      tx.sign(relayer);

      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      });

      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        'confirmed'
      );

      if (confirmation.value.err) {
        throw new Error(`transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      return signature;
    } catch (error) {
      lastError = error;

      if (error instanceof SendTransactionError) {
        try {
          const logs = await error.getLogs(connection);
          logger.error({ logs, attempt }, 'transfer transaction logs');
        } catch {
          // ignore log fetch failures
        }
      }

      if (attempt < maxAttempts && isRetryableSendError(error)) {
        const backoffMs = 500 * attempt;
        logger.warn(
          { attempt, backoffMs, error: error instanceof Error ? error.message : String(error) },
          'Retrying transfer after retryable error'
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      break;
    }
  }

  throw new Error(
    `transfer execution failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

export function deriveFallbackVault(pool: string, config: RelayerConfig): string {
  const programId = new PublicKey(config.programId);
  const poolKey = new PublicKey(pool);
  return deriveVault(programId, poolKey).toBase58();
}
