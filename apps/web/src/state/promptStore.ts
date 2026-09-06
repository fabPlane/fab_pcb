// A promise-based modal prompt (`await prompt({...})`) used by the placement tools for the
// bits KiCad asks in a dialog: a label's text, a LIB_ID, a rotation angle, a zone's net.
// `PromptDialog` renders the open spec; `useKeyboard` stays out of the way while one is open.

import { create } from 'zustand';

export type PromptFieldType = 'string' | 'number' | 'distance' | 'select' | 'boolean' | 'multiline';

export interface PromptField {
  key: string;
  label: string;
  type: PromptFieldType;
  default?: unknown;
  choices?: { value: string; label: string }[];
  help?: string;
  placeholder?: string;
}

export interface PromptSpec {
  title: string;
  description?: string;
  fields: PromptField[];
  okLabel?: string;
}

interface PromptState {
  spec: PromptSpec | null;
  resolve: ((values: Record<string, unknown> | null) => void) | null;
  prompt(spec: PromptSpec): Promise<Record<string, unknown> | null>;
  finish(values: Record<string, unknown> | null): void;
}

export const usePromptStore = create<PromptState>((set, get) => ({
  spec: null,
  resolve: null,
  prompt: (spec) => {
    get().resolve?.(null);
    return new Promise((resolve) => set({ spec, resolve }));
  },
  finish: (values) => {
    const r = get().resolve;
    set({ spec: null, resolve: null });
    r?.(values);
  },
}));

/** Convenience for command code. */
export function prompt(spec: PromptSpec): Promise<Record<string, unknown> | null> {
  return usePromptStore.getState().prompt(spec);
}

/** Single-field shorthand: resolves the value or null. */
export async function promptValue<T = string>(title: string, field: Omit<PromptField, 'key'>, description?: string): Promise<T | null> {
  const r = await prompt({ title, description, fields: [{ key: 'value', ...field }] });
  return r ? (r.value as T) : null;
}
