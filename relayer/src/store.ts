import fs from 'node:fs/promises';
import path from 'node:path';
import { RelayerState } from './types.js';

function createDefaultState(): RelayerState {
  return {
    lastSeenSlot: 0,
    knownSignatures: [],
    jobs: [],
    depositHistoryByRef: {},
    poolDepositOrder: {},
    poolSnapshots: {},
    updatedAt: new Date().toISOString(),
  };
}

export class StateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<RelayerState> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as RelayerState;
      return {
        ...createDefaultState(),
        ...parsed,
        knownSignatures: Array.isArray(parsed.knownSignatures)
          ? parsed.knownSignatures
          : [],
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
        depositHistoryByRef:
          parsed.depositHistoryByRef && typeof parsed.depositHistoryByRef === 'object'
            ? parsed.depositHistoryByRef
            : {},
        poolDepositOrder:
          parsed.poolDepositOrder && typeof parsed.poolDepositOrder === 'object'
            ? parsed.poolDepositOrder
            : {},
        poolSnapshots:
          parsed.poolSnapshots && typeof parsed.poolSnapshots === 'object'
            ? parsed.poolSnapshots
            : {},
      };
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') {
        await this.save(createDefaultState());
        return createDefaultState();
      }
      throw error;
    }
  }

  async save(state: RelayerState): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    state.updatedAt = new Date().toISOString();

    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }
}
