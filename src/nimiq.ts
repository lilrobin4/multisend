import { init } from '@nimiq/mini-app-sdk';

// ---------------------------------------------------------------------------
// Asset rail: NIM. (A future USDT/EVM rail plugs in beside this module — same
// interface: connect() -> address, send() -> txHash, confirm() -> status.)
// ---------------------------------------------------------------------------

function queryNetwork(): 'mainnet' | 'testnet' | null {
  try {
    const q = new URLSearchParams(window.location.search).get('network');
    return q === 'mainnet' || q === 'testnet' ? q : null;
  } catch {
    return null;
  }
}

const RPCS = {
  testnet: 'https://rpc.testnet.nimiqwatch.com/',
  mainnet: 'https://rpc.nimiqwatch.com',
} as const;

// ?network=mainnet (or testnet) overrides the build default — promotion without rebuild.
const qn = typeof window !== 'undefined' ? queryNetwork() : null;
export const NETWORK: 'mainnet' | 'testnet' =
  qn || (import.meta.env.VITE_NETWORK === 'mainnet' ? 'mainnet' : 'testnet');
export const RPC_URL =
  (qn ? RPCS[qn] : import.meta.env.VITE_NIMIQ_RPC_URL) || RPCS[NETWORK];

let p: ReturnType<typeof init> | null = null;

async function provider() {
  try {
    p ??= init({ timeout: 10_000 });
    return await p;
  } catch {
    throw new Error('Open this page inside Nimiq Pay to connect your wallet.');
  }
}

function isCancel(e: unknown): boolean {
  const s = String((e as any)?.message || e);
  return /denied|reject|cancel|dismiss/i.test(s);
}

export async function connectWallet(): Promise<string> {
  const nimiq = await provider();
  try {
    const accounts = (await nimiq.listAccounts()) as string[];
    if (!accounts?.length) throw new Error('no Nimiq account found in wallet');
    return accounts[0];
  } catch (e) {
    throw new Error(isCancel(e) ? 'cancelled' : `wallet error: ${(e as Error).message}`);
  }
}

/** One direct payment, sender → recipient. Memo tags the batch for audit. */
export async function sendOne(recipient: string, valueLuna: number, memo: string): Promise<string> {
  const nimiq = await provider();
  try {
    const txHash = (await nimiq.sendBasicTransactionWithData({
      recipient,
      value: valueLuna,
      data: memo,
    })) as string;
    return txHash;
  } catch (e) {
    throw new Error(isCancel(e) ? 'cancelled' : `payment failed: ${(e as Error).message}`);
  }
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const json = (await res.json()) as { result?: any; error?: any };
  if (json.error) throw new Error('tx not found yet');
  return json.result;
}

export type ConfirmState = 'confirmed' | 'failed' | 'pending';

/** Single confirmation probe for one tx hash. Never throws. */
export async function probeTx(txHash: string): Promise<ConfirmState> {
  try {
    const raw = await rpc('getTransactionByHash', [txHash]);
    const tx = raw?.data?.transaction ?? raw?.data ?? raw?.transaction ?? raw;
    if (!tx || (tx.blockNumber == null && tx.blockHash == null)) return 'pending';
    if (tx.executionResult === false) return 'failed';
    return Number(tx.confirmations ?? 1) >= 1 ? 'confirmed' : 'pending';
  } catch {
    return 'pending';
  }
}

/** Poll until confirmed/failed or ~75s timeout. Resolves, never rejects. */
export async function waitConfirm(txHash: string): Promise<ConfirmState> {
  for (let i = 0; i < 15; i++) {
    const s = await probeTx(txHash);
    if (s !== 'pending') return s;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return 'pending';
}
