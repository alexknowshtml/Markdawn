import { IconCheck, IconInfoCircle, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Toast {
  id: number;
  message: string;
  icon: React.ReactNode;
  autoClose: number;
}

type AddToastFn = (toast: Omit<Toast, 'id'>) => void;

let addToast: AddToastFn | null = null;
let clearToastQueue: (() => void) | null = null;

export function showSuccessToast(message: string) {
  addToast?.({ message, icon: <IconCheck size={16} />, autoClose: 4000 });
}

export function showErrorToast(message: string) {
  addToast?.({ message, icon: <IconX size={16} />, autoClose: 5000 });
}

export function showInfoToast(message: string) {
  addToast?.({ message, icon: <IconInfoCircle size={16} />, autoClose: 4000 });
}

export function clearToasts() {
  clearToastQueue?.();
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const add = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { ...toast, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, toast.autoClose);
  }, []);
  const clear = useCallback(() => setToasts([]), []);

  useEffect(() => {
    addToast = add;
    clearToastQueue = clear;
    return () => {
      if (addToast === add) addToast = null;
      if (clearToastQueue === clear) clearToastQueue = null;
    };
  }, [add, clear]);

  return (
    <>
      {children}
      {createPortal(
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[70] flex flex-col gap-2 pointer-events-none">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={clsx(
                'pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border animate-slide-down',
                'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-50',
              )}
              style={{ minWidth: '240px', maxWidth: '420px' }}
            >
              <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{toast.icon}</span>
              <span className="text-sm font-medium">{toast.message}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
