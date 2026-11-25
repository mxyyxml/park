import type { Quality } from '../render/Renderer';

export interface Settings {
  quality: Quality;
  fov: number;
  sensitivity: number;
  invertY: boolean;
  comfort: number;        // camera motion 0..1
  autoTurn: boolean;      // wall-jump view assist
  volume: number;
  showSpeed: boolean;
  reticle: boolean;
  runnerVision: boolean;  // highlight next checkpoint route
  autoQuality: boolean;   // lower quality by itself when the frame rate stays low
  night: boolean;
  slowMo: boolean;        // slow-motion moments on big jumps and takedowns (never in time trials)
  music: number;          // music volume 0..1         // night lighting in free run and trials (Night Run is always night)
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high', fov: 88, sensitivity: 1, invertY: false, comfort: 0.85, autoTurn: true, volume: 0.8,
  showSpeed: true, reticle: true, runnerVision: true, autoQuality: true, night: false, slowMo: true, music: 0.5,
};

export interface TrialRecord { best: number | null; splits: number[] | null; ghost: string | null; runs: number }

const KEY = 'skyline-runner/v1';

interface SaveData { settings: Settings; trials: Record<string, TrialRecord>; shards: number[]; seenHelp: boolean; calib: Record<string, number> }

function safeGet(): SaveData | null {
  try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}

export class Save {
  data: SaveData;
  constructor() {
    const d = safeGet();
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...(d?.settings ?? {}) },
      trials: d?.trials ?? {},
      shards: d?.shards ?? [],
      seenHelp: d?.seenHelp ?? false,
      calib: d?.calib ?? {},
    };
  }
  get settings() { return this.data.settings; }
  trial(id: string): TrialRecord {
    if (!this.data.trials[id]) this.data.trials[id] = { best: null, splits: null, ghost: null, runs: 0 };
    return this.data.trials[id];
  }
  flush() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); }
    catch {
      // storage full: drop ghosts first, keep times
      try {
        for (const t of Object.values(this.data.trials)) t.ghost = null;
        localStorage.setItem(KEY, JSON.stringify(this.data));
      } catch { /* storage unavailable: progress lives for this session only */ }
    }
  }
}
