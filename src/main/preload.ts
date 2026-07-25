/**
 * Monolith — preload bridge.
 *
 * The only surface the renderer gets. Everything is a promise, nothing exposes
 * `ipcRenderer` itself, and every channel name is fixed at build time.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export interface MonolithApi {
  executeRealityShift(paths: string[]): Promise<unknown>;
  dispatchBrowserSignal(
    signal: 'AGGRESSIVE_PURGE' | 'HYDRATE_SESSION',
    payload?: unknown,
  ): Promise<unknown>;
  readConfig(): Promise<unknown>;
  writeConfig(config: unknown): Promise<unknown>;
  systemInfo(): Promise<unknown>;
  onBridgeEvent(listener: (event: unknown) => void): () => void;
}

const api: MonolithApi = {
  executeRealityShift: (paths) => ipcRenderer.invoke('execute-reality-shift', paths),
  dispatchBrowserSignal: (signal, payload) =>
    ipcRenderer.invoke('dispatch-browser-signal', signal, payload),
  readConfig: () => ipcRenderer.invoke('config:read'),
  writeConfig: (config) => ipcRenderer.invoke('config:write', config),
  systemInfo: () => ipcRenderer.invoke('system:info'),
  onBridgeEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on('bridge:event', handler);
    return () => ipcRenderer.removeListener('bridge:event', handler);
  },
};

contextBridge.exposeInMainWorld('monolith', api);
