import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { Server } from 'node:http';
import { startApiServer } from './api-server.js';
import { loadConfig } from './config.js';
import { compactQueueJobs, ensureDepositHistory } from './deposit-history.js';
import { processRelayQueue } from './engine.js';
import { indexDeposits, indexDepositsBySignatures } from './indexer.js';
import { logger } from './logger.js';
import { rebuildMerkleSnapshots } from './merkle.js';
import { StateStore } from './store.js';
import { RelayerState } from './types.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Validate core addresses early.
  new PublicKey(config.programId);
  new PublicKey(config.feeCollector);

  const connection = new Connection(config.rpcUrl, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60_000,
  });

  const store = new StateStore(config.statePath);
  const state: RelayerState = await store.load();
  ensureDepositHistory(state);

  let apiServer: Server | undefined;
  let logSubscriptionId: number | undefined;
  const liveSignatures = new Set<string>();
  let tickCount = 0;

  const programId = new PublicKey(config.programId);
  if (config.logSubscriptionEnabled) {
    logSubscriptionId = connection.onLogs(
      programId,
      (event) => {
        if (event.err) return;
        if (!event.logs.some((line) => line.includes('Instruction: Deposit'))) return;
        if (event.signature) {
          liveSignatures.add(event.signature);
        }
      },
      'confirmed'
    );
  }

  if (config.apiEnabled) {
    apiServer = startApiServer(state, config, logger);
  }

  logger.info(
    {
      programId: config.programId,
      rpcUrl: config.rpcUrl,
      dryRun: config.dryRun,
      pollIntervalMs: config.pollIntervalMs,
      statePath: config.statePath,
      requestsPath: config.requestsPath,
      api: config.apiEnabled
        ? {
            host: config.apiHost,
            port: config.apiPort,
            corsOrigin: config.apiCorsOrigin,
          }
        : null,
      existingJobs: state.jobs.length,
      depositHistoryCount: Object.keys(state.depositHistoryByRef).length,
      lastSeenSlot: state.lastSeenSlot,
      logSubscriptionEnabled: config.logSubscriptionEnabled,
      fallbackPollEveryTicks: config.fallbackPollEveryTicks,
    },
    'x-mix relayer started'
  );

  let ticking = false;
  let lastMerkleHistoryCount = -1;
  let lastMerkleSummary = {
    pools: 0,
    matches: 0,
    mismatches: 0,
  };

  const tick = async () => {
    if (ticking) return;
    ticking = true;

    try {
      const liveBatch = Array.from(liveSignatures);
      liveSignatures.clear();

      const indexedFromLive = await indexDepositsBySignatures(
        connection,
        config,
        state,
        logger,
        liveBatch
      );
      const shouldPollFallback =
        config.fallbackPollEveryTicks <= 1 || tickCount % config.fallbackPollEveryTicks === 0;
      const indexedFromPoll = shouldPollFallback
        ? await indexDeposits(connection, config, state, logger)
        : 0;
      const indexed = indexedFromLive + indexedFromPoll;

      const processed = await processRelayQueue(connection, state, config, logger);
      compactQueueJobs(state, config.maxFailedJobsRetained);

      const historyCount = Object.keys(state.depositHistoryByRef).length;
      const shouldRebuildMerkle = indexed > 0 || historyCount !== lastMerkleHistoryCount;
      const merkle = shouldRebuildMerkle
        ? await rebuildMerkleSnapshots(state, logger)
        : lastMerkleSummary;

      if (shouldRebuildMerkle) {
        lastMerkleHistoryCount = historyCount;
        lastMerkleSummary = merkle;
      }

      await store.save(state);

      logger.info(
        {
          indexed,
          indexedFromLive,
          indexedFromPoll,
          polledThisTick: shouldPollFallback,
          processed,
          queue: {
            pending: state.jobs.filter((j) => j.status === 'pending').length,
            ready: state.jobs.filter((j) => j.status === 'ready').length,
            relayed: state.jobs.filter((j) => j.status === 'relayed').length,
            failed: state.jobs.filter((j) => j.status === 'failed').length,
          },
          depositHistoryCount: historyCount,
          trackedPools: Object.keys(state.poolSnapshots).length,
          merkle,
          merkleRebuilt: shouldRebuildMerkle,
          lastSeenSlot: state.lastSeenSlot,
        },
        'relayer tick completed'
      );
      tickCount += 1;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.stack : String(error) },
        'relayer tick failed'
      );
    } finally {
      ticking = false;
    }
  };

  await tick();
  const timer = setInterval(() => {
    void tick();
  }, config.pollIntervalMs);

  const shutdown = async (signal: NodeJS.Signals) => {
    clearInterval(timer);
    logger.info({ signal }, 'shutting down relayer');

    if (apiServer) {
      await new Promise<void>((resolve) => {
        apiServer?.close(() => resolve());
      });
    }
    if (logSubscriptionId !== undefined) {
      try {
        await connection.removeOnLogsListener(logSubscriptionId);
      } catch {
        // ignore
      }
    }

    await store.save(state);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

void main();
