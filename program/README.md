# X mix

## SOL deposit fee model

For `AssetType::Sol`, each `deposit` now enforces a user-paid relayer subsidy:

- Caller must provide `relayer` as the last account in `deposit`.
- `relayer` must be writable.
- `relayer` must equal `pool.authority`.
- Program transfers `RELAYER_EXECUTION_FEE_LAMPORTS` from depositor to relayer,
  then transfers the user deposit amount into the vault.

This matches the model where relayer execution costs are paid by users, while
protocol fee accounting remains separate in `transfer`.
