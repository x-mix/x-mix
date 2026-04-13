import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from 'https://esm.sh/@solana/web3.js@1.98.4';
import bs58 from 'https://esm.sh/bs58@6.0.0';
import { buildPoseidon } from 'https://esm.sh/circomlibjs@0.1.7';

const DEFAULT_RPC =
  'https://solana-mainnet.core.chainstack.com/2cd2b649ac769bded1318e8af2508268';
const DEFAULT_PROGRAM_ID = 'XmixQ4DB8MtKcEFhyjWs1gZtdaF3YDuF4ieGLJ3xotv';
const DEFAULT_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_RELAYER_API = 'http://127.0.0.1:8787';

const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);

const DEPOSIT_DISCRIMINATOR = Uint8Array.from([
  242, 35, 198, 137, 82, 225, 242, 182,
]);
const SNARK_FIELD_SIZE = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);
const TREE_LEVELS = 20;

const els = {
  rpcUrl: document.getElementById('rpcUrl'),
  programId: document.getElementById('programId'),
  mint: document.getElementById('mint'),
  assetType: document.getElementById('assetType'),
  pool: document.getElementById('pool'),
  vault: document.getElementById('vault'),
  amountSol: document.getElementById('amountSol'),
  scanLimit: document.getElementById('scanLimit'),
  autoRoot: document.getElementById('autoRoot'),
  walletStatus: document.getElementById('walletStatus'),
  connectBtn: document.getElementById('connectBtn'),
  deriveBtn: document.getElementById('deriveBtn'),
  depositBtn: document.getElementById('depositBtn'),
  relayerApiUrl: document.getElementById('relayerApiUrl'),
  withdrawRecipient: document.getElementById('withdrawRecipient'),
  relayerFeeLamports: document.getElementById('relayerFeeLamports'),
  recipientAmountLamports: document.getElementById('recipientAmountLamports'),
  fillRecipientBtn: document.getElementById('fillRecipientBtn'),
  buildWithdrawRequestBtn: document.getElementById('buildWithdrawRequestBtn'),
  requestIdResult: document.getElementById('requestIdResult'),
  requestFileResult: document.getElementById('requestFileResult'),
  signature: document.getElementById('signature'),
  solscanLink: document.getElementById('solscanLink'),
  note: document.getElementById('note'),
  copyNoteBtn: document.getElementById('copyNoteBtn'),
  downloadNoteBtn: document.getElementById('downloadNoteBtn'),
  logBox: document.getElementById('logBox'),
};

let provider = null;
let poseidonPromise = null;
let latestNote = null;

boot();

function boot() {
  els.rpcUrl.value = DEFAULT_RPC;
  els.programId.value = DEFAULT_PROGRAM_ID;
  els.mint.value = DEFAULT_MINT;
  els.relayerApiUrl.value = DEFAULT_RELAYER_API;

  els.connectBtn.addEventListener('click', onConnectWallet);
  els.deriveBtn.addEventListener('click', onDerivePdas);
  els.depositBtn.addEventListener('click', onDeposit);
  els.fillRecipientBtn.addEventListener('click', onFillRecipient);
  els.buildWithdrawRequestBtn.addEventListener('click', onBuildWithdrawRequest);
  els.copyNoteBtn.addEventListener('click', onCopyNote);
  els.downloadNoteBtn.addEventListener('click', onDownloadNote);

  provider = getWalletProvider();
  if (!provider) {
    log('未检测到 Solana 钱包扩展，请安装 Phantom。', 'warn');
  }
}

function getWalletProvider() {
  if (window?.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window?.solana?.isPhantom) return window.solana;
  return null;
}

function log(message, level = 'info') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const prefix = level === 'error' ? '[ERR]' : level === 'warn' ? '[WARN]' : '[INFO]';
  els.logBox.textContent = `${prefix} ${ts} ${message}\n${els.logBox.textContent}`;
}

function setBusy(isBusy) {
  els.depositBtn.disabled = isBusy;
  els.deriveBtn.disabled = isBusy;
  els.connectBtn.disabled = isBusy;
  els.fillRecipientBtn.disabled = isBusy;
  els.buildWithdrawRequestBtn.disabled = isBusy;
}

async function onConnectWallet() {
  try {
    if (!provider) {
      throw new Error('未检测到 Phantom');
    }

    await provider.connect();

    const address = provider.publicKey.toBase58();
    const connection = getConnection();
    const bal = await connection.getBalance(provider.publicKey, 'confirmed');
    const sol = Number(bal) / LAMPORTS_PER_SOL;

    els.walletStatus.textContent = `${address} | ${sol.toFixed(4)} SOL`;
    if (!els.withdrawRecipient.value.trim()) {
      els.withdrawRecipient.value = address;
    }
    log(`钱包已连接: ${address}`);
  } catch (error) {
    log(error.message ?? String(error), 'error');
  }
}

function getConnection() {
  return new Connection(els.rpcUrl.value.trim(), 'confirmed');
}

function getProgramId() {
  return new PublicKey(els.programId.value.trim());
}

function getAssetTypeByte() {
  return Number(els.assetType.value);
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

function random32Bytes() {
  const out = new Uint8Array(32);
  crypto.getRandomValues(out);
  return out;
}

function bytesToBigInt(bytes) {
  let result = 0n;
  for (const b of bytes) {
    result = (result << 8n) | BigInt(b);
  }
  return result;
}

function bigIntToBytes(value) {
  const out = new Uint8Array(32);
  let temp = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return out;
}

async function getPoseidon() {
  if (!poseidonPromise) {
    poseidonPromise = buildPoseidon();
  }
  return poseidonPromise;
}

async function poseidonHash(inputs) {
  const poseidon = await getPoseidon();
  const fieldInputs = inputs.map((bytes) => bytesToBigInt(bytes) % SNARK_FIELD_SIZE);
  const hash = poseidon(fieldInputs);
  const asBigInt = BigInt(poseidon.F.toObject(hash));
  return bigIntToBytes(asBigInt);
}

async function poseidonPair(left, right) {
  return poseidonHash([left, right]);
}

async function generateCommitment(secret, nullifier, amountLamports, poolPk) {
  const amountBytes = bigIntToBytes(amountLamports);
  return poseidonHash([secret, nullifier, amountBytes, poolPk.toBytes()]);
}

async function buildZeroTree() {
  const zeros = [new Uint8Array(32)];
  for (let i = 1; i <= TREE_LEVELS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    zeros[i] = await poseidonPair(zeros[i - 1], zeros[i - 1]);
  }
  return zeros;
}

async function computeMerkleRoot(commitments) {
  const zeros = await buildZeroTree();
  if (commitments.length === 0) {
    return zeros[TREE_LEVELS];
  }

  let level = [...commitments];
  for (let i = 0; i < TREE_LEVELS; i += 1) {
    const next = [];
    for (let j = 0; j < level.length; j += 2) {
      const left = level[j];
      const right = j + 1 < level.length ? level[j + 1] : zeros[i];
      // eslint-disable-next-line no-await-in-loop
      next.push(await poseidonPair(left, right));
    }
    level = next;
  }

  return level[0];
}

function parseSolToLamports(raw) {
  const value = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error('存款金额格式错误');
  }

  const [whole, fracRaw = ''] = value.split('.');
  const frac = (fracRaw + '000000000').slice(0, 9);
  return BigInt(whole) * 1_000_000_000n + BigInt(frac);
}

function encodeDepositData(amountLamports, commitment, newRoot) {
  const data = new Uint8Array(80);
  data.set(DEPOSIT_DISCRIMINATOR, 0);

  let temp = amountLamports;
  for (let i = 0; i < 8; i += 1) {
    data[8 + i] = Number(temp & 0xffn);
    temp >>= 8n;
  }

  data.set(commitment, 16);
  data.set(newRoot, 48);
  return data;
}

function parseDepositCommitment(ix) {
  if (!('data' in ix)) return null;

  let raw;
  try {
    raw = bs58.decode(ix.data);
  } catch {
    return null;
  }

  if (raw.length < 80) return null;
  for (let i = 0; i < 8; i += 1) {
    if (raw[i] !== DEPOSIT_DISCRIMINATOR[i]) {
      return null;
    }
  }

  return raw.slice(16, 48);
}

async function fetchPoolCommitments(connection, programId, poolPk, scanLimit) {
  const signatures = await connection.getSignaturesForAddress(
    programId,
    { limit: scanLimit },
    'confirmed'
  );

  signatures.sort((a, b) => a.slot - b.slot);

  const commitments = [];

  for (const sig of signatures) {
    // eslint-disable-next-line no-await-in-loop
    const tx = await connection.getParsedTransaction(sig.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || tx.meta?.err) continue;

    const logs = tx.meta?.logMessages ?? [];
    if (!logs.some((line) => line.includes('Instruction: Deposit'))) {
      continue;
    }

    for (const ix of tx.transaction.message.instructions) {
      if (!('programId' in ix) || !ix.programId.equals(programId)) continue;
      if (!('accounts' in ix) || ix.accounts.length < 2) continue;
      if (ix.accounts[1].toBase58() !== poolPk.toBase58()) continue;

      const commitment = parseDepositCommitment(ix);
      if (commitment) {
        commitments.push(commitment);
      }
    }
  }

  return commitments;
}

function derivePoolAndVault(programId, mintPk, assetTypeByte) {
  const [pool] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode('pool'),
      mintPk.toBytes(),
      Uint8Array.from([assetTypeByte]),
    ],
    programId
  );

  const [vault] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('vault'), pool.toBytes()],
    programId
  );

  return { pool, vault };
}

async function onDerivePdas() {
  try {
    const programId = getProgramId();
    const mintPk = new PublicKey(els.mint.value.trim());
    const { pool, vault } = derivePoolAndVault(programId, mintPk, getAssetTypeByte());

    els.pool.value = pool.toBase58();
    els.vault.value = vault.toBase58();

    log(`已推导 Pool: ${pool.toBase58()}`);
    log(`已推导 Vault: ${vault.toBase58()}`);
  } catch (error) {
    log(error.message ?? String(error), 'error');
  }
}

async function onDeposit() {
  if (!provider?.publicKey) {
    log('请先连接钱包。', 'warn');
    return;
  }

  try {
    setBusy(true);

    const connection = getConnection();
    const programId = getProgramId();
    const mintPk = new PublicKey(els.mint.value.trim());
    const assetTypeByte = getAssetTypeByte();

    if (assetTypeByte !== 0) {
      throw new Error('当前页面仅支持 SOL 池');
    }

    let poolPk;
    let vaultPk;

    if (els.pool.value.trim() && els.vault.value.trim()) {
      poolPk = new PublicKey(els.pool.value.trim());
      vaultPk = new PublicKey(els.vault.value.trim());
    } else {
      const derived = derivePoolAndVault(programId, mintPk, assetTypeByte);
      poolPk = derived.pool;
      vaultPk = derived.vault;
      els.pool.value = poolPk.toBase58();
      els.vault.value = vaultPk.toBase58();
    }

    const amountLamports = parseSolToLamports(els.amountSol.value);
    if (amountLamports <= 0n) {
      throw new Error('存款金额必须大于 0');
    }

    log('生成 note 秘密参数...');
    const secret = random32Bytes();
    const nullifier = random32Bytes();
    const commitment = await generateCommitment(secret, nullifier, amountLamports, poolPk);

    let newRoot;
    const scanLimit = Number(els.scanLimit.value || '120');

    if (els.autoRoot.checked) {
      log(`扫描链上历史 Deposit（limit=${scanLimit}）...`);
      const oldCommitments = await fetchPoolCommitments(
        connection,
        programId,
        poolPk,
        Number.isFinite(scanLimit) ? scanLimit : 120
      );

      log(`已抓取 ${oldCommitments.length} 条历史 commitment`);
      newRoot = await computeMerkleRoot([...oldCommitments, commitment]);
    } else {
      newRoot = commitment;
      log('未启用自动 root，new_root 已临时设置为 commitment', 'warn');
    }

    const ixData = encodeDepositData(amountLamports, commitment, newRoot);

    const placeholder = programId;
    const keys = [
      { pubkey: provider.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPk, isSigner: false, isWritable: true },
      { pubkey: mintPk, isSigner: false, isWritable: true },
      { pubkey: vaultPk, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    const ix = new TransactionInstruction({
      programId,
      keys,
      data: ixData,
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = provider.publicKey;

    const latest = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = latest.blockhash;

    log('发送交易...');

    let signature;
    if (typeof provider.signAndSendTransaction === 'function') {
      const res = await provider.signAndSendTransaction(tx);
      signature = typeof res === 'string' ? res : res.signature;
    } else if (typeof provider.signTransaction === 'function') {
      const signed = await provider.signTransaction(tx);
      signature = await connection.sendRawTransaction(signed.serialize());
    } else {
      throw new Error('钱包不支持 signAndSendTransaction/signTransaction');
    }

    if (!signature) {
      throw new Error('未获取到交易签名');
    }

    log(`交易已提交: ${signature}`);

    await connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      'confirmed'
    );

    log('交易确认成功。');

    const note = {
      version: 1,
      createdAt: new Date().toISOString(),
      rpcUrl: els.rpcUrl.value.trim(),
      programId: programId.toBase58(),
      pool: poolPk.toBase58(),
      vault: vaultPk.toBase58(),
      mint: mintPk.toBase58(),
      assetType: 'sol',
      amountLamports: amountLamports.toString(),
      amountSol: (Number(amountLamports) / LAMPORTS_PER_SOL).toString(),
      commitmentHex: bytesToHex(commitment),
      newRootHex: bytesToHex(newRoot),
      secretHex: bytesToHex(secret),
      nullifierHex: bytesToHex(nullifier),
      depositSignature: signature,
    };

    latestNote = note;

    els.signature.value = signature;
    els.solscanLink.href = `https://solscan.io/tx/${signature}`;
    els.solscanLink.textContent = `https://solscan.io/tx/${signature}`;
    els.note.value = JSON.stringify(note, null, 2);

    log('Note 已生成，可复制或下载。');
  } catch (error) {
    log(error.message ?? String(error), 'error');
  } finally {
    setBusy(false);
  }
}

function onFillRecipient() {
  try {
    if (!provider?.publicKey) {
      throw new Error('请先连接钱包');
    }
    els.withdrawRecipient.value = provider.publicKey.toBase58();
    log('已填入当前钱包地址为 recipient');
  } catch (error) {
    log(error.message ?? String(error), 'error');
  }
}

function normalizeApiBase(raw) {
  const value = raw.trim();
  if (!value) {
    throw new Error('Relayer API URL 不能为空');
  }
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function parseNoteJson(raw) {
  const note = JSON.parse(raw);

  if (!note || typeof note !== 'object') {
    throw new Error('note JSON 格式错误');
  }

  const required = ['depositSignature', 'secretHex', 'nullifierHex'];
  for (const key of required) {
    if (!note[key] || typeof note[key] !== 'string') {
      throw new Error(`note 缺少字段: ${key}`);
    }
  }

  return {
    depositSignature: note.depositSignature,
    secretHex: note.secretHex,
    nullifierHex: note.nullifierHex,
  };
}

async function onBuildWithdrawRequest() {
  try {
    setBusy(true);

    const apiBase = normalizeApiBase(els.relayerApiUrl.value);
    const recipient = els.withdrawRecipient.value.trim();
    if (!recipient) {
      throw new Error('Recipient 不能为空');
    }

    // Validate pubkey format early.
    new PublicKey(recipient);

    const noteRaw = els.note.value.trim();
    if (!noteRaw) {
      throw new Error('请先生成 note 或粘贴 note JSON');
    }

    const note = parseNoteJson(noteRaw);

    const relayerFeeLamports = els.relayerFeeLamports.value.trim();
    if (relayerFeeLamports && !/^\d+$/.test(relayerFeeLamports)) {
      throw new Error('Relayer Fee 必须是整数 lamports');
    }

    const recipientAmountLamports = els.recipientAmountLamports.value.trim();
    if (recipientAmountLamports && !/^\d+$/.test(recipientAmountLamports)) {
      throw new Error('Recipient Amount 必须是整数 lamports');
    }

    log('向 relayer API 提交提现请求...');

    const res = await fetch(`${apiBase}/api/relay-request/build`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        note,
        recipient,
        relayerFeeLamports: relayerFeeLamports || '0',
        recipientAmountLamports: recipientAmountLamports || undefined,
      }),
    });

    let payload = null;
    try {
      payload = await res.json();
    } catch {
      // keep null
    }

    if (!res.ok || !payload?.ok) {
      const errMsg = payload?.error || `HTTP ${res.status}`;
      throw new Error(`提交失败: ${errMsg}`);
    }

    els.requestIdResult.value = payload.result.requestId ?? '';
    els.requestFileResult.value = payload.result.filePath ?? '';

    log(
      `提现请求已入队: requestId=${payload.result.requestId}, deposit=${payload.result.depositSignature}`
    );
  } catch (error) {
    log(error.message ?? String(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function onCopyNote() {
  try {
    if (!els.note.value.trim()) {
      throw new Error('当前没有可复制的 note');
    }
    await navigator.clipboard.writeText(els.note.value);
    log('Note 已复制到剪贴板。');
  } catch (error) {
    log(error.message ?? String(error), 'error');
  }
}

function onDownloadNote() {
  try {
    if (!latestNote) {
      throw new Error('当前没有可下载的 note');
    }

    const file = new Blob([JSON.stringify(latestNote, null, 2)], {
      type: 'application/json;charset=utf-8',
    });

    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = `x-mix-note-${latestNote.depositSignature.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    log('Note 文件已下载。');
  } catch (error) {
    log(error.message ?? String(error), 'error');
  }
}

window.addEventListener('load', async () => {
  try {
    if (provider?.isConnected && provider?.publicKey) {
      const connection = getConnection();
      const bal = await connection.getBalance(provider.publicKey, 'confirmed');
      const sol = Number(bal) / LAMPORTS_PER_SOL;
      els.walletStatus.textContent = `${provider.publicKey.toBase58()} | ${sol.toFixed(4)} SOL`;
      if (!els.withdrawRecipient.value.trim()) {
        els.withdrawRecipient.value = provider.publicKey.toBase58();
      }
    }
  } catch {
    // ignore
  }
});
