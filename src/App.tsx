import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeleteOutcome, DiskInfo, ScanProgress, ScanResult } from '../shared/types';
import { About } from './About';
import { api } from './api';
import { Clean, useCleaning } from './Clean';
import { Explorer } from './Explorer';
import { formatBytes, plural } from './format';
import { Home } from './Home';
import { ScanProgressView } from './ScanProgressView';
import { Bar, Icon, usageTone } from './ui';

type Page = 'home' | 'map' | 'clean';

interface Toast {
  id: number;
  text: string;
}

export function App() {
  const [page, setPage] = useState<Page>('home');
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [home, setHome] = useState('');
  const [root, setRoot] = useState('');
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [cleanSeen, setCleanSeen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const say = useCallback((text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const refreshDisks = useCallback(() => {
    void api.disks().then(setDisks);
  }, []);

  const cleaning = useCleaning(refreshDisks, say);

  useEffect(() => {
    refreshDisks();
    void api.home().then(setHome);
    const timer = setInterval(refreshDisks, 15_000);
    return () => clearInterval(timer);
  }, [refreshDisks]);

  const latestScan = useRef(0);

  const startScan = useCallback(async (path: string) => {
    // Starting another analysis replaces the one under way: only the latest may touch the screen.
    const mine = ++latestScan.current;
    setRoot(path);
    setScanning(true);
    setProgress(null);
    setPage('map');
    try {
      const found = await api.scan(path, (p) => {
        if (mine === latestScan.current) setProgress(p);
      });
      if (mine === latestScan.current) setResult(found);
    } catch (e) {
      if (mine !== latestScan.current) return;
      const message = (e as Error).message ?? '';
      if (!message.includes('cancelled')) say(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      setPage((p) => (p === 'map' && !result ? 'home' : p));
    } finally {
      if (mine === latestScan.current) setScanning(false);
    }
  }, [say, result]);

  const onDeleteSummary = useCallback((outcome: DeleteOutcome) => {
    const { summary } = outcome;
    if (summary) setResult((r) => (r ? { ...r, ...summary } : r));
    refreshDisks();
    void cleaning.refresh();
    // The cleaning figures depend on the same folders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshDisks]);

  const addRegular = useCallback((path: string) => {
    void api.addCustomTarget(path).then((why) => {
      if (why) {
        say(why);
      } else {
        say('Ajouté à vos emplacements à vider.');
        void cleaning.refresh();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [say]);

  const system = disks.find((d) => d.system) ?? disks[0];
  const expected = disks.find((d) => d.mount === root)?.used;
  const reclaim = cleaning.reclaimable;

  const nav = (id: Page, icon: string, label: string, disabled = false, extra?: string) => (
    <button
      className={page === id ? 'nav on' : 'nav'}
      aria-current={page === id ? 'page' : undefined}
      disabled={disabled}
      onClick={() => {
        setPage(id);
        if (id === 'clean') setCleanSeen(true);
      }}
    >
      <Icon name={icon} size={18} />
      <span>{label}</span>
      {extra && <small className="num">{extra}</small>}
    </button>
  );

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <img src="./icon.svg" alt="" width={26} height={26} />
          <strong>Clairière</strong>
        </div>
        <nav aria-label="Principale">
          {nav('home', 'disk', 'Disques')}
          {nav('map', 'map', 'Carte', !result && !scanning, scanning ? '…' : undefined)}
          {nav('clean', 'clean', 'Nettoyage', false, reclaim ? formatBytes(reclaim) : undefined)}
        </nav>
        <span className="spacer" />
        {system && (
          <div className="side-disk">
            <div className="side-disk-line">
              <span>{system.label}</span>
              <strong className="num">{formatBytes(system.free)} libres</strong>
            </div>
            <Bar value={system.used / system.total} tone={usageTone(system.used, system.total)} />
          </div>
        )}
        <button className="side-about" onClick={() => setShowAbout(true)}>
          À propos <span className="num">v{__APP_VERSION__}</span>
        </button>
      </aside>

      <main className="main">
        {api.isDemo && (
          <div className="demo-banner">
            <Icon name="warn" /> Aperçu avec des données d'exemple : un navigateur ne peut pas lire vos disques. La version bureau analyse et libère vraiment.
          </div>
        )}
        <div className={page === 'home' ? 'view' : 'view hidden'}>
          <Home
            disks={disks}
            home={home}
            reclaimable={reclaim}
            onScan={(p) => void startScan(p)}
            onClean={() => {
              setPage('clean');
              setCleanSeen(true);
            }}
          />
        </div>
        <div className={page === 'map' ? 'view' : 'view hidden'}>
          {scanning ? (
            <ScanProgressView root={root} home={home} progress={progress} expected={expected} onCancel={() => void api.cancelScan()} />
          ) : (
            result && (
              <Explorer
                result={result}
                home={home}
                onSummary={onDeleteSummary}
                onRescan={() => void startScan(result.root)}
                onAddRegular={addRegular}
                say={say}
              />
            )
          )}
        </div>
        {cleanSeen && (
          <div className={page === 'clean' ? 'view' : 'view hidden'}>
            <Clean cleaning={cleaning} home={home} say={say} onChanged={refreshDisks} />
          </div>
        )}
      </main>

      {showAbout && <About onClose={() => setShowAbout(false)} />}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">{t.text}</div>
        ))}
      </div>
      <span className="sr-only">{result ? plural(result.files, 'fichier analysé', 'fichiers analysés') : ''}</span>
    </div>
  );
}
