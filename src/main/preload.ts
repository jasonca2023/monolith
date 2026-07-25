/**
 * Monolith — preload bridge.
 *
 * The only surface the renderer gets. Everything is a promise, nothing exposes
 * `ipcRenderer` itself, and every channel name is fixed at build time.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export interface MonolithApi {
  /** Accepts a full profile object, a profile id, or a bare array of app paths. */
  executeRealityShift(profilePayload: unknown): Promise<unknown>;
  /** Exit sequence: OS focus off, lights to neutral white, session rehydrated. */
  executeDisengage(profileId: string): Promise<unknown>;
  dispatchBrowserSignal(
    signal: 'AGGRESSIVE_PURGE' | 'HYDRATE_SESSION',
    payload?: unknown,
  ): Promise<unknown>;
  readConfig(): Promise<unknown>;
  writeConfig(config: unknown): Promise<unknown>;
  systemInfo(): Promise<unknown>;
  onBridgeEvent(listener: (event: unknown) => void): () => void;
  /** The shell is frameless, so the renderer owns the window controls. */
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
  };
}

const api: MonolithApi = {
  executeRealityShift: (profilePayload) => ipcRenderer.invoke('execute-reality-shift', profilePayload),
  executeDisengage: (profileId) => ipcRenderer.invoke('execute-disengage', profileId),
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
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },
};

contextBridge.exposeInMainWorld('monolith', api);
