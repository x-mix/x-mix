import {
  Connection,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  PublicKey,
} from '@solana/web3.js';
import { Logger } from 'pino';
import { addDepositHistoryEntry, ensureDepositHistory, getAllDepositRefs } from './deposit-history.js';
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

interface SignatureMeta {
  signature: string;
  slot?: number;
  blockTime?: number | null;
}

interface TxPositionCacheEntry {
  slot: number;
  signatureToIndex: Map<string, number>;
}

interface SignatureScanResult {
  ordered: SignatureMeta[];
  pagesFetched: number;
  hitPageCap: boolean;
}

async function scanSignaturesForIndexing(
  connection: Connection,
  programId: PublicKey,
  known: Set<string>,
  config: RelayerConfig
): Promise<SignatureScanResult> {
  const collected: SignatureMeta[] = [];
  let before: string | undefined;
  let pagesFetched = 0;
  let hitPageCap = false;

  for (let page = 0; page < config.maxSignatureScanPages; page += 1) {
    const signatures = await connection.getSignaturesForAddress(
      programId,
      {
        limit: config.maxSignatureScan,
        before,
      },
      'confirmed'
    );
    if (signatures.length === 0) {
      break;
    }

    pagesFetched += 1;
    for (const sig of signatures) {
      collected.push({
        signature: sig.signature,
        slot: sig.slot,
        blockTime: sig.blockTime ?? null,
      });
    }

    const allKnown = signatures.every((sig) => known.has(sig.signature));
    if (allKnown) {
      break;
    }

    const pageFull = signatures.length === config.maxSignatureScan;
    if (!pageFull) {
      break;
    }

    if (page === config.maxSignatureScanPages - 1) {
      hitPageCap = true;
      break;
    }

    before = signatures[signatures.length - 1].signature;
  }

  return {
    ordered: collected.reverse(),
    pagesFetched,
    hitPageCap,
  };
}

async function resolveTxIndexInSlot(
  connection: Connection,
  slot: number,
  signature: string,
  cache: Map<number, TxPositionCacheEntry>
): Promise<number | undefined> {
  const cached = cache.get(slot);
  if (cached) {
    return cached.signatureToIndex.get(signature);
  }

  try {
    const block = await connection.getBlock(slot, {
      commitment: 'confirmed',
      transactionDetails: 'signatures',
      maxSupportedTransactionVersion: 0,
      rewards: false,
    });
    const txSignatures =
      ((block as unknown as { signatures?: string[] })?.signatures as string[] | undefined) ??
      [];
    const signatureToIndex = new Map<string, number>();
    for (let i = 0; i < txSignatures.length; i += 1) {
      signatureToIndex.set(txSignatures[i], i);
    }
    cache.set(slot, { slot, signatureToIndex });
    return signatureToIndex.get(signature);
  } catch {
    return undefined;
  }
}

async function indexSignature(
  connection: Connection,
  programId: PublicKey,
  sigMeta: SignatureMeta,
  state: RelayerState,
  known: Set<string>,
  existingRefs: Set<string>,
  logger: Logger,
  txPositionCache: Map<number, TxPositionCacheEntry>
): Promise<number> {
  if (known.has(sigMeta.signature)) {
    return 0;
  }

  const tx = await connection.getParsedTransaction(sigMeta.signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) {
    // Websocket callback may arrive before RPC has parsed payload;
    // polling fallback will retry this signature.
    return 0;
  }

  known.add(sigMeta.signature);

  const slot = sigMeta.slot ?? tx.slot ?? 0;
  const blockTime =
    sigMeta.blockTime !== undefined ? sigMeta.blockTime : (tx.blockTime ?? null);
  state.lastSeenSlot = Math.max(state.lastSeenSlot, slot);
  const txIndex = await resolveTxIndexInSlot(
    connection,
    slot,
    sigMeta.signature,
    txPositionCache
  );

  if (tx.meta?.err) {
    return 0;
  }

  if (!isDepositLog(tx.meta?.logMessages)) {
    return 0;
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

    const decoded = decodeDepositInstruction(ix, i, txIndex);
    if (!decoded) {
      continue;
    }

    decodedDeposits.push(decoded);
  }

  if (decodedDeposits.length === 0) {
    logger.warn(
      { signature: sigMeta.signature },
      'Deposit log detected but payload decode failed'
    );
    return 0;
  }

  let indexed = 0;
  for (const decoded of decodedDeposits) {
    const depositKey = getDepositRefKey(sigMeta.signature, decoded.instructionIndex);
    if (existingRefs.has(depositKey)) {
      continue;
    }

    const job = makeJob(sigMeta.signature, slot, blockTime, decoded);
    state.jobs.push(job);
    addDepositHistoryEntry(state, {
      signature: sigMeta.signature,
      slot,
      blockTime,
      ...decoded,
    });
    existingRefs.add(depositKey);
    indexed += 1;
    updatePoolSnapshot(state, job);

    logger.info(
      {
        signature: sigMeta.signature,
        depositKey,
        instructionIndex: decoded.instructionIndex,
        txIndex: decoded.txIndex,
        slot,
        blockTime,
        pool: decoded.pool,
        mint: decoded.mint,
        amount: decoded.amount,
        root: decoded.newRootHex,
      },
      'Indexed deposit transaction'
    );
  }

  return indexed;
}

export async function indexDeposits(
  connection: Connection,
  config: RelayerConfig,
  state: RelayerState,
  logger: Logger
): Promise<number> {
  ensureDepositHistory(state);
  const programId = new PublicKey(config.programId);

  const known = new Set(state.knownSignatures);
  const scan = await scanSignaturesForIndexing(connection, programId, known, config);
  if (scan.hitPageCap) {
    logger.warn(
      {
        maxSignatureScan: config.maxSignatureScan,
        maxSignatureScanPages: config.maxSignatureScanPages,
        pagesFetched: scan.pagesFetched,
      },
      'Signature scan hit page cap; increase MAX_SIGNATURE_SCAN_PAGES for full backfill'
    );
  }
  const existingRefs = getAllDepositRefs(state);
  const txPositionCache = new Map<number, TxPositionCacheEntry>();
  for (const job of state.jobs) {
    if (!job.deposit) continue;
    existingRefs.add(getDepositJobKey(job));
  }

  let indexed = 0;

  for (const sigInfo of scan.ordered) {
    // eslint-disable-next-line no-await-in-loop
    indexed += await indexSignature(
      connection,
      programId,
      {
        signature: sigInfo.signature,
        slot: sigInfo.slot,
        blockTime: sigInfo.blockTime ?? null,
      },
      state,
      known,
      existingRefs,
      logger,
      txPositionCache
    );
  }

  state.knownSignatures = Array.from(known).slice(-config.maxKnownSignatures);

  return indexed;
}

export async function indexDepositsBySignatures(
  connection: Connection,
  config: RelayerConfig,
  state: RelayerState,
  logger: Logger,
  signatures: string[]
): Promise<number> {
  if (signatures.length === 0) return 0;

  ensureDepositHistory(state);
  const programId = new PublicKey(config.programId);
  const known = new Set(state.knownSignatures);
  const existingRefs = getAllDepositRefs(state);
  const txPositionCache = new Map<number, TxPositionCacheEntry>();

  let indexed = 0;
  for (const signature of signatures) {
    // eslint-disable-next-line no-await-in-loop
    indexed += await indexSignature(
      connection,
      programId,
      { signature },
      state,
      known,
      existingRefs,
      logger,
      txPositionCache
    );
  }

  state.knownSignatures = Array.from(known).slice(-config.maxKnownSignatures);
  return indexed;
}
