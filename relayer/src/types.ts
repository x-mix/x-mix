export type JobStatus = 'pending' | 'ready' | 'relayed' | 'failed' | 'ignored';

export interface DepositPayload {
  depositor: string;
  pool: string;
  mint: string;
  vault: string;
  amount: string;
  commitmentHex: string;
  newRootHex: string;
  instructionIndex: number;
}

export interface DepositJob {
  signature: string;
  slot: number;
  blockTime: number | null;
  detectedAt: string;
  status: JobStatus;
  attempts: number;
  lastError?: string;
  relayedSignature?: string;
  deposit?: DepositPayload;
}

export interface PoolSnapshot {
  mint: string;
  latestRootHex: string;
  computedRootHex?: string;
  rootMatches?: boolean;
  commitmentCount: number;
  lastDepositSignature: string;
  updatedAt: string;
}

export interface RelayRequestInput {
  depositSignature: string;
  recipient: string;
  nullifierHashHex: string;
  proofAHex: string;
  proofBHex: string;
  proofCHex: string;
  publicInputsHex: string[];
  relayerFeeLamports: string;
  recipientAmountLamports: string;
  pool?: string;
  mint?: string;
  vault?: string;
  vaultTokenAccount?: string;
  recipientTokenAccount?: string;
  feeCollectorTokenAccount?: string;
}

export interface RelayRequest {
  requestId: string;
  filePath: string;
  input: RelayRequestInput;
}

export interface RelayerState {
  lastSeenSlot: number;
  knownSignatures: string[];
  jobs: DepositJob[];
  poolSnapshots: Record<string, PoolSnapshot>;
  updatedAt: string;
}

export interface RelayerConfig {
  rpcUrl: string;
  programId: string;
  relayerKeypairPath: string;
  feeCollector: string;
  requestsPath: string;
  processedRequestsPath: string;
  failedRequestsPath: string;
  pollIntervalMs: number;
  maxSignatureScan: number;
  maxKnownSignatures: number;
  maxRelayRetries: number;
  dryRun: boolean;
  statePath: string;
}
