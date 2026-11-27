'use client';
import { useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CARD_STORAGE } from '@/lib/browser-storage';

const URL = 'http://127.0.0.1:3211/management';
type Card = { id: string; name: string; connected: boolean; status: string; lastDeliveredAt: string | null; lastInteractionAt: string | null; lastError: string | null };
type Snapshot = { cards: Card[]; archived: Record<string, { name: string }>; gatewayOnline: boolean; timeZones: string[]; spectatorCode: string };
type StoredState = { records?: Record<string, unknown>; dayAnchors?: Record<string, unknown>; notes?: Record<string, unknown>; dayHistory?: { outcomes?: Record<string, unknown> } };
const STORAGE = {
  records: CARD_STORAGE.records,
  dayAnchors: CARD_STORAGE.dayAnchors,
  notes: CARD_STORAGE.notes,
};
function updateLocalCard(id: string, restored?: StoredState | null) {
  for (const [field, key] of Object.entries(STORAGE)) {
    const local = JSON.parse(localStorage.getItem(key) ?? '{}');
    delete local[id];
    const saved = restored?.[field as keyof typeof STORAGE]?.[id];
    if (saved !== undefined) local[id] = saved;
    localStorage.setItem(key, JSON.stringify(local));
  }
  const key = CARD_STORAGE.dayHistory;
  const history = JSON.parse(localStorage.getItem(key) ?? '{"outcomes":{}}');
  history.outcomes ??= {};
  delete history.outcomes[id];
  if (restored?.dayHistory?.outcomes?.[id]) history.outcomes[id] = restored.dayHistory.outcomes[id];
  localStorage.setItem(key, JSON.stringify(history));
}
function date(value: string | null) { return value ? new Date(value).toLocaleString() : '—'; }

export function CardManager() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'cards' | 'archive'>('cards');
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [zone, setZone] = useState('Europe/Berlin');
  const [spectatorCode, setSpectatorCode] = useState<string | null>(null);
  const [codeSaved, setCodeSaved] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(URL, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error();
        setData(await response.json()); setError('');
      } catch { if (!controller.signal.aborted) setError('Bot service unavailable.'); }
    };
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [open]);
  async function action(payload: { action: string; id?: string; name?: string; timeZone?: string; confirm?: boolean; code?: string }) {
    setBusy(true); setError('');
    try {
      const response = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json() as Snapshot & { error?: string; warning?: string; restoredState?: StoredState };
      if (!response.ok) throw new Error(result.error);
      if (payload.action === 'spectate-code') {
        setData(result); setSpectatorCode(null); setCodeSaved(true);
        return;
      }
      if (payload.id && (payload.action === 'purge' || payload.action === 'restore')) {
        updateLocalCard(payload.id, payload.action === 'restore' ? result.restoredState : null);
      }
      if (result.warning) { setError(result.warning); setData(result); window.setTimeout(() => location.reload(), 5000); }
      else location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save changes.'); }
    finally { setBusy(false); }
  }
  return <>
    <button aria-label="Manage cards and Discord connections" title="Manage cards" onClick={() => setOpen(true)}
      className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full border border-violet-300/30 bg-[#132030] text-violet-300 shadow-lg transition-colors hover:bg-[#223047] focus-visible:outline-2 focus-visible:outline-violet-300">
      <Menu className="h-5 w-5" />
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent aria-describedby={undefined} className="max-h-[85vh] overflow-y-auto border-slate-700 bg-[#0c1927] text-slate-100 sm:max-w-xl">
        <DialogHeader><DialogTitle className="text-violet-300">Cards & connections</DialogTitle></DialogHeader>
        <p className="text-sm text-slate-400">Bot: {error ? 'Status unavailable' : data?.gatewayOnline ? 'Connected to Discord' : data ? 'Reconnecting / offline' : 'Checking…'}</p>
        <div className="flex gap-2 border-b border-slate-700 pb-3">
          <Button variant="ghost" aria-pressed={tab === 'cards'} className={tab === 'cards' ? 'bg-violet-400/15 text-violet-300' : 'text-slate-400'} onClick={() => setTab('cards')}>Cards</Button>
          <Button variant="ghost" aria-pressed={tab === 'archive'} className={tab === 'archive' ? 'bg-violet-400/15 text-violet-300' : 'text-slate-400'} onClick={() => setTab('archive')}>Archive ({Object.keys(data?.archived ?? {}).length})</Button>
        </div>
        {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
        {tab === 'cards' ? <>
          <div className="space-y-3">{data?.cards.map(card => <div key={card.id} className="rounded-xl border border-slate-700/70 bg-[#112233] p-4">
            <div className="flex items-center justify-between gap-3"><strong className="text-violet-300">{card.name}</strong>
              <button disabled={busy} className="text-xs text-slate-400 hover:text-rose-300" onClick={() => void action({action: 'delete', id: card.id})}>Archive</button></div>
            <p className="mt-2 text-sm"><span className={'mr-2 inline-block h-2 w-2 rounded-full ' + (card.lastError ? 'bg-amber-400' : card.connected ? 'bg-violet-400' : 'bg-slate-500')} />{card.status}</p>
            <div className="mt-2 space-y-1 text-xs text-slate-400"><p>Last delivery: {date(card.lastDeliveredAt)}</p><p>Last command: {date(card.lastInteractionAt)}</p></div>
          </div>)}</div>
          <form className="space-y-2 border-t border-slate-700 pt-4" onSubmit={e => { e.preventDefault(); void action({ action: 'spectate-code', code: spectatorCode ?? data?.spectatorCode }); }}>
            <Label htmlFor="spectator-code">Spectator code</Label>
            <div className="flex gap-2">
              <Input id="spectator-code" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} minLength={4} required autoComplete="off"
                className="font-mono tracking-widest" value={spectatorCode ?? data?.spectatorCode ?? ''}
                onChange={e => { setSpectatorCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 4)); setCodeSaved(false); }} />
              <Button type="submit" disabled={busy || !data}>Save</Button>
            </div>
            {codeSaved && <p role="status" className="text-xs text-violet-300">Saved</p>}
          </form>
          <form className="space-y-3 border-t border-slate-700 pt-4" onSubmit={e => { e.preventDefault(); void action({ action: 'add', name, timeZone: zone }); }}>
            <Label htmlFor="new-card-name">Add a card</Label><Input id="new-card-name" placeholder="Name" maxLength={40} required value={name} onChange={e => setName(e.target.value)} />
            <Label htmlFor="new-card-zone">Time zone</Label>
            <select id="new-card-zone" required value={zone} onChange={e => setZone(e.target.value)} className="h-10 w-full min-w-0 rounded-md border border-slate-600 bg-[#112233] px-3 text-sm text-slate-100 focus:outline-violet-400">
              {(data?.timeZones ?? ['Europe/Berlin']).map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
            </select>
            <Button disabled={busy || !data} type="submit" className="bg-violet-400 text-slate-950 hover:bg-violet-300">{busy ? 'Saving…' : 'Add card'}</Button>
          </form>
        </> : <div className="space-y-3">
          {!Object.keys(data?.archived ?? {}).length && <p className="py-6 text-center text-sm text-slate-500">Archive empty</p>}
          {Object.entries(data?.archived ?? {}).map(([id, card]) => <div key={id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-700/70 bg-[#112233] p-4">
            <strong className="text-violet-300">{card.name}</strong><div className="flex gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => void action({ action: 'restore', id })}>Restore</Button>
              <Button variant="ghost" className="text-rose-300" disabled={busy} onClick={() => setDeleting({id, name: card.name})}>Delete permanently</Button>
            </div>
          </div>)}
        </div>}
      </DialogContent>
    </Dialog>
    <Dialog open={!!deleting} onOpenChange={open => { if (!open && !busy) setDeleting(null); }}>
      <DialogContent aria-describedby={undefined} className="border-slate-700 bg-[#0c1927] text-slate-100 sm:max-w-sm">
        <DialogHeader><DialogTitle>Delete {deleting?.name} permanently?</DialogTitle></DialogHeader>
        {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
        <div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => deleting && void action({action: 'purge', id: deleting.id, confirm: true})}>Delete</Button></div>
      </DialogContent>
    </Dialog>
  </>;
}
