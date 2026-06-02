import clsx from 'clsx';
import { Check, ChevronDown } from 'lucide-react';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type TextBoxProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  leadingIcon?: React.ReactNode;
  rightSlot?: React.ReactNode;
  className?: string;
  inputClassName?: string;
  type?: 'email' | 'text' | 'url';
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
}: TextBoxProps) {
  return (
    <div className={clsx('flex h-6 items-center gap-2', className)}>
      {leadingIcon ? <div className="shrink-0 text-zinc-400">{leadingIcon}</div> : null}
      <input
        type={type}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={clsx(
          'min-w-0 flex-1 rounded bg-transparent px-1 py-0 text-[14px] leading-6 text-zinc-800 caret-zinc-800 outline-none placeholder:text-zinc-400 disabled:cursor-default dark:text-zinc-200 dark:caret-zinc-200',
          inputClassName,
        )}
        style={{ border: 'none', boxShadow: 'none', outline: 'none', background: 'transparent' }}
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

export function Dropdown<TValue extends string>({
  value,
  options,
  onChange,
  disabled = false,
  className,
  triggerClassName,
}: DropdownProps<TValue>) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  const currentLabel = useMemo(
    () => options.find((option) => option.value === value)?.label ?? '',
    [options, value],
  );

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuStyle({
      position: 'fixed',
      left: rect.left,
      top: rect.bottom + 4,
      minWidth: Math.max(rect.width, 80),
    });
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
        onClick={() => setOpen((prev) => !prev)}
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
            role="listbox"
            style={menuStyle}
            className="z-50 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {options.map((option) => {
              const active = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onChange(option.value);
                    setOpen(false);
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
};

export function ChoiceGroup<TValue extends string>({
  value,
  options,
  onChange,
  disabled = false,
  className,
}: ChoiceGroupProps<TValue>) {
  return (
    <div
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
    </div>
  );
}
