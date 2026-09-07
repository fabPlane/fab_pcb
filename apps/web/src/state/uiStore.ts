import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Unit } from '@/lib/units';

export type ThemeMode = 'system' | 'light' | 'dark';
/**
 * Canvas colour theme: 'auto' follows the UI theme, 'kicad-default' / 'kicad-classic' pin one of
 * the renderer's built-in themes, and `server:<name>` uses a theme read from KiCad itself
 * (`GetColorTheme`, resolved through the registry in canvas/theme.ts).
 */
export type CanvasThemeId = 'auto' | 'kicad-default' | 'kicad-classic' | `server:${string}`;
export type PanelSide = 'left' | 'right' | 'bottom';

export interface PanelLayout {
  size: number; // px
  collapsed: boolean;
}

export type DialogId =
  | 'board-setup'
  | 'netclasses'
  | 'text-variables'
  | 'variants'
  | 'keymap'
  | 'settings'
  | 'new-project'
  | 'about'
  | 'page-settings'
  | 'annotate'
  | 'update-pcb'
  | 'fields-table'
  | 'severities'
  | 'autoroute'
  | null;

interface UiState {
  /** UI theme preference. Defaults to dark for new users; a persisted value (any of the three) wins. */
  theme: ThemeMode;
  canvasTheme: CanvasThemeId;
  units: Unit;
  gridNm: number;
  showGrid: boolean;
  /** Board ratsnest overlay (renderer layer `board.ratsnest`). */
  showRatsnest: boolean;
  panels: Record<PanelSide, PanelLayout>;
  bottomTab: 'markers' | 'jobs' | 'log' | 'history';
  leftTab: 'tree' | 'layers' | 'nets';
  dialog: DialogId;
  setTheme(t: ThemeMode): void;
  setCanvasTheme(id: CanvasThemeId): void;
  cycleUnits(): void;
  setUnits(u: Unit): void;
  setGrid(nm: number): void;
  toggleGrid(): void;
  toggleRatsnest(): void;
  setRatsnest(on: boolean): void;
  setPanelSize(side: PanelSide, size: number): void;
  togglePanel(side: PanelSide, collapsed?: boolean): void;
  setBottomTab(tab: UiState['bottomTab']): void;
  setLeftTab(tab: UiState['leftTab']): void;
  openDialog(id: DialogId): void;
  resetLayout(): void;
}

const DEFAULT_PANELS: Record<PanelSide, PanelLayout> = {
  left: { size: 260, collapsed: false },
  right: { size: 320, collapsed: false },
  bottom: { size: 220, collapsed: false },
};

export const PANEL_LIMITS: Record<PanelSide, { min: number; max: number }> = {
  left: { min: 180, max: 520 },
  right: { min: 240, max: 640 },
  bottom: { min: 120, max: 600 },
};

export const GRID_CHOICES_NM = [5_000_000, 2_540_000, 1_270_000, 1_000_000, 635_000, 500_000, 254_000, 250_000, 127_000, 100_000, 50_000, 25_400];

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      canvasTheme: 'auto',
      units: 'mm',
      gridNm: 1_270_000,
      showGrid: true,
      showRatsnest: true,
      panels: DEFAULT_PANELS,
      bottomTab: 'markers',
      leftTab: 'tree',
      dialog: null,
      setTheme: (theme) => set({ theme }),
      setCanvasTheme: (canvasTheme) => set({ canvasTheme }),
      setUnits: (units) => set({ units }),
      cycleUnits: () => {
        const order: Unit[] = ['mm', 'mil', 'in'];
        const i = order.indexOf(get().units);
        set({ units: order[(i + 1) % order.length]! });
      },
      setGrid: (gridNm) => set({ gridNm }),
      toggleGrid: () => set({ showGrid: !get().showGrid }),
      toggleRatsnest: () => set({ showRatsnest: !get().showRatsnest }),
      setRatsnest: (showRatsnest) => set({ showRatsnest }),
      setPanelSize: (side, size) => {
        const { min, max } = PANEL_LIMITS[side];
        set({ panels: { ...get().panels, [side]: { ...get().panels[side], size: Math.max(min, Math.min(max, size)) } } });
      },
      togglePanel: (side, collapsed) =>
        set({ panels: { ...get().panels, [side]: { ...get().panels[side], collapsed: collapsed ?? !get().panels[side].collapsed } } }),
      setBottomTab: (bottomTab) => set({ bottomTab, panels: { ...get().panels, bottom: { ...get().panels.bottom, collapsed: false } } }),
      setLeftTab: (leftTab) => set({ leftTab, panels: { ...get().panels, left: { ...get().panels.left, collapsed: false } } }),
      openDialog: (dialog) => set({ dialog }),
      resetLayout: () => set({ panels: DEFAULT_PANELS }),
    }),
    {
      name: 'kicad-web.ui',
      version: 1,
      partialize: (s) => ({ theme: s.theme, canvasTheme: s.canvasTheme, units: s.units, gridNm: s.gridNm, showGrid: s.showGrid, showRatsnest: s.showRatsnest, panels: s.panels, bottomTab: s.bottomTab, leftTab: s.leftTab }),
    },
  ),
);

/** Resolves 'system' against prefers-color-scheme (dark when media queries are unavailable). */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}
