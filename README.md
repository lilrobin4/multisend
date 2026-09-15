# ⬡ NimMultiSend — pay everyone at once with NIM

A Nimiq Pay Mini App. Neither the Nimiq wallet nor any mini app offers batch payments —
paying 10 people means 10 manual transfers. MultiSend fixes that: paste a list, review
the total, approve each send in sequence. Every hash recorded, every address
checksum-verified before a single approval.

## 60 seconds

1. **Paste** — `address, amount, label` per line (or add rows by hand).
2. **Review** — count, total, duplicates and bad addresses flagged. Nothing sends until the list is clean.
3. **Send** — one wallet approval per payment, in order. Pause/resume any time. Confirmations checked on-chain.

100% client-side: no server, no custody, no account. Address book + history live in your browser (localStorage).

## Safety design

- Nimiq IBAN check-digits re-validated for every address (typos can't pass).
- Sequential approvals — you see each recipient + amount in Nimiq Pay before it moves.
- Batch memo on every tx (`multisend:{batch}:{i}`) so payments stay auditable.
- Duplicate addresses flagged; review gate blocks sending with any invalid row.

## Dev

```bash
npm install
npm run dev        # :5173
npm run typecheck
npm run build      # static dist/ — host anywhere
```

## Roadmap: dual-chain

NIM first. The sender is isolated in `src/nimiq.ts`, so a second asset rail
(USDT over EVM via `window.ethereum`) can plug in later. Blocked today because the
mini-app SDK exposes NIM transfers only, and real USDT can't be exercised on testnet
(EVM stays on mainnet) — so it can't be demoed safely before judging.

## Going mainnet

No code changes needed:

1. In Nimiq Pay, switch back to Mainnet (the wallet decides where funds move).
2. Open the app with `?network=mainnet` (confirmation-checks follow the mainnet RPC),
   or redeploy with `VITE_NETWORK=mainnet` baked in.
3. Send a 1-NIM test batch to your own addresses first.
