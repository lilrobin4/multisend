import { useMemo, useRef, useState } from 'react';
import { formatNim, normNQ, parseCSV, parseNimToLuna, shortAddr, shortBatchId, validAddress } from './lib';
import { NETWORK, connectWallet, sendOne, waitConfirm } from './nimiq';
import { loadBook, loadHistory, pushHistory, remember, saveBook } from './storage';
import type { Book, HistBatch } from './storage';

interface EditRow {
  key: string;
  address: string;
  amount: string;
  label: string;
}

type SendStatus = 'queued' | 'approving' | 'sent' | 'confirmed' | 'unconfirmed' | 'failed' | 'cancelled';

interface SendRow {
  key: string;
  address: string;
  luna: number;
  label: string;
  status: SendStatus;
  hash: string | null;
  error: string | null;
}

const STATUS_PILL: Record<SendStatus, string> = {
  queued: '⏳ queued',
  approving: '📲 approving…',
  sent: '📡 sent, confirming…',
  confirmed: '✅ confirmed',
  unconfirmed: '❓ unconfirmed',
  failed: '❌ failed',
  cancelled: '⏭️ skipped',
};

let keyCounter = 0;
const newKey = () => `r${Date.now().toString(36)}${keyCounter++}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rowError(r: EditRow): string | null {
  if (!r.address.trim() && !r.amount.trim() && !r.label.trim()) return null; // blank row ignored
  if (!validAddress(r.address)) return 'bad address / checksum';
  if (parseNimToLuna(r.amount) === null) return 'bad amount (>0, ≤5 decimals)';
  return null;
}

export default function App() {
  const [me, setMe] = useState<string | null>(null);
  const [tab, setTab] = useState<'send' | 'book' | 'history'>('send');
  const [rows, setRows] = useState<EditRow[]>([{ key: newKey(), address: '', amount: '', label: '' }]);
  const [phase, setPhase] = useState<'edit' | 'sending'>('edit');
  const [sendRows, setSendRows] = useState<SendRow[]>([]);
  const [batchId, setBatchId] = useState('');
  const [paused, setPaused] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [book, setBook] = useState<Book>(() => loadBook());
  const [history, setHistory] = useState<HistBatch[]>(() => loadHistory());

  const running = useRef(false);
  const pausedRef = useRef(false);
  const savedRef = useRef('');

  const filled = useMemo(
    () => rows.filter((r) => r.address.trim() || r.amount.trim() || r.label.trim()),
    [rows],
  );
  const invalid = useMemo(() => filled.filter((r) => rowError(r) !== null), [filled]);
  const dupes = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of filled) {
      if (!validAddress(r.address)) continue;
      const n = normNQ(r.address);
      seen.set(n, (seen.get(n) || 0) + 1);
    }
    return new Set([...seen.entries()].filter(([, c]) => c > 1).map(([a]) => a));
  }, [filled]);
  const totalLuna = useMemo(
    () => filled.reduce((s, r) => s + (parseNimToLuna(r.amount) || 0), 0),
    [filled],
  );

  const terminal = sendRows.filter((r) =>
    ['confirmed', 'unconfirmed', 'failed', 'cancelled'].includes(r.status),
  ).length;

  async function connect() {
    try {
      setMe(await connectWallet());
      setNote(null);
    } catch (e) {
      setNote((e as Error).message === 'cancelled' ? 'Wallet connection cancelled.' : (e as Error).message);
    }
  }

  function patchRow(key: string, patch: Partial<SendRow>) {
    setSendRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function runQueue() {
    if (running.current) return;
    running.current = true;
    setNote(null);
    const keys = sendRows.map((r) => r.key);
    for (const key of keys) {
      if (!running.current) break;
      const cur = await new Promise<SendRow | undefined>((resolve) => {
        setSendRows((prev) => {
          resolve(prev.find((r) => r.key === key));
          return prev;
        });
      });
      if (!cur || !['queued', 'failed', 'cancelled'].includes(cur.status)) continue;
      while (pausedRef.current) {
        if (!running.current) break;
        await sleep(400);
      }
      if (!running.current) break;
      patchRow(key, { status: 'approving', error: null });
      try {
        const hash = await sendOne(cur.address, cur.luna, `multisend:${batchId}:${key}`);
        patchRow(key, { status: 'sent', hash });
        void waitConfirm(hash).then((st) => {
          if (st === 'confirmed') patchRow(key, { status: 'confirmed' });
          else if (st === 'failed') patchRow(key, { status: 'failed', error: 'tx failed on-chain' });
          else patchRow(key, { status: 'unconfirmed' });
        });
        remember(cur.address, cur.label);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === 'cancelled') patchRow(key, { status: 'cancelled', error: 'skipped in wallet' });
        else patchRow(key, { status: 'failed', error: msg });
      }
    }
    running.current = false;
    setBook(loadBook());
    maybeSaveHistory();
  }

  function maybeSaveHistory() {
    setSendRows((prev) => {
      const done = prev.every((r) => ['confirmed', 'unconfirmed', 'failed', 'cancelled'].includes(r.status));
      if (done && prev.length > 0 && me && savedRef.current !== batchId) {
        savedRef.current = batchId;
        const batch: HistBatch = {
          id: batchId,
          at: Date.now(),
          from: me,
          rows: prev.map((r) => ({
            address: r.address,
            amount: String(r.luna / 100000),
            label: r.label,
            status: r.status,
            hash: r.hash,
          })),
        };
        pushHistory(batch);
        setHistory(loadHistory());
      }
      return prev;
    });
  }

  function start() {
    if (!me || filled.length === 0 || invalid.length > 0) return;
    const id = shortBatchId();
    setBatchId(id);
    savedRef.current = '';
    setSendRows(
      filled.map((r) => ({
        key: r.key,
        address: r.address.trim(),
        luna: parseNimToLuna(r.amount)!,
        label: r.label.trim(),
        status: 'queued' as SendStatus,
        hash: null,
        error: null,
      })),
    );
    setPhase('sending');
    setPaused(false);
    pausedRef.current = false;
    setTimeout(runQueue, 50);
  }

  function retryFailed() {
    setSendRows((prev) =>
      prev.map((r) => (r.status === 'failed' || r.status === 'cancelled' || r.status === 'unconfirmed' ? { ...r, status: 'queued' as SendStatus, error: null } : r)),
    );
    savedRef.current = '';
    setTimeout(runQueue, 50);
  }

  function backToEdit() {
    running.current = false;
    pausedRef.current = false;
    setPaused(false);
    setPhase('edit');
  }

  function importCSV(replace: boolean) {
    const parsed = parseCSV(csvText);
    if (parsed.length === 0) {
      setNote('No valid lines found. Format: address, amount, label?');
      return;
    }
    const mapped: EditRow[] = parsed.map((p) => ({ key: newKey(), address: p.address, amount: p.amount, label: p.label }));
    // auto-fill labels from book
    for (const m of mapped) {
      if (!m.label && validAddress(m.address)) m.label = book[normNQ(m.address)] || '';
    }
    setRows((prev) => (replace ? mapped : [...prev.filter((r) => r.address.trim() || r.amount.trim() || r.label.trim()), ...mapped]));
    setCsvText('');
    setCsvOpen(false);
    const bad = parsed.filter((p) => p.error).length;
    setNote(
      bad > 0
        ? `Imported ${parsed.length} rows, ${bad} need fixing (see red rows).`
        : `Imported ${parsed.length} rows. Review the total, then Send.`,
    );
  }

  function exportCSV() {
    const lines = ['address,amount_nim,label,status,tx_hash'];
    for (const r of sendRows) {
      lines.push([r.address, String(r.luna / 100000), `"${r.label.replace(/"/g, '')}"`, r.status, r.hash || ''].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `multisend-${batchId}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function onAddressChange(key: string, v: string) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, address: v };
        if (!next.label && validAddress(v)) next.label = book[normNQ(v)] || '';
        return next;
      }),
    );
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '16px 16px 48px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0 16px' }}>
        <span style={{ color: '#fff', fontWeight: 800, fontSize: 20 }}>💸 MultiSend</span>
        {!me ? (
          <button className="btn btn-secondary" style={{ minHeight: 40, padding: '8px 14px', fontSize: 14 }} onClick={connect}>
            Connect wallet
          </button>
        ) : (
          <span className="mono" style={{ fontSize: 13, color: '#7ee2a8' }}>{shortAddr(me, 12)}</span>
        )}
      </header>

      <div className="card hero" style={{ textAlign: 'center' }}>
        <p style={{ margin: 0, fontSize: 12, color: NETWORK === 'mainnet' ? '#ff8a8a' : '#7ee2a8' }}>
          Network: {NETWORK.toUpperCase()}
          {NETWORK !== 'mainnet' && ' · Nimiq Pay: menu → long-press ⚙ 10s → Testnet + free NIM'}
          {NETWORK === 'mainnet' && ' · real NIM will move'}
        </p>
        <h1 style={{ fontSize: 24 }}>Pay everyone at once.</h1>
        <div className="steps">
          <span className="step">1️⃣ Paste list</span>
          <span className="step-arrow">→</span>
          <span className="step">2️⃣ Review total</span>
          <span className="step-arrow">→</span>
          <span className="step">3️⃣ Approve each ✓</span>
        </div>
        <p className="scoreline">Sequential & safe — you approve every payment. Every hash recorded.</p>
        {!me && <p style={{ color: '#f5c86e', fontSize: 13, marginBottom: 0 }}>Open inside Nimiq Pay to connect.</p>}
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        {(['send', 'book', 'history'] as const).map((t) => (
          <button
            key={t}
            className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'}`}
            style={{ flex: 1, minHeight: 40, fontSize: 14, textTransform: 'capitalize' }}
            onClick={() => setTab(t)}
          >
            {t === 'send' ? '💸 Send' : t === 'book' ? '📖 Book' : '🕘 History'}
          </button>
        ))}
      </div>

      {note && (
        <p style={{ color: '#f5c86e', fontSize: 13, background: '#141b2e', borderRadius: 10, padding: '8px 12px' }}>{note}</p>
      )}

      {tab === 'send' && phase === 'edit' && (
        <div>
          <div className="card" style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" style={{ flex: 1, minHeight: 40, fontSize: 14 }} onClick={() => setCsvOpen(!csvOpen)}>
                📋 Paste list (CSV)
              </button>
              <button
                className="btn btn-secondary"
                style={{ flex: 1, minHeight: 40, fontSize: 14 }}
                onClick={() => setRows((p) => [...p, { key: newKey(), address: '', amount: '', label: '' }])}
              >
                + Add row
              </button>
              <button
                className="btn btn-secondary"
                style={{ minHeight: 40, fontSize: 14 }}
                onClick={() => setRows([{ key: newKey(), address: '', amount: '', label: '' }])}
              >
                Clear
              </button>
            </div>
            {csvOpen && (
              <div style={{ marginTop: 10 }}>
                <textarea
                  className="input mono"
                  rows={5}
                  placeholder={'NQxx …, 10, Alice\nNQyy …, 5\n# one per line: address, amount, label?'}
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  style={{ fontSize: 13 }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-primary" style={{ flex: 1, minHeight: 40 }} onClick={() => importCSV(true)}>
                    Replace list
                  </button>
                  <button className="btn btn-secondary" style={{ flex: 1, minHeight: 40 }} onClick={() => importCSV(false)}>
                    Append
                  </button>
                </div>
              </div>
            )}
          </div>

          {rows.map((r) => {
            const err = rowError(r);
            const isDupe = validAddress(r.address) && dupes.has(normNQ(r.address));
            return (
              <div key={r.key} className="card" style={{ marginTop: 8, borderColor: err ? '#a33' : undefined }}>
                <input
                  className="input mono"
                  placeholder="NQ… recipient address"
                  value={r.address}
                  onChange={(e) => onAddressChange(r.key, e.target.value)}
                  style={{ fontSize: 13 }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <input
                    className="input"
                    placeholder="NIM"
                    inputMode="decimal"
                    value={r.amount}
                    onChange={(e) => setRows((p) => p.map((x) => (x.key === r.key ? { ...x, amount: e.target.value } : x)))}
                    style={{ flex: 1 }}
                  />
                  <input
                    className="input"
                    placeholder="label?"
                    value={r.label}
                    onChange={(e) => setRows((p) => p.map((x) => (x.key === r.key ? { ...x, label: e.target.value } : x)))}
                    style={{ flex: 1.4 }}
                  />
                  <button
                    className="btn btn-secondary"
                    style={{ minHeight: 40, padding: '8px 12px' }}
                    onClick={() => setRows((p) => p.filter((x) => x.key !== r.key))}
                  >
                    ✕
                  </button>
                </div>
                {err && <p style={{ color: '#ff8a8a', fontSize: 13, margin: '6px 0 0' }}>⚠️ {err}</p>}
                {!err && isDupe && <p style={{ color: '#f5c86e', fontSize: 13, margin: '6px 0 0' }}>⚠️ same address twice — will pay twice</p>}
              </div>
            );
          })}

          <div className="card" style={{ marginTop: 12, textAlign: 'center' }}>
            <div className="chips">
              <span className="chip">👥 {filled.length} recipient{filled.length === 1 ? '' : 's'}</span>
              <span className="chip hot">💰 {formatNim(totalLuna)} total</span>
              {invalid.length > 0 && <span className="chip">🚫 {invalid.length} invalid</span>}
            </div>
            <button
              className="btn btn-primary"
              style={{ width: '100%' }}
              disabled={!me || filled.length === 0 || invalid.length > 0}
              onClick={start}
            >
              {!me
                ? 'Connect wallet to send'
                : invalid.length > 0
                  ? `Fix ${invalid.length} row${invalid.length === 1 ? '' : 's'} to continue`
                  : filled.length === 0
                    ? 'Add recipients first'
                    : `Review & send · ${filled.length} payment${filled.length === 1 ? '' : 's'} · ${formatNim(totalLuna)}`}
            </button>
            <p style={{ fontSize: 12, color: '#7c8aa5', marginBottom: 0 }}>
              You'll approve {filled.length} transaction{filled.length === 1 ? '' : 's'} in Nimiq Pay, one by one.
            </p>
          </div>
        </div>
      )}

      {tab === 'send' && phase === 'sending' && (
        <div>
          <div className="card" style={{ marginTop: 12 }}>
            <p style={{ margin: 0, fontWeight: 800 }}>Batch {batchId} · {terminal}/{sendRows.length} done</p>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${sendRows.length ? Math.round((terminal / sendRows.length) * 100) : 0}%` }} />
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {!paused ? (
                <button className="btn btn-secondary" style={{ flex: 1, minHeight: 40 }} onClick={() => { pausedRef.current = true; setPaused(true); }}>
                  ⏸ Pause
                </button>
              ) : (
                <button className="btn btn-primary" style={{ flex: 1, minHeight: 40 }} onClick={() => { pausedRef.current = false; setPaused(false); void runQueue(); }}>
                  ▶ Resume
                </button>
              )}
              <button className="btn btn-secondary" style={{ flex: 1, minHeight: 40 }} onClick={retryFailed}>
                ↻ Retry failed
              </button>
              <button className="btn btn-secondary" style={{ flex: 1, minHeight: 40 }} onClick={exportCSV}>
                ⬇ CSV
              </button>
              <button className="btn btn-secondary" style={{ flex: 1, minHeight: 40 }} onClick={backToEdit}>
                ✎ Edit list
              </button>
            </div>
          </div>
          {sendRows.map((r) => (
            <div key={r.key} className="card" style={{ marginTop: 8 }}>
              <p style={{ margin: 0, fontSize: 14 }}>
                <strong>{formatNim(r.luna)}</strong> → <span className="mono">{shortAddr(r.address, 12)}</span>
                {r.label && <span style={{ color: '#a9b4cc' }}> ({r.label})</span>}
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: '#a9b4cc' }}>
                {STATUS_PILL[r.status]}
                {r.hash && <span className="mono" style={{ fontSize: 12 }}> · {r.hash.slice(0, 16)}…</span>}
                {r.error && <span style={{ color: '#ff8a8a' }}> · {r.error}</span>}
              </p>
            </div>
          ))}
        </div>
      )}

      {tab === 'book' && (
        <div className="card" style={{ marginTop: 12 }}>
          <strong>📖 Address book</strong>
          <p style={{ color: '#7c8aa5', fontSize: 13 }}>Saved on this device. Labels auto-fill when you type a known address.</p>
          {Object.keys(book).length === 0 && <p style={{ color: '#a9b4cc' }}>Empty — labels you type while sending are remembered here.</p>}
          {Object.entries(book).map(([a, l]) => (
            <p key={a} style={{ fontSize: 14, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span><strong>{l}</strong> <span className="mono" style={{ color: '#7c8aa5', fontSize: 12 }}>{shortAddr(a, 12)}</span></span>
              <button
                className="btn btn-secondary"
                style={{ minHeight: 32, padding: '4px 10px', fontSize: 12 }}
                onClick={() => {
                  const b = { ...book };
                  delete b[a];
                  setBook(b);
                  saveBook(b);
                }}
              >
                ✕
              </button>
            </p>
          ))}
        </div>
      )}

      {tab === 'history' && (
        <div style={{ marginTop: 12 }}>
          {history.length === 0 && <div className="card" style={{ color: '#a9b4cc' }}>No batches yet on this device.</div>}
          {history.map((h) => (
            <div key={h.id} className="card" style={{ marginTop: 8 }}>
              <p style={{ margin: 0, fontWeight: 800 }}>
                Batch {h.id} · {new Date(h.at).toLocaleString()}
              </p>
              <p style={{ margin: '4px 0', fontSize: 13, color: '#a9b4cc' }}>
                from <span className="mono">{shortAddr(h.from, 12)}</span> · {h.rows.length} payments ·{' '}
                {h.rows.filter((r) => r.status === 'confirmed').length} confirmed
              </p>
              {h.rows.map((r, i) => (
                <p key={i} style={{ fontSize: 13, margin: '4px 0', color: '#cfd8ec' }}>
                  {r.amount} NIM → <span className="mono">{shortAddr(r.address, 10)}</span> · {r.status}
                  {r.hash && <span className="mono" style={{ color: '#7c8aa5' }}> · {r.hash.slice(0, 12)}…</span>}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
