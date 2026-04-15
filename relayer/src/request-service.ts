import fs from 'node:fs/promises';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  ensureDepositHistory,
  findDepositByRef,
  findDepositsBySignature,
  listPoolDeposits,
} from './deposit-history.js';
import { getDepositRefKey } from './deposit-key.js';
import {
  buildPoolMerkleContext,
  bytesToHex,
  generateCommitment,
  generateTransferProof,
  hexToBytes,
} from './proof-builder.js';
import { DepositJob, RelayRequestInput, RelayerConfig, RelayerState } from './types.js';

export interface BuildRelayRequestParams {
  state: RelayerState;
  config: RelayerConfig;
  depositSignature: string;
  depositInstructionIndex?: number;
  recipient: string;
  secretHex: string;
  nullifierHex: string;
  relayerFeeLamports?: string;
  recipientAmountLamports?: string;
  requestId?: string;
  wasmPath?: string;
  zkeyPath?: string;
  writeToQueue?: boolean;
}

export interface BuildRelayRequestResult {
  requestId: string;
  filePath?: string;
  request: RelayRequestInput;
  pool: string;
  mint: string;
  leafIndex: number;
  depositAmountLamports: string;
}

function parseLamports(raw: string, name: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${name}: must be unsigned integer`);
  }
  return BigInt(raw);
}

function parseInstructionIndex(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw < 0) {
    throw new Error('depositInstructionIndex must be a non-negative integer');
  }
  return raw;
}

async function loadKeypairFromFile(filePath: string): Promise<Keypair> {
  const raw = await fs.readFile(path.resolve(filePath), 'utf8');
  const secret = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function ensureFilePath(filePath: string, label: string): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Invalid ${label} path: ${filePath}`);
  }
}

export async function buildRelayRequestFromState(
  params: BuildRelayRequestParams
): Promise<BuildRelayRequestResult> {
  const {
    state,
    config,
    depositSignature,
    depositInstructionIndex,
    recipient,
    secretHex,
    nullifierHex,
    relayerFeeLamports = '0',
    recipientAmountLamports,
    requestId,
    wasmPath,
    zkeyPath,
    writeToQueue = true,
  } = params;

  const recipientPk = new PublicKey(recipient);
  const instructionIndex = parseInstructionIndex(depositInstructionIndex);
  ensureDepositHistory(state);

  const candidateDeposits = findDepositsBySignature(state, depositSignature);
  let targetDeposit = findDepositByRef(state, depositSignature, instructionIndex);
  if (instructionIndex === undefined && candidateDeposits.length > 1) {
    throw new Error(
      `Multiple deposits found for signature ${depositSignature}; provide depositInstructionIndex`
    );
  }

  if (!targetDeposit) {
    throw new Error(
      `Deposit not found in relayer state: ${getDepositRefKey(depositSignature, instructionIndex)}`
    );
  }

  const targetInstructionIndex = targetDeposit.instructionIndex;
  const pool = new PublicKey(targetDeposit.pool);

  const poolJobs: DepositJob[] = listPoolDeposits(state, targetDeposit.pool).map((d) => ({
    signature: d.signature,
    slot: d.slot,
    blockTime: d.blockTime,
    detectedAt: '',
    status: 'ignored',
    attempts: 0,
    deposit: {
      depositor: d.depositor,
      pool: d.pool,
      mint: d.mint,
      vault: d.vault,
      amount: d.amount,
      commitmentHex: d.commitmentHex,
      newRootHex: d.newRootHex,
      instructionIndex: d.instructionIndex,
    },
  }));
  const { targetLeafIndex, root, pathElements, pathIndices } = await buildPoolMerkleContext(
    poolJobs,
    depositSignature,
    targetInstructionIndex
  );

  const secret = hexToBytes(secretHex, 32);
  const nullifier = hexToBytes(nullifierHex, 32);

  const amount = BigInt(targetDeposit.amount);
  const computedCommitment = await generateCommitment(secret, nullifier, amount, pool);
  const computedCommitmentHex = bytesToHex(computedCommitment);

  if (computedCommitmentHex !== targetDeposit.commitmentHex) {
    throw new Error(
      `Note commitment mismatch. expected=${targetDeposit.commitmentHex} got=${computedCommitmentHex}`
    );
  }

  const fee = parseLamports(relayerFeeLamports, 'relayer-fee-lamports');
  const recipientAmount = recipientAmountLamports
    ? parseLamports(recipientAmountLamports, 'recipient-amount-lamports')
    : amount - fee;

  if (recipientAmount <= 0n) {
    throw new Error('recipient amount must be > 0');
  }

  if (fee + recipientAmount > amount) {
    throw new Error('fee + recipientAmount exceeds deposit amount');
  }

  const relayerKeypair = await loadKeypairFromFile(config.relayerKeypairPath);

  const resolvedWasmPath = path.resolve(wasmPath ?? config.circuitWasmPath);
  const resolvedZkeyPath = path.resolve(zkeyPath ?? config.circuitZkeyPath);

  await Promise.all([
    ensureFilePath(resolvedWasmPath, 'wasm'),
    ensureFilePath(resolvedZkeyPath, 'zkey'),
  ]);

  const proof = await generateTransferProof({
    secret,
    nullifier,
    amount,
    pathElements,
    pathIndices,
    recipient: recipientPk,
    relayer: relayerKeypair.publicKey,
    fee,
    recipientAmount,
    root,
    poolAddress: pool,
    wasmPath: resolvedWasmPath,
    zkeyPath: resolvedZkeyPath,
  });

  if (proof.publicInputs.length !== 7) {
    throw new Error(`Unexpected public input count: ${proof.publicInputs.length}`);
  }

  const request: RelayRequestInput = {
    depositSignature,
    depositInstructionIndex: targetInstructionIndex,
    recipient: recipientPk.toBase58(),
    nullifierHashHex: bytesToHex(proof.nullifierHash),
    proofAHex: bytesToHex(proof.proofA),
    proofBHex: bytesToHex(proof.proofB),
    proofCHex: bytesToHex(proof.proofC),
    publicInputsHex: proof.publicInputs.map(bytesToHex),
    relayerFeeLamports: fee.toString(),
    recipientAmountLamports: recipientAmount.toString(),
    pool: targetDeposit.pool,
    mint: targetDeposit.mint,
    vault: targetDeposit.vault,
  };

  const requestIdResolved =
    requestId ??
    `${depositSignature.slice(0, 16)}-ix${targetInstructionIndex}-${Date.now()}`;
  let filePath: string | undefined;

  if (writeToQueue) {
    await fs.mkdir(config.requestsPath, { recursive: true });
    filePath = path.join(config.requestsPath, `${requestIdResolved}.json`);
    await fs.writeFile(filePath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  }

  return {
    requestId: requestIdResolved,
    filePath,
    request,
    pool: targetDeposit.pool,
    mint: targetDeposit.mint,
    leafIndex: targetLeafIndex,
    depositAmountLamports: amount.toString(),
  };
}
