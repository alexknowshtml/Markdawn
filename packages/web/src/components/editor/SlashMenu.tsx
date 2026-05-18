import Fuse from 'fuse.js';
import type React from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface SlashCommandItem {
  id: string;
  label: string;
  hint: string;
  shortcut?: string;
  keywords: string[];
  icon: React.ReactNode;
  onSelect: () => void;
}

interface SlashMenuProps {
  isOpen: boolean;
  query: string;
  position: { x: number; y: number; top?: number; bottom?: number } | null;
  commands: SlashCommandItem[];
  onClose: () => void;
}

const MENU_WIDTH = 320;
const MENU_OVERFLOW_THRESHOLD = 320;

export function SlashMenu({ isOpen, query, position, commands, onClose }: SlashMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom');
  const trimmedQuery = query.trim();

  const fuse = useMemo(() => {
    return new Fuse(commands, {
      keys: ['label', 'keywords'],
      threshold: 0.35,
      distance: 100,
      ignoreLocation: true,
    });
  }, [commands]);

  const results = useMemo(() => {
    if (!trimmedQuery) return commands;
    return fuse.search(trimmedQuery).map((result) => result.item);
  }, [commands, fuse, trimmedQuery]);

  useEffect(() => {
    if (isOpen) setSelectedIndex(0);
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, results.length - 1)));
  }, [results]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!isOpen || !position) {
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      return;
    }

    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const bottomCoord = position.bottom ?? position.y;
    const topCoord = position.top ?? position.y - 20;
    const nextPlacement =
      bottomCoord + MENU_OVERFLOW_THRESHOLD > viewportHeight - 20 ? 'top' : 'bottom';

    setPlacement(nextPlacement);

    el.style.position = 'fixed';
    el.style.left = `${Math.max(20, Math.min(position.x, viewportWidth - MENU_WIDTH - 20))}px`;
    el.style.opacity = '1';
    el.style.pointerEvents = 'auto';
    el.style.zIndex = '100';

    if (nextPlacement === 'top') {
      el.style.top = 'auto';
      el.style.bottom = `${viewportHeight - topCoord + 8}px`;
    } else {
      el.style.top = `${bottomCoord + 4}px`;
      el.style.bottom = 'auto';
    }
  }, [isOpen, position]);

  useEffect(() => {
    if (!isOpen) return;

    const list = listRef.current;
    if (!list) return;

    const buttons = list.querySelectorAll<HTMLElement>(':scope > button');
    const selectedButton = buttons[selectedIndex];
    if (!selectedButton) return;

    const listRect = list.getBoundingClientRect();
    const buttonRect = selectedButton.getBoundingClientRect();

    if (buttonRect.bottom > listRect.bottom) {
      list.scrollTop += buttonRect.bottom - listRect.bottom;
    } else if (buttonRect.top < listRect.top) {
      list.scrollTop -= listRect.top - buttonRect.top;
    }
  }, [selectedIndex, isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex((prev) => (results.length === 0 ? 0 : (prev + 1) % results.length));
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex((prev) =>
          results.length === 0 ? 0 : (prev - 1 + results.length) % results.length,
        );
        return;
      }

      if (event.key === 'Enter') {
        const selected = results[selectedIndex];
        if (!selected) return;
        event.preventDefault();
        event.stopPropagation();
        selected.onSelect();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose, results, selectedIndex]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      onClose();
    };

    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={containerRef}
      data-testid="slash-menu"
      className={`w-80 max-w-[calc(100vw-2rem)] rounded-xl border shadow-2xl overflow-hidden animate-in fade-in duration-100 ${
        placement === 'bottom'
          ? 'zoom-in-95 slide-in-from-top-2'
          : 'zoom-in-95 slide-in-from-bottom-2'
      } bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100`}
    >
      <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-500 border-b border-zinc-100 dark:border-zinc-800/50">
        Insert block
      </div>

      <div
        ref={listRef}
        className="max-h-[300px] overflow-y-auto p-1.5 space-y-0.5 scrollbar-thin scrollbar-thumb-zinc-200 dark:scrollbar-thumb-zinc-800"
      >
        {results.length === 0 ? (
          <div className="px-3 py-4 text-center text-sm text-zinc-500">No matching commands</div>
        ) : (
          results.map((command, index) => (
            <button
              key={command.id}
              type="button"
              onClick={command.onSelect}
              className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-all cursor-pointer ${
                index === selectedIndex
                  ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 shadow-sm'
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-300'
              }`}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700/50 text-xs font-semibold">
                {command.icon}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{command.label}</span>
              {command.shortcut && (
                <span className="text-xs text-zinc-500 dark:text-zinc-500 font-mono ml-auto pl-2">
                  {command.shortcut}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
