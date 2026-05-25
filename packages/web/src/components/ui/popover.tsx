import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';

interface PopoverProps {
  opened: boolean;
  onChange: (opened: boolean) => void;
  children: React.ReactNode;
  className?: string;
}

export function Popover({ opened, onChange, children, className }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback(
    (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onChange(false);
      }
    },
    [onChange],
  );

  const handleEscape = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onChange(false);
      }
    },
    [onChange],
  );

  useEffect(() => {
    if (!opened) return;

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [opened, handleClickOutside, handleEscape]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
