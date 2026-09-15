export const LUNA_PER_NIM = 100000;

export const normNQ = (a: string) => a.replace(/\s+/g, '').toUpperCase();

const NQ_RE = /^NQ\d{2}[0-9A-Z]{32}$/;

/** Full Nimiq IBAN check (structure + mod-97 check digits). Typos can't pass. */
export function validAddress(a: string): boolean {
  const n = normNQ(a);
  if (!NQ_RE.test(n)) return false;
  const body = n.slice(4);
  let digits = '';
  for (const ch of body + 'NQ00') {
    digits += ch >= '0' && ch <= '9' ? ch : String(ch.charCodeAt(0) - 55);
  }
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  return 98 - rem === Number(n.slice(2, 4));
}

/** Parse a NIM amount string to integer luna. Returns null when invalid. */
export function parseNimToLuna(s: string): number | null {
  const t = s.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,5})?$/.test(t)) return null;
  const luna = Math.round(Number(t) * LUNA_PER_NIM);
  if (!(luna > 0) || luna > 1e11) return null; // (0, 1M NIM]
  return luna;
}

export function formatNim(luna: number): string {
  return `${Number((luna / LUNA_PER_NIM).toFixed(5))} NIM`;
}

export const shortAddr = (a: string, n = 10) => (a.length > n + 8 ? `${a.slice(0, n)}…${a.slice(-6)}` : a);

export interface ParsedLine {
  address: string;
  amount: string;
  label: string;
  error: string | null;
}

/** Tolerant CSV: `address, amount, label?` per line; comma/semicolon/tab separated. */
export function parseCSV(text: string): ParsedLine[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const parts = line
        .split(/[,;\t]/)
        .map((p) => p.trim())
        .filter((p) => p !== '');
      const [address = '', amount = '', ...rest] = parts;
      const label = rest.join(' ').slice(0, 40);
      let error: string | null = null;
      if (!address || !validAddress(address)) error = 'bad address/checksum';
      else if (parseNimToLuna(amount) === null) error = 'bad amount (>0, ≤5 decimals)';
      return { address, amount, label, error };
    });
}

export function shortBatchId(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  for (const v of buf) s += abc[v % abc.length];
  return s;
}
