import clsx from 'clsx';
import { Check, ChevronDown } from 'lucide-react';
import type React from 'react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type TextBoxProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'className' | 'onChange' | 'type' | 'value'
> & {
  value: string;
  onChange: (value: string) => void;
  leadingIcon?: React.ReactNode;
  rightSlot?: React.ReactNode;
  className?: string;
  inputClassName?: string;
  type?: React.HTMLInputTypeAttribute;
};

export function TextBox({
  value,
  onChange,
  placeholder,
  readOnly = false,
  leadingIcon,
  rightSlot,
  className,
  inputClassName,
  type = 'text',
  style,
  ...inputProps
}: TextBoxProps) {
  return (
    <div className={clsx('flex h-6 items-center gap-2', className)}>
      {leadingIcon ? <div className="shrink-0 text-zinc-400">{leadingIcon}</div> : null}
      <input
        {...inputProps}
        type={type}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={clsx(
          'min-w-0 flex-1 rounded bg-transparent px-1 py-0 text-[14px] leading-6 text-zinc-800 caret-zinc-800 outline-none placeholder:text-zinc-400 disabled:cursor-default dark:text-zinc-200 dark:caret-zinc-200',
          inputClassName,
        )}
        style={{
          border: 'none',
          boxShadow: 'none',
          outline: 'none',
          background: 'transparent',
          ...style,
        }}
      />
      {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
    </div>
  );
}

export const TextField = TextBox;

type DropdownOption<TValue extends string> = {
  value: TValue;
  label: string;
};

type DropdownProps<TValue extends string> = {
  value: TValue;
  options: Array<DropdownOption<TValue>>;
  onChange: (value: TValue) => void;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
};

type DropdownMenuPosition = {
  left: number;
  top: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
};

export function calculateDropdownMenuPosition(
  trigger: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>,
  menu: { height: number; width: number },
  viewport: { height: number; width: number },
): DropdownMenuPosition {
  const gap = 4;
  const viewportPadding = 8;
  const spaceBelow = Math.max(0, viewport.height - trigger.bottom - gap - viewportPadding);
  const spaceAbove = Math.max(0, trigger.top - gap - viewportPadding);
  const openAbove = spaceBelow < menu.height && spaceAbove > spaceBelow;
  const maxHeight = openAbove ? spaceAbove : spaceBelow;
  const renderedHeight = Math.min(menu.height, maxHeight);
  const maxWidth = Math.max(0, viewport.width - viewportPadding * 2);
  const minWidth = Math.min(Math.max(trigger.width, menu.width, 80), maxWidth);
  const maxLeft = Math.max(viewportPadding, viewport.width - minWidth - viewportPadding);
  const left = Math.min(Math.max(viewportPadding, trigger.left), maxLeft);

  return {
    left,
    top: openAbove ? trigger.top - gap - renderedHeight : trigger.bottom + gap,
    minWidth,
    maxWidth,
    maxHeight,
  };
}

export function Dropdown<TValue extends string>({
  value,
  options,
  onChange,
  disabled = false,
  className,
  triggerClassName,
}: DropdownProps<TValue>) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({
    position: 'fixed',
    visibility: 'hidden',
  });

  const currentLabel = useMemo(
    () => options.find((option) => option.value === value)?.label ?? '',
    [options, value],
  );

  const selectedIndex = useMemo(() => {
    const index = options.findIndex((option) => option.value === value);
    return index >= 0 ? index : 0;
  }, [options, value]);

  const openMenu = (preferredIndex = selectedIndex) => {
    setMenuStyle({ position: 'fixed', visibility: 'hidden' });
    setHighlightedIndex(preferredIndex);
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
    setOpen(false);
  };

  const selectOption = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeMenu(true);
  };

  const focusOption = (index: number) => {
    const normalized = (index + options.length) % options.length;
    setHighlightedIndex(normalized);
    optionRefs.current[normalized]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => optionRefs.current[highlightedIndex]?.focus());
  }, [open, highlightedIndex]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return undefined;

    const updateMenuPosition = () => {
      if (!triggerRef.current || !menuRef.current) return;
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const menuRect = menuRef.current.getBoundingClientRect();
      const position = calculateDropdownMenuPosition(
        triggerRect,
        { height: menuRef.current.scrollHeight || menuRect.height, width: menuRect.width },
        { height: window.innerHeight, width: window.innerWidth },
      );
      setMenuStyle({
        position: 'fixed',
        ...position,
        visibility: 'visible',
      });
    };

    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    document.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      document.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (triggerRef.current && !triggerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  return (
    <div className={clsx('inline-flex items-center', className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          if (open) closeMenu();
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
              const offset = event.key === 'ArrowDown' ? 0 : -1;
              openMenu((selectedIndex + offset + options.length) % options.length);
            } else {
              focusOption(highlightedIndex + (event.key === 'ArrowDown' ? 1 : -1));
            }
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            if (!open) openMenu(event.key === 'Home' ? 0 : options.length - 1);
            else focusOption(event.key === 'Home' ? 0 : options.length - 1);
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            closeMenu();
          }
        }}
        className={clsx(
          'inline-flex h-6 w-fit items-center justify-between gap-1.5 rounded-lg border border-zinc-200 bg-white px-2 text-[11px] font-medium text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:border-zinc-700 dark:hover:bg-zinc-900 dark:focus:border-zinc-600 cursor-pointer disabled:cursor-default disabled:opacity-60',
          triggerClassName,
        )}
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown
          size={14}
          className={clsx('shrink-0 text-zinc-400 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={listboxId}
            role="listbox"
            aria-label="Choose an option"
            style={menuStyle}
            className="z-50 overflow-y-auto overflow-x-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {options.map((option, index) => {
              const active = option.value === value;
              return (
                <button
                  key={option.value}
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  type="button"
                  role="option"
                  aria-selected={active}
                  tabIndex={index === highlightedIndex ? 0 : -1}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectOption(index);
                  }}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      focusOption(index + (event.key === 'ArrowDown' ? 1 : -1));
                    } else if (event.key === 'Home' || event.key === 'End') {
                      event.preventDefault();
                      focusOption(event.key === 'Home' ? 0 : options.length - 1);
                    } else if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      selectOption(index);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      closeMenu(true);
                    } else if (event.key === 'Tab') {
                      closeMenu();
                    }
                  }}
                  className={clsx(
                    'flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs transition-colors cursor-pointer',
                    active
                      ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                      : 'text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/50',
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {active ? <Check size={14} className="shrink-0 text-zinc-500" /> : null}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

type ChoiceGroupOption<TValue extends string> = {
  value: TValue;
  label: string;
};

type ChoiceGroupProps<TValue extends string> = {
  value: TValue;
  options: Array<ChoiceGroupOption<TValue>>;
  onChange: (value: TValue) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
};

export function ChoiceGroup<TValue extends string>({
  value,
  options,
  onChange,
  disabled = false,
  className,
  ariaLabel = 'Choose an option',
}: ChoiceGroupProps<TValue>) {
  return (
    <fieldset
      aria-label={ariaLabel}
      disabled={disabled}
      className={clsx(
        'inline-flex rounded-xl border border-zinc-200 bg-zinc-100 p-1 dark:border-zinc-800 dark:bg-zinc-900',
        disabled && 'opacity-60',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={clsx(
              'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer disabled:cursor-default',
              active
                ? 'bg-white text-zinc-950 shadow-sm dark:bg-zinc-800 dark:text-zinc-50'
                : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}
