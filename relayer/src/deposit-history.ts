import { getDepositJobKey, getDepositRefKey } from './deposit-key.js';
import { DepositHistoryEntry, DepositJob, RelayerState } from './types.js';

function toHistoryEntry(job: DepositJob): DepositHistoryEntry | null {
  if (!job.deposit) return null;
  return {
    signature: job.signature,
    slot: job.slot,
    blockTime: job.blockTime,
    ...job.deposit,
  };
}

function sortEntries(entries: DepositHistoryEntry[]): DepositHistoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.slot !== b.slot) return a.slot - b.slot;
    if (a.instructionIndex !== b.instructionIndex) {
      return a.instructionIndex - b.instructionIndex;
    }
    return a.signature.localeCompare(b.signature);
  });
}

export function ensureDepositHistory(state: RelayerState): void {
  if (!state.depositHistoryByRef || typeof state.depositHistoryByRef !== 'object') {
    state.depositHistoryByRef = {};
  }
  if (!state.poolDepositOrder || typeof state.poolDepositOrder !== 'object') {
    state.poolDepositOrder = {};
  }

  const hasHistory = Object.keys(state.depositHistoryByRef).length > 0;
  const hasOrder = Object.keys(state.poolDepositOrder).length > 0;
  if (hasHistory && hasOrder) {
    return;
  }

  const grouped = new Map<string, DepositHistoryEntry[]>();
  if (hasHistory) {
    for (const entry of Object.values(state.depositHistoryByRef)) {
      const arr = grouped.get(entry.pool) ?? [];
      arr.push(entry);
      grouped.set(entry.pool, arr);
    }
  } else {
    for (const job of state.jobs) {
      const entry = toHistoryEntry(job);
      if (!entry) continue;
      const arr = grouped.get(entry.pool) ?? [];
      arr.push(entry);
      grouped.set(entry.pool, arr);
    }
  }

  for (const [pool, unsorted] of grouped.entries()) {
    const ordered = sortEntries(unsorted);
    const refs: string[] = [];
    for (const entry of ordered) {
      const ref = getDepositRefKey(entry.signature, entry.instructionIndex);
      state.depositHistoryByRef[ref] = entry;
      refs.push(ref);
    }
    state.poolDepositOrder[pool] = refs;
  }
}

export function getAllDepositRefs(state: RelayerState): Set<string> {
  const refs = new Set<string>(Object.keys(state.depositHistoryByRef));
  for (const job of state.jobs) {
    if (!job.deposit) continue;
    refs.add(getDepositJobKey(job));
  }
  return refs;
}

export function addDepositHistoryEntry(state: RelayerState, entry: DepositHistoryEntry): void {
  const ref = getDepositRefKey(entry.signature, entry.instructionIndex);
  if (state.depositHistoryByRef[ref]) {
    return;
  }

  state.depositHistoryByRef[ref] = entry;
  const refs = state.poolDepositOrder[entry.pool] ?? [];
  refs.push(ref);
  state.poolDepositOrder[entry.pool] = refs;
}

export function findDepositsBySignature(
  state: RelayerState,
  signature: string
): DepositHistoryEntry[] {
  const out: DepositHistoryEntry[] = [];
  for (const entry of Object.values(state.depositHistoryByRef)) {
    if (entry.signature === signature) {
      out.push(entry);
    }
  }
  return sortEntries(out);
}

export function findDepositByRef(
  state: RelayerState,
  signature: string,
  instructionIndex?: number
): DepositHistoryEntry | undefined {
  if (instructionIndex !== undefined) {
    return state.depositHistoryByRef[getDepositRefKey(signature, instructionIndex)];
  }

  const matches = findDepositsBySignature(state, signature);
  if (matches.length === 1) {
    return matches[0];
  }
  return undefined;
}

export function listPoolDeposits(state: RelayerState, pool: string): DepositHistoryEntry[] {
  const refs = state.poolDepositOrder[pool] ?? [];
  const out: DepositHistoryEntry[] = [];
  for (const ref of refs) {
    const entry = state.depositHistoryByRef[ref];
    if (entry) out.push(entry);
  }
  return out;
}

export function compactQueueJobs(state: RelayerState, maxFailedJobsRetained: number): void {
  const active: DepositJob[] = [];
  const failed: DepositJob[] = [];

  for (const job of state.jobs) {
    if (job.status === 'pending' || job.status === 'ready') {
      active.push(job);
      continue;
    }
    if (job.status === 'failed') {
      failed.push(job);
    }
  }

  failed.sort((a, b) => b.slot - a.slot);
  state.jobs = [...active, ...failed.slice(0, Math.max(0, maxFailedJobsRetained))];
}
