import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('clairiere', {
  invoke: (name: string, ...args: unknown[]) => ipcRenderer.invoke(`clairiere:${name}`, ...args),
  on: (cb: (event: string, data: unknown) => void) => {
    const listener = (_: unknown, event: string, data: unknown) => cb(event, data);
    ipcRenderer.on('clairiere:event', listener);
    return () => ipcRenderer.removeListener('clairiere:event', listener);
  },
});
