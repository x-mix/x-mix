# x-mix DApp (MVP)

最小可用页面：
- 连接 Phantom 钱包
- 自动推导 `pool` / `vault`
- 发起 `deposit`（当前仅 SOL 池）
- 自动生成并导出 note（含 `secretHex` / `nullifierHex`）
- 直接提交提现请求到 relayer API（由后端生成 proof 并落盘到请求队列）

## 启动 DApp

在仓库根目录执行：

```bash
npm run dapp:serve
```

浏览器打开：`http://127.0.0.1:4173`

## 启动 Relayer + API

在 `relayer/.env` 填好 `RPC_URL` 后：

```bash
cd relayer
npm run dev
```

默认 API 地址：`http://127.0.0.1:8787`

可健康检查：

```bash
curl http://127.0.0.1:8787/health
```

## 端到端流程

1. 在页面发起 `Deposit`。
2. 页面自动生成 note（可下载备份）。
3. 在“Withdraw 请求”里填写 recipient，点击“提交提现请求”。
4. relayer API 生成 proof + request JSON，写入 `REQUESTS_PATH`。
5. relayer 主循环消费请求并执行链上 `transfer`（`DRY_RUN=false` 时）。

## 说明

- 默认 Program ID 为主网已部署的 `XmixQ4DB8MtKcEFhyjWs1gZtdaF3YDuF4ieGLJ3xotv`。
- 页面默认 RPC 为 Chainstack 地址，可自行修改。
- 建议勾选“自动重建 Merkle Root”。
- 页面也支持粘贴已有 note 再提交提现请求。
