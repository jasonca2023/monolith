/**
 * The renderer's view of the preload bridge.
 *
 * Every type here is re-exported from src/shared/types.ts — the single
 * declaration the main process also compiles against — so a change to the
 * config schema or a shift report reaches the UI as a type error rather than
 * as a silent disagreement. The only thing this module adds is the global
 * `window.monolith` augmentation, which is renderer-specific.
 */

export type {
  ActuationResult,
  ActuationStatus,
  BridgeEvent,
  BrowserDispatchResult,
  BrowserSignal,
  DigitalPurge,
  DisengageReport,
  FocusResult,
  FocusStatus,
  HueBridgeCandidate,
  HueDiscoveryResult,
  HuePairResult,
  KillResult,
  LaunchResult,
  MonolithApi,
  MonolithConfig,
  PhysicalOrchestration,
  Profile,
  RealityShiftReport,
  SonicLayering,
  SpotifyAuthResult,
  SystemInfo,
  UserSettings,
} from '../src/shared/types';

import type { MonolithApi } from '../src/shared/types';

declare global {
  interface Window {
    /** Absent when the renderer is opened outside the Electron shell. */
    monolith?: MonolithApi;
  }
}
