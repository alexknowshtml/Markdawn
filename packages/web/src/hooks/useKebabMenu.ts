import type { ReferenceType } from '@floating-ui/react';
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
  useTransitionStyles,
} from '@floating-ui/react';
import { useCallback, useState } from 'react';

interface UseKebabMenuOptions {
  align?: 'start' | 'end';
  sideOffset?: number;
}

interface UseKebabMenuReturn {
  isOpen: boolean;
  isMounted: boolean;
  close: () => void;
  refs: ReturnType<typeof useFloating<ReferenceType>>['refs'];
  floatingStyles: React.CSSProperties;
  transitionStyles: React.CSSProperties;
  getReferenceProps: ReturnType<typeof useInteractions>['getReferenceProps'];
  getFloatingProps: ReturnType<typeof useInteractions>['getFloatingProps'];
}

export function useKebabMenu({
  align = 'end',
  sideOffset = 4,
}: UseKebabMenuOptions = {}): UseKebabMenuReturn {
  const [isOpen, setIsOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    placement: `bottom-${align}`,
    middleware: [offset(sideOffset), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    open: isOpen,
    onOpenChange: setIsOpen,
  });

  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    initial: { opacity: 0 },
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  const close = useCallback(() => setIsOpen(false), []);

  return {
    isOpen,
    isMounted,
    close,
    refs,
    floatingStyles,
    transitionStyles,
    getReferenceProps,
    getFloatingProps,
  };
}
