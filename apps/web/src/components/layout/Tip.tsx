import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export function TipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={500} skipDelayDuration={200}>
      {children}
    </Tooltip.Provider>
  );
}

export function Tip({ text, children }: { text: ReactNode; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={4}>
          {text}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
