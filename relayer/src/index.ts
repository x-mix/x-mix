import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { Server } from 'node:http';
import { startApiServer } from './api-server.js';
import { loadConfig } from './config.js';
import { processRelayQueue } from './engine.js';
import { indexDeposits } from './indexer.js';
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

  let apiServer: Server | undefined;

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
      lastSeenSlot: state.lastSeenSlot,
    },
    'x-mix relayer started'
  );

  let ticking = false;

  const tick = async () => {
    if (ticking) return;
    ticking = true;

    try {
      const indexed = await indexDeposits(connection, config, state, logger);
      const merkle = await rebuildMerkleSnapshots(state, logger);
      const processed = await processRelayQueue(connection, state, config, logger);

      await store.save(state);

      logger.info(
        {
          indexed,
          processed,
          queue: {
            pending: state.jobs.filter((j) => j.status === 'pending').length,
            ready: state.jobs.filter((j) => j.status === 'ready').length,
            relayed: state.jobs.filter((j) => j.status === 'relayed').length,
            failed: state.jobs.filter((j) => j.status === 'failed').length,
          },
          trackedPools: Object.keys(state.poolSnapshots).length,
          merkle,
          lastSeenSlot: state.lastSeenSlot,
        },
        'relayer tick completed'
      );
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
