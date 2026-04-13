import { Account } from '@solana/web3.js';
import test from 'ava';
import {
  AssetType,
  fetchPool,
  findPoolAddress,
  findVaultAddress,
  MerkleTree,
  Pool,
} from '../src';
import { LAMPORTS_PER_SOL, WRAPPED_SOL_MINT_TOKEN_PROGRAM } from './_constants';
import {
  createDefaultSolanaClient,
  createPoolForAuthority,
  depositForAuthority,
  getBalance,
} from './_setup';

test('it deposits into SOL pool for authority', async (t) => {
  const client = createDefaultSolanaClient();

  // _ since we are doing sol, we hardcode the assetType as such
  const ASSET_TYPE = AssetType.Sol;
  // find pool address
  const [pool] = await findPoolAddress({
    mint: WRAPPED_SOL_MINT_TOKEN_PROGRAM,
    assetType: ASSET_TYPE,
  });

  const merkleTree = new MerkleTree(20);
  await merkleTree.initialize();

  // create pool
  const { authority } = await createPoolForAuthority(
    client,
    WRAPPED_SOL_MINT_TOKEN_PROGRAM,
    AssetType.Sol
  );

  // find vault address
  const [vault] = await findVaultAddress({ pool });

  // deposit
  const amount = BigInt(10) * LAMPORTS_PER_SOL;
  console.log(' amount', amount); // ! debug

  const { depositor } = await depositForAuthority(client, {
    amount,
    merkleTree,
    mint: WRAPPED_SOL_MINT_TOKEN_PROGRAM,
    pool,
  });
  console.log('depositor ->', depositor); // ! debug
  // commitment already inserted into merkle tree by depositForAuthority
  console.log('merkle tree', merkleTree.root()); // ! debug

  // check pool balance, since this is sol and not wrapped, check vault directly
  const bal = await getBalance(client, vault);
  console.log('the balance', bal); //! debug
  t.truthy(BigInt(bal) >= amount);

  t.like(await fetchPool(client.rpc, pool), <Account<Pool>>{
    data: {
      authority,
      // todo add missing fields later
    },
  });
});
