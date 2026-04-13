import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { loadConfig } from './config.js';
import {
  buildPoolMerkleContext,
  bytesToHex,
  generateCommitment,
  generateTransferProof,
  hexToBytes,
} from './proof-builder.js';
import { StateStore } from './store.js';
import { RelayRequestInput } from './types.js';

type CliArgs = {
  depositSignature?: string;
  recipient?: string;
  secretHex?: string;
  nullifierHex?: string;
  relayerFeeLamports?: string;
  recipientAmountLamports?: string;
  requestId?: string;
  wasmPath?: string;
  zkeyPath?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) continue;

    i += 1;

    switch (key) {
      case 'deposit-signature':
        out.depositSignature = value;
        break;
      case 'recipient':
        out.recipient = value;
        break;
      case 'secret-hex':
        out.secretHex = value;
        break;
      case 'nullifier-hex':
        out.nullifierHex = value;
        break;
      case 'relayer-fee-lamports':
        out.relayerFeeLamports = value;
        break;
      case 'recipient-amount-lamports':
        out.recipientAmountLamports = value;
        break;
      case 'request-id':
        out.requestId = value;
        break;
      case 'wasm-path':
        out.wasmPath = value;
        break;
      case 'zkey-path':
        out.zkeyPath = value;
        break;
      default:
        break;
    }
  }

  return out;
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required argument: --${name}`);
  }
  return value;
}

function parseLamports(raw: string, name: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${name}: must be unsigned integer`);
  }
  return BigInt(raw);
}

async function loadKeypairFromFile(filePath: string): Promise<Keypair> {
  const raw = await fs.readFile(path.resolve(filePath), 'utf8');
  const secret = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function defaultCircuitPaths(repoRoot: string): { wasmPath: string; zkeyPath: string } {
  return {
    wasmPath: path.join(repoRoot, 'circuits/build/transaction_js/transaction.wasm'),
    zkeyPath: path.join(repoRoot, 'circuits/transaction_0001.zkey'),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2));

  const depositSignature = requireArg(args.depositSignature, 'deposit-signature');
  const recipientRaw = requireArg(args.recipient, 'recipient');
  const secretHex = requireArg(args.secretHex, 'secret-hex');
  const nullifierHex = requireArg(args.nullifierHex, 'nullifier-hex');

  const recipient = new PublicKey(recipientRaw);

  const store = new StateStore(config.statePath);
  const state = await store.load();

  const targetJob = state.jobs.find(
    (job) => job.signature === depositSignature && job.deposit
  );

  if (!targetJob || !targetJob.deposit) {
    throw new Error(`Deposit not found in relayer state: ${depositSignature}`);
  }

  const pool = new PublicKey(targetJob.deposit.pool);

  const poolJobs = state.jobs.filter((job) => job.deposit?.pool === targetJob.deposit!.pool);
  const { targetLeafIndex, root, pathElements, pathIndices } = await buildPoolMerkleContext(
    poolJobs,
    depositSignature
  );

  const secret = hexToBytes(secretHex, 32);
  const nullifier = hexToBytes(nullifierHex, 32);

  const amount = BigInt(targetJob.deposit.amount);
  const computedCommitment = await generateCommitment(secret, nullifier, amount, pool);
  const computedCommitmentHex = bytesToHex(computedCommitment);

  if (computedCommitmentHex !== targetJob.deposit.commitmentHex) {
    throw new Error(
      `Note commitment mismatch. expected=${targetJob.deposit.commitmentHex} got=${computedCommitmentHex}`
    );
  }

  const fee = parseLamports(args.relayerFeeLamports ?? '0', 'relayer-fee-lamports');
  const recipientAmount = args.recipientAmountLamports
    ? parseLamports(args.recipientAmountLamports, 'recipient-amount-lamports')
    : amount - fee;

  if (recipientAmount <= 0n) {
    throw new Error('recipient amount must be > 0');
  }

  if (fee + recipientAmount > amount) {
    throw new Error('fee + recipientAmount exceeds deposit amount');
  }

  const relayerKeypair = await loadKeypairFromFile(config.relayerKeypairPath);

  const repoRoot = path.resolve(process.cwd(), '..');
  const defaults = defaultCircuitPaths(repoRoot);
  const wasmPath = path.resolve(args.wasmPath ?? defaults.wasmPath);
  const zkeyPath = path.resolve(args.zkeyPath ?? defaults.zkeyPath);

  const [wasmStat, zkeyStat] = await Promise.all([fs.stat(wasmPath), fs.stat(zkeyPath)]);
  if (!wasmStat.isFile()) {
    throw new Error(`Invalid wasm path: ${wasmPath}`);
  }
  if (!zkeyStat.isFile()) {
    throw new Error(`Invalid zkey path: ${zkeyPath}`);
  }

  const proof = await generateTransferProof({
    secret,
    nullifier,
    amount,
    pathElements,
    pathIndices,
    recipient,
    relayer: relayerKeypair.publicKey,
    fee,
    recipientAmount,
    root,
    poolAddress: pool,
    wasmPath,
    zkeyPath,
  });

  if (proof.publicInputs.length !== 7) {
    throw new Error(`Unexpected public input count: ${proof.publicInputs.length}`);
  }

  const request: RelayRequestInput = {
    depositSignature,
    recipient: recipient.toBase58(),
    nullifierHashHex: bytesToHex(proof.nullifierHash),
    proofAHex: bytesToHex(proof.proofA),
    proofBHex: bytesToHex(proof.proofB),
    proofCHex: bytesToHex(proof.proofC),
    publicInputsHex: proof.publicInputs.map(bytesToHex),
    relayerFeeLamports: fee.toString(),
    recipientAmountLamports: recipientAmount.toString(),
    pool: targetJob.deposit.pool,
    mint: targetJob.deposit.mint,
    vault: targetJob.deposit.vault,
  };

  const requestId = args.requestId ?? `${depositSignature.slice(0, 16)}-${Date.now()}`;
  await fs.mkdir(config.requestsPath, { recursive: true });

  const filePath = path.join(config.requestsPath, `${requestId}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');

  console.log('relay request written:', filePath);
  console.log('deposit signature:', depositSignature);
  console.log('pool:', targetJob.deposit.pool);
  console.log('leaf index:', targetLeafIndex);
  console.log('relayer fee:', fee.toString());
  console.log('recipient amount:', recipientAmount.toString());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
