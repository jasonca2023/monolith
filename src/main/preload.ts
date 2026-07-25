/**
 * Monolith — preload bridge.
 *
 * The only surface the renderer gets. Everything is a promise, nothing exposes
 * `ipcRenderer` itself, and every channel name is fixed at build time.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { BridgeEvent, MonolithApi } from '../shared/types';

export type { MonolithApi };

const api: MonolithApi = {
  executeRealityShift: (profilePayload) => ipcRenderer.invoke('execute-reality-shift', profilePayload),
  executeDisengage: (profileId) => ipcRenderer.invoke('execute-disengage', profileId),
  dispatchBrowserSignal: (signal, payload) =>
    ipcRenderer.invoke('dispatch-browser-signal', signal, payload),
  readConfig: () => ipcRenderer.invoke('config:read'),
  writeConfig: (config) => ipcRenderer.invoke('config:write', config),
  systemInfo: () => ipcRenderer.invoke('system:info'),
  pickApplications: () => ipcRenderer.invoke('dialog:pick-applications'),
  authorizeSpotify: () => ipcRenderer.invoke('spotify:authorize'),
  discoverHueBridges: () => ipcRenderer.invoke('hue:discover'),
  pairHueBridge: (ip) => ipcRenderer.invoke('hue:pair', ip),
  onBridgeEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: BridgeEvent) => listener(payload);
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
