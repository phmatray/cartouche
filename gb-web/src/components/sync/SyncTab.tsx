import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { encode } from 'uqr';
import { engine, setDevice, useSync, IDLE, type Device, type LinkState, type Note, type Pairing } from '../../lib/sync/status';
import { CODE_PREFIX, groupCode } from '../../lib/sync/crypto';
import { getAllGameMeta, getRomIds } from '../../lib/db';
import { useGameLibrary } from '../../hooks/useGameLibrary';
import { ago, rich, size, useT, type Key } from '../../i18n';
import { isIos } from '../../lib/pwa';
import { useOnline } from '../../lib/p2p/room';
import { focusIfLost } from '../../lib/ui';
import { I } from '../icons';
import { toast } from '../shell/actions';
import { ConfirmDialog, type ConfirmRequest } from '../shell/ConfirmDialog';
import { Row, SwitchRow } from '../settings/parts';
import { Scanner } from './Scanner';
import './sync.css';

type T = ReturnType<typeof useT>;
/** The code's shape, as a hint (not words: never translated). */
const CODE_SHAPE = 'XXXXXX XXXXXX XXXXXX …';

/** Settings › Sync: pair devices, see them, sync them. */
export function SyncTab() {
  const t = useT();
  const { me, devices, auto, roms, links, pairing } = useSync();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [local, setLocal] = useState<{ count: number; bytes: number } | null>(null);
  const online = useOnline();

  // While this page is open, every paired device's room is joined: "Sync now" is instant, the other device shows up live.
  // Leaving it also ends a pairing: the code is only good while it's on screen (docs/SYNC.md).
  useEffect(() => {
    let release: (() => void) | null = null, gone = false;
    engine().then((e) => { if (!gone) release = e.hold(); });
    return () => { gone = true; release?.(); if (useSync.getState().pairing) void engine().then((e) => e.cancelPairing()); };
  }, []);
  useEffect(() => {
    let live = true;
    Promise.all([getAllGameMeta(), getRomIds()]).then(([metas, ids]) => {
      const have = new Set(ids);
      const own = metas.filter((m) => m.rom && have.has(m.id));
      if (live) setLocal({ count: own.length, bytes: own.reduce((a, m) => a + (0x8000 << Math.min(m.rom!.head[0x148] ?? 0, 8)), 0) });
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  const unpair = (d: Device) => setConfirm({
    title: t('sync.unpair.title', { name: d.name }), danger: true, ok: t('sync.unpair.ok'),
    body: t('sync.unpair.body'),
    run: async () => { (await engine()).removeDevice(d.id); toast(t('sync.unpair.done', { name: d.name }), 'c'); },
  });
  const theirRoms = Object.values(links).find((l) => l.theirRoms)?.theirRoms;
  // Notes shown here are read: the header's dot goes out.
  useEffect(() => { for (const d of devices) if (d.report?.notes.length && !d.report.seen) setDevice(d.id, { report: { ...d.report, seen: true } }); }, [devices]);

  return (
    <>
      <h2>{t('settings.tabs.sync')}</h2>
      <p className="intro">{t('sync.intro')}</p>
      {!online && <p className="sy-off" role="alert">{t('common.offlineNet')}</p>}
      <NameRow name={me.name} />

      {devices.length > 0 && (
        <>
          <h3>{t('sync.paired')}</h3>
          <ul className="sy-devs" aria-label={t('sync.paired')}>
            {devices.map((d) => <DeviceCard key={d.id} d={d} link={links[d.id] ?? IDLE} me={me.name} onUnpair={() => unpair(d)} />)}
          </ul>
        </>
      )}

      <h3>{devices.length ? t('sync.pairAnother') : t('sync.pairFirst')}</h3>
      {pairing ? <PairPanel p={pairing} me={me.name} /> : <Doors />}

      <h3>{t('sync.options')}</h3>
      <SwitchRow label={t('sync.auto.label')} sub={t('sync.auto.sub')}
        on={auto} set={(v) => { useSync.setState({ auto: v }); if (v) engine().then((e) => e.startAuto()); }} />
      <SwitchRow label={t('sync.roms.label')}
        sub={[
          t('sync.roms.sub'),
          local && (local.count ? t('sync.roms.mine', { name: me.name, count: local.count, size: size(local.bytes) }) : t('sync.roms.none', { name: me.name })),
          theirRoms && theirRoms.count > 0 && t('sync.roms.theirs', { count: theirRoms.count, size: size(theirRoms.bytes) }),
          t('sync.roms.both'),
        ].filter(Boolean).join(' ')}
        // Off: what arrived of any unfinished ROM transfer goes too (a ROM's worth of pieces, otherwise kept for nothing).
        on={roms} set={(v) => { useSync.setState({ roms: v }); if (!v) engine().then((e) => e.forgetTransfers()); }} />

      <h3>{t('sync.what.title')}</h3>
      <dl className="sy-what">
        <div><dt>{t('sync.what.across')}</dt><dd>{t('sync.what.acrossBody')}</dd></div>
        <div><dt>{t('sync.what.stays')}</dt><dd>{t('sync.what.staysBody')}</dd></div>
        <div><dt>{t('sync.what.both')}</dt><dd>{t('sync.what.bothBody')}</dd></div>
        <div><dt>{t('sync.what.del')}</dt><dd>{t('sync.what.delBody')}</dd></div>
      </dl>

      <h3>{t('sync.how.title')}</h3>
      <dl className="sy-what">
        <div><dt>{t('sync.how.open')}</dt><dd>{t('sync.how.openBody')} {isIos() ? t('sync.how.openIos') : t('sync.how.openOther')}</dd></div>
        <div><dt>{t('sync.how.e2e')}</dt><dd>{t('sync.how.e2eBody')}</dd></div>
        <div><dt>{t('sync.how.nat')}</dt><dd>{rich(t('sync.how.natBody'), { a: (s) => <Link to="/link-cable/online">{s}</Link> })}</dd></div>
      </dl>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}

function NameRow({ name }: { name: string }) {
  const t = useT();
  const [v, setV] = useState(name);
  const save = () => { const n = v.trim().slice(0, 30); if (n && n !== name) { useSync.setState((s) => ({ me: { ...s.me, name: n } })); toast(t('sync.name.saved'), 'c'); } else setV(name); };
  return (
    <Row label={t('sync.name.label')} sub={t('sync.name.sub')}>
      <input className="field sy-name" value={v} maxLength={30} aria-label={t('sync.name.aria')} onChange={(e) => setV(e.target.value)}
        onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
    </Row>
  );
}

/** What a paired device is up to, as its little screen says it. */
function screenOf(l: LinkState, d: Device, t: T): { lit: boolean; big: string; small: string } {
  const pct = l.want + l.give ? Math.round(((l.got + l.sent) / (l.want + l.give)) * 100) : 0;
  switch (l.phase) {
    case 'syncing': return { lit: true, big: t('sync.lcd.syncing'), small: l.want + l.give ? t('sync.lcd.pct', { n: Math.min(pct, 100) }) : t('sync.lcd.comparing') };
    case 'done': return d.report?.failed
      ? { lit: true, big: t('sync.lcd.partial'), small: t('sync.lcd.missing') }
      : { lit: true, big: t('sync.lcd.done'), small: t('sync.lcd.linked') };
    case 'online': return { lit: true, big: t('sync.lcd.linked'), small: d.lastSync ? t('sync.lcd.ready') : t('sync.lcd.firstNext') };
    case 'interrupted': return { lit: false, big: t('sync.lcd.cut'), small: t('sync.lcd.resumes') };
    case 'error': return { lit: false, big: t('sync.lcd.error'), small: t('sync.lcd.seeBelow') };
    default: return { lit: false, big: t('sync.lcd.away'), small: t('sync.lcd.openIt') };
  }
}

/** A note from the last sync, in this device's language. */
function noteText(n: Note, t: T): string {
  const v = { from: n.from ?? '', slot: n.slot ?? 0, to: n.to ?? 0, count: n.count ?? 0 };
  const key: Key = n.key === 'bothState' ? (n.slot ? 'sync.note.bothSlot' : 'sync.note.bothResume')
    : n.key === 'noSlot' ? (n.slot ? 'sync.note.noSlot' : 'sync.note.noSlotResume')
    : `sync.note.${n.key}`;
  return t(key, v);
}

function DeviceCard({ d, link, me, onUnpair }: { d: Device; link: LinkState; me: string; onUnpair: () => void }) {
  const t = useT();
  const s = screenOf(link, d, t);
  const { games } = useGameLibrary();
  const titles = useMemo(() => new Map(games.map((g) => [g.id, g.title])), [games]);
  const moving = link.phase === 'syncing' && link.want + link.give > 0;
  const pct = moving ? Math.min(100, ((link.got + link.sent) / (link.want + link.give)) * 100) : link.phase === 'done' ? 100 : 0;
  const report = d.report;
  const now = async () => {
    if (!(await engine()).syncNow(d.id)) toast(t('sync.card.away', { name: d.name }), 'm');
  };
  return (
    <li className={`sy-dev${s.lit ? ' on' : ''}`}>
      <div className={`sy-lcd${s.lit ? ' lit' : ''}`} aria-hidden="true">
        <b>{s.big}</b>
        {moving || link.phase === 'done' ? <span className="sy-meter"><i style={{ width: `${pct}%` }} /></span> : <small>{s.small}</small>}
      </div>
      <div className="sy-dev-body">
        <h4>{d.name}</h4>
        {/* Announced once per phase, not on every chunk: the byte counts below stay silent. */}
        <span className="sy-sr" role="status">{s.big}</span>
        <p>
          {link.phase === 'syncing'
            ? (link.want + link.give ? t('sync.card.moving', { got: size(link.got), want: size(link.want), sent: size(link.sent), give: size(link.give) }) : t('sync.card.comparing'))
            : link.phase === 'interrupted' ? t('sync.card.cut')
            : link.error ? t(`sync.error.${link.error}`)
            : d.lastSync ? t('sync.card.last', { ago: ago(d.lastSync) }) : t('sync.card.never', { ago: ago(d.pairedAt) })}
        </p>
        {link.phase === 'done' && report && <p className="sy-sum">{summary(report.got, report.sent, me, d.name, t)}</p>}
        {report && report.notes.length > 0 && link.phase !== 'syncing' && (
          <ul className="sy-notes">{report.notes.map((n, i) => <li key={i} className={n.key === 'failed' ? 'warn' : undefined}>{n.game && <b>{t('sync.note.on', { game: titles.get(n.game) ?? n.game })}</b>}{noteText(n, t)}</li>)}</ul>
        )}
      </div>
      <div className="sy-dev-acts">
        <button className="btn k" disabled={link.phase === 'syncing'} onClick={now}>{link.phase === 'syncing' ? t('sync.card.busy') : t('sync.card.now')}</button>
        <button className="btn line" onClick={onUnpair}>{t('sync.card.unpair')}</button>
      </div>
    </li>
  );
}

const summary = (got: number, sent: number, me: string, them: string, t: T) =>
  !got && !sent ? t('sync.card.inStep')
    : t('sync.card.summary', {
      got: got ? t('sync.card.got', { count: got, me }) : t('sync.card.gotNone', { me }),
      sent: sent ? t('sync.card.sent', { count: sent, them }) : t('sync.card.sentNone', { them }),
    });

/** No pairing yet: this device shows a code, or reads the one the other device shows. */
function Doors() {
  const t = useT();
  const online = useOnline();
  const [scan, setScan] = useState(false);
  const [code, setCode] = useState('');
  const [bad, setBad] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await (await engine()).enterCode(code);
    setBad(!ok);
  };
  return (
    <div className="sy-doors">
      <section aria-labelledby="sy-h-show">
        <h4 id="sy-h-show">{t('sync.doors.show')}</h4>
        <p>{t('sync.doors.showSub')}</p>
        <button className="btn y lg" disabled={!online} onClick={() => engine().then((e) => e.showCode())}>{I.link}{t('sync.doors.showBtn')}</button>
      </section>
      <section aria-labelledby="sy-h-scan">
        <h4 id="sy-h-scan">{t('sync.doors.read')}</h4>
        <p>{isIos() ? t('sync.doors.readSubIos') : t('sync.doors.readSub')}</p>
        {scan
          ? <Scanner onClose={() => setScan(false)} onCode={async (text) => { const ok = await (await engine()).enterCode(text); if (ok) setScan(false); return ok; }} />
          : <button className="btn k lg" disabled={!online} onClick={() => setScan(true)}>{I.cam}{t('sync.doors.scan')}</button>}
        <form className="sy-type" onSubmit={submit}>
          <label htmlFor="sy-code">{t('sync.doors.type')}</label>
          <textarea id="sy-code" className="sy-code-in" rows={3} value={code} placeholder={CODE_SHAPE} aria-invalid={bad} aria-describedby="sy-code-err"
            autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false}
            onChange={(e) => { setCode(e.target.value); setBad(false); }} />
          <button className="btn line" disabled={code.replace(/\W/g, '').length < 54 || !online}>{t('sync.doors.pair')}</button>
          <small id="sy-code-err" className="sy-err" role="alert">{bad ? t('sync.doors.bad') : ''}</small>
        </form>
      </section>
    </div>
  );
}

/** A pairing in progress: two little screens joined by a cable that carries current once they've recognized each other. */
function PairPanel({ p, me }: { p: Pairing; me: string }) {
  const t = useT();
  const qr = useMemo(() => (p.code ? encode(CODE_PREFIX + p.code, { ecc: 'M', border: 0 }) : null), [p.code]);
  const path = useMemo(() => qr?.data.flatMap((row, y) => row.map((on, x) => (on ? `M${x} ${y}h1v1h-1z` : ''))).join('') ?? '', [qr]);
  const cancel = () => engine().then((e) => e.cancelPairing());
  const paired = p.phase === 'paired';
  const peer = p.peer ?? t('sync.otherDevice');
  const state = { showing: t('sync.pair.showing'), joining: t('sync.pair.joining'), found: t('sync.pair.found', { name: peer }), paired: t('sync.pair.paired'), failed: t('sync.pair.failed') }[p.phase];
  return (
    <div className={`sy-pair ${p.phase}`}>
      <div className="sy-cable-row" aria-live="polite">
        <div className="sy-lcd lit"><b>{me}</b><small>{t('sync.pair.thisDevice')}</small></div>
        <div className="sy-cable"><i /><span>{state}</span><i /></div>
        <div className={`sy-lcd${paired || p.phase === 'found' ? ' lit' : ''}`}>
          {paired || p.phase === 'found' ? <><b>{peer}</b><small>{paired ? t('sync.pair.paired') : t('sync.pair.checking')}</small></> : <><b>?</b><span className="sy-dots"><i /><i /><i /></span></>}
        </div>
      </div>
      {p.phase === 'showing' && qr && (
        <div className="sy-ticket" ref={focusIfLost} tabIndex={-1}>
          <svg className="sy-qr" viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`} role="img" aria-label={t('sync.pair.qr')} shapeRendering="crispEdges">
            <rect x="-2" y="-2" width={qr.size + 4} height={qr.size + 4} fill="#fff" /><path d={path} fill="currentColor" />
          </svg>
          <div>
            <p className="sy-code" aria-label={t('sync.pair.code')}>{groupCode(p.code!).split(' ').map((g, i) => <span key={i}>{g}</span>)}</p>
            <p className="sy-fine">{t('sync.pair.fine')}</p>
            <button className="btn line" onClick={() => navigator.clipboard?.writeText(p.code!).then(() => toast(t('sync.toast.copied'), 'c'), () => toast(t('sync.toast.noCopy'), 'm'))}>{t('sync.pair.copy')}</button>
          </div>
        </div>
      )}
      {p.phase === 'joining' && <p className="sy-fine">{t('sync.pair.joinHint')}</p>}
      {paired && <p className="sy-done">{I.check}{t('sync.pair.done', { name: peer })}</p>}
      {p.error && <p className="sy-err" role="alert">{t(`sync.error.${p.error}`)}</p>}
      <div className="sy-pair-acts">
        {paired ? <button className="btn y" onClick={cancel}>{t('sync.pair.ok')}</button> : <button className="btn line" onClick={cancel}>{t('sync.pair.cancel')}</button>}
      </div>
    </div>
  );
}
