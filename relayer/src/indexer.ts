import {
  Connection,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  PublicKey,
} from '@solana/web3.js';
import { Logger } from 'pino';
import { getDepositJobKey, getDepositRefKey } from './deposit-key.js';
import { decodeDepositInstruction } from './deposit-decoder.js';
import { DepositJob, DepositPayload, RelayerConfig, RelayerState } from './types.js';

function isDepositLog(logs: string[] | null | undefined): boolean {
  if (!logs || logs.length === 0) return false;
  return logs.some((line) => line.includes('Instruction: Deposit'));
}

function isPartiallyDecodedInstruction(
  ix: ParsedInstruction | PartiallyDecodedInstruction
): ix is PartiallyDecodedInstruction {
  return 'data' in ix;
}

function makeJob(
  signature: string,
  slot: number,
  blockTime: number | null,
  deposit: DepositPayload
): DepositJob {
  return {
    signature,
    slot,
    blockTime,
    detectedAt: new Date().toISOString(),
    status: 'pending',
    attempts: 0,
    deposit,
  };
}

function updatePoolSnapshot(state: RelayerState, job: DepositJob): void {
  if (!job.deposit) return;

  const pool = job.deposit.pool;
  const existing = state.poolSnapshots[pool];

  state.poolSnapshots[pool] = {
    mint: job.deposit.mint,
    latestRootHex: job.deposit.newRootHex,
    commitmentCount: (existing?.commitmentCount ?? 0) + 1,
    lastDepositSignature: job.signature,
    updatedAt: new Date().toISOString(),
  };
}

export async function indexDeposits(
  connection: Connection,
  config: RelayerConfig,
  state: RelayerState,
  logger: Logger
): Promise<number> {
  const programId = new PublicKey(config.programId);

  const signatures = await connection.getSignaturesForAddress(
    programId,
    { limit: config.maxSignatureScan },
    'confirmed'
  );

  signatures.sort((a, b) => a.slot - b.slot);

  const known = new Set(state.knownSignatures);
  const existingJobs = new Set(state.jobs.map((job) => getDepositJobKey(job)));

  let indexed = 0;

  for (const sigInfo of signatures) {
    state.lastSeenSlot = Math.max(state.lastSeenSlot, sigInfo.slot);

    if (known.has(sigInfo.signature)) {
      continue;
    }

    known.add(sigInfo.signature);

    const tx = await connection.getParsedTransaction(sigInfo.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || tx.meta?.err) {
      continue;
    }

    if (!isDepositLog(tx.meta?.logMessages)) {
      continue;
    }

    const decodedDeposits: DepositPayload[] = [];
    for (let i = 0; i < tx.transaction.message.instructions.length; i++) {
      const ix = tx.transaction.message.instructions[i];
      if (!isPartiallyDecodedInstruction(ix)) {
        continue;
      }

      if (!ix.programId.equals(programId)) {
        continue;
      }

      const decoded = decodeDepositInstruction(ix, i);
      if (!decoded) {
        continue;
      }

      decodedDeposits.push(decoded);
    }

    if (decodedDeposits.length === 0) {
      // Keep this trace so we can inspect edge cases where logs say deposit
      // but the instruction payload could not be decoded.
      logger.warn(
        { signature: sigInfo.signature },
        'Deposit log detected but payload decode failed'
      );
      continue;
    }

    for (const decoded of decodedDeposits) {
      const depositKey = getDepositRefKey(sigInfo.signature, decoded.instructionIndex);
      if (existingJobs.has(depositKey)) {
        continue;
      }

      const job = makeJob(sigInfo.signature, sigInfo.slot, sigInfo.blockTime ?? null, decoded);
      state.jobs.push(job);
      existingJobs.add(depositKey);
      updatePoolSnapshot(state, job);
      indexed += 1;

      logger.info(
        {
          signature: sigInfo.signature,
          depositKey,
          instructionIndex: decoded.instructionIndex,
          slot: sigInfo.slot,
          blockTime: sigInfo.blockTime,
          pool: decoded.pool,
          mint: decoded.mint,
          amount: decoded.amount,
          root: decoded.newRootHex,
        },
        'Indexed deposit transaction'
      );
    }
  }

  state.knownSignatures = Array.from(known).slice(-config.maxKnownSignatures);

  return indexed;
}
