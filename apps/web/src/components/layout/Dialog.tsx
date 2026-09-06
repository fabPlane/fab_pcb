import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  size?: 'narrow' | 'normal' | 'wide';
  footer?: ReactNode;
  noPad?: boolean;
  children: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, size = 'normal', footer, noPad, children }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay" />
        <RadixDialog.Content className={`dialog${size === 'wide' ? ' wide' : size === 'narrow' ? ' narrow' : ''}`} aria-describedby={description ? undefined : ''}>
          <div className="dialog-title">
            <RadixDialog.Title asChild>
              <span>{title}</span>
            </RadixDialog.Title>
            <span className="spacer" />
            <RadixDialog.Close asChild>
              <button className="btn ghost icon" aria-label="Close">
                ×
              </button>
            </RadixDialog.Close>
          </div>
          <div className={`dialog-body${noPad ? ' no-pad' : ''}`}>
            {description && (
              <RadixDialog.Description asChild>
                <p className="dialog-desc">{description}</p>
              </RadixDialog.Description>
            )}
            {children}
          </div>
          {footer && <div className="dialog-footer">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
