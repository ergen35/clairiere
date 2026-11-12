import type { Api, CleanProgress, ScanProgress, TargetMeasure } from '../shared/types';
import { demoApi } from './demo';

interface Bridge {
  invoke(name: string, ...args: unknown[]): Promise<never>;
  on(cb: (event: string, data: unknown) => void): () => void;
}

declare global {
  interface Window {
    clairiere?: Bridge;
  }
}

function desktopApi(bridge: Bridge): Api {
  const call = bridge.invoke;
  const listeners = new Map<string, (data: unknown) => void>();
  bridge.on((event, data) => listeners.get(event)?.(data));

  async function withListener<T>(event: string, cb: (data: never) => void, run: () => Promise<T>): Promise<T> {
    const listener = cb as (data: unknown) => void;
    listeners.set(event, listener);
    try {
      return await run();
    } finally {
      // A newer call may have taken over this event by now: leave its listener in place.
      if (listeners.get(event) === listener) listeners.delete(event);
    }
  }

  return {
    isDemo: false,
    platform: () => call('platform'),
    getLanguage: () => call('getLanguage'),
    setLanguage: (lang) => call('setLanguage', lang),
    openDiskAccessSettings: () => call('openDiskAccessSettings'),
    home: () => call('home'),
    disks: () => call('disks'),
    scan: (path, onProgress: (p: ScanProgress) => void) => withListener('scan:progress', onProgress, () => call('scan', path)),
    cancelScan: () => call('cancelScan'),
    view: (node, options) => call('view', node, options),
    pickFolder: () => call('pickFolder'),
    checkItems: (paths) => call('checkItems', paths),
    deleteItems: (items, mode) => call('deleteItems', items, mode),
    open: (path) => call('open', path),
    reveal: (path) => call('reveal', path),
    copyPath: (path) => call('copyPath', path),
    cleanTargets: () => call('cleanTargets'),
    measureTargets: async (onMeasure: (m: TargetMeasure) => void) => {
      const all: TargetMeasure[] = await withListener('clean:measure', onMeasure, () => call('measureTargets'));
      // Whatever arrived too late for the listener is in the final answer.
      all.forEach(onMeasure);
    },
    setTargetSelected: (id, selected) => call('setTargetSelected', id, selected),
    cleanRun: (ids, onProgress: (p: CleanProgress) => void) => withListener('clean:progress', onProgress, () => call('cleanRun', ids)),
    cancelClean: () => call('cancelClean'),
    addCustomTarget: (path) => call('addCustomTarget', path),
    removeCustomTarget: (id) => call('removeCustomTarget', id),
    stats: () => call('stats'),
    setAutoClean: (on) => call('setAutoClean', on),
    runAutoClean: () => call('runAutoClean'),
    findProjects: () => call('findProjects'),
    launcherInstalled: () => call('launcherInstalled'),
    installLauncher: () => call('installLauncher'),
    openLink: (url) => call('openLink', url),
  };
}

/** The real computer in the desktop app; sample data when opened as a plain web page. */
export const api: Api = window.clairiere ? desktopApi(window.clairiere) : demoApi();
