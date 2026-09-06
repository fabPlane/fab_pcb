import { useCallback, useRef, useState } from 'react';

interface SplitterProps {
  direction: 'vertical' | 'horizontal'; // vertical = resizes width (col-resize)
  onDelta(delta: number): void;
  onDoubleClick?(): void;
  label: string;
}

export function Splitter({ direction, onDelta, onDoubleClick, label }: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const last = useRef(0);

  const onPointerDown = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>) => {
      ev.preventDefault();
      (ev.currentTarget as HTMLDivElement).setPointerCapture(ev.pointerId);
      last.current = direction === 'vertical' ? ev.clientX : ev.clientY;
      setDragging(true);
    },
    [direction],
  );
  const onPointerMove = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const cur = direction === 'vertical' ? ev.clientX : ev.clientY;
      const delta = cur - last.current;
      if (delta !== 0) {
        last.current = cur;
        onDelta(delta);
      }
    },
    [dragging, direction, onDelta],
  );
  const onPointerUp = useCallback((ev: React.PointerEvent<HTMLDivElement>) => {
    (ev.currentTarget as HTMLDivElement).releasePointerCapture(ev.pointerId);
    setDragging(false);
  }, []);

  return (
    <div
      className={`splitter ${direction}${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-label={label}
      aria-orientation={direction === 'vertical' ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
    />
  );
}
