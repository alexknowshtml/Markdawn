import {
  FloatingFocusManager,
  FloatingOverlay,
  FloatingPortal,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import { useId, useRef } from 'react';

type ConfirmDialogProps = {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  loadingText?: string;
  showCancel?: boolean;
};

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
  loading = false,
  loadingText = 'Deleting...',
  showCancel = true,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { refs, context } = useFloating({
    open: isOpen,
    onOpenChange: (open) => {
      if (!open && !loading) onCancel();
    },
  });
  const dismiss = useDismiss(context, { enabled: !loading, outsidePressEvent: 'mousedown' });
  const { getFloatingProps } = useInteractions([dismiss]);

  if (!isOpen) return null;

  return (
    <FloatingPortal>
      <FloatingOverlay
        lockScroll
        className="z-[9999] flex items-center justify-center bg-zinc-900/40 backdrop-blur-sm px-4 animate-fade-in"
      >
        <FloatingFocusManager
          context={context}
          {...(showCancel ? { initialFocus: cancelRef } : {})}
          returnFocus
        >
          <div
            ref={refs.setFloating}
            role="alertdialog"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            {...getFloatingProps()}
            className="w-full max-w-md rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 shadow-xl animate-slide-up"
          >
            <h2 id={titleId} className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              {title}
            </h2>
            <p id={descriptionId} className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {message}
            </p>

            <div className="mt-6 flex items-center justify-end gap-2">
              {showCancel && (
                <button
                  ref={cancelRef}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancel();
                  }}
                  className="px-3 py-2 text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-50 cursor-pointer disabled:cursor-not-allowed"
                  disabled={loading}
                >
                  {cancelText}
                </button>
              )}
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onConfirm();
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 dark:bg-red-700 rounded-md hover:bg-red-700 dark:hover:bg-red-800 transition-colors disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
                disabled={loading}
              >
                {loading ? loadingText : confirmText}
              </button>
            </div>
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  );
}
