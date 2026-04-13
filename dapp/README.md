# x-mix DApp (MVP)

最小可用页面：
- 连接 Phantom 钱包
- 自动推导 `pool` / `vault`
- 发起 `deposit`（当前仅 SOL 池）
- 自动生成并导出 note（含 `secretHex` / `nullifierHex`）

## 启动

在仓库根目录执行：

```bash
python3 -m http.server 4173 -d dapp
```

浏览器打开：`http://127.0.0.1:4173`

## 说明

- 默认 Program ID 为主网已部署的 `XmixQ4DB8MtKcEFhyjWs1gZtdaF3YDuF4ieGLJ3xotv`。
- 默认 RPC 为 Chainstack 地址，可自行修改。
- 建议勾选“自动重建 Merkle Root”。
- 生成的 note 可直接配合 relayer 请求构建脚本使用：

```bash
npm run relayer:request -- \
  --deposit-signature <deposit_sig> \
  --recipient <recipient_pubkey> \
  --secret-hex <secret_hex> \
  --nullifier-hex <nullifier_hex> \
  --relayer-fee-lamports 0
```
