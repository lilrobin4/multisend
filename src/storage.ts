import { normNQ } from './lib';

export type Book = Record<string, string>; // normAddress -> label

const BOOK_KEY = 'multisend.book.v1';
const HIST_KEY = 'multisend.history.v1';

export function loadBook(): Book {
  try {
    return JSON.parse(localStorage.getItem(BOOK_KEY) || '{}') as Book;
  } catch {
    return {};
  }
}

export function saveBook(b: Book) {
  try {
    localStorage.setItem(BOOK_KEY, JSON.stringify(b));
  } catch {
    /* storage full/blocked — non-fatal */
  }
}

export function remember(address: string, label: string) {
  if (!label.trim()) return;
  const b = loadBook();
  b[normNQ(address)] = label.trim().slice(0, 40);
  saveBook(b);
}

export interface HistRow {
  address: string;
  amount: string;
  label: string;
  status: string;
  hash: string | null;
}

export interface HistBatch {
  id: string;
  at: number;
  from: string;
  rows: HistRow[];
}

export function loadHistory(): HistBatch[] {
  try {
    return JSON.parse(localStorage.getItem(HIST_KEY) || '[]') as HistBatch[];
  } catch {
    return [];
  }
}

export function pushHistory(b: HistBatch) {
  try {
    const h = [b, ...loadHistory()].slice(0, 20);
    localStorage.setItem(HIST_KEY, JSON.stringify(h));
  } catch {
    /* ignore */
  }
}
