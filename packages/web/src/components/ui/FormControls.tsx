import { FloatingPortal } from '@floating-ui/react';
import clsx from 'clsx';
import { Check, ChevronDown } from 'lucide-react';
import type React from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useFloatingMenu } from '../../hooks/useFloatingMenu';

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
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
};

export function Dropdown<TValue extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className,
  triggerClassName,
}: DropdownProps<TValue>) {
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();

  const currentLabel = useMemo(
    () => options.find((option) => option.value === value)?.label ?? '',
    [options, value],
  );

  const selectedIndex = useMemo(() => {
    const index = options.findIndex((option) => option.value === value);
    return index >= 0 ? index : 0;
  }, [options, value]);

  const menu = useFloatingMenu({
    align: 'start',
    matchReferenceWidth: true,
    role: 'listbox',
    onOpen: () => setHighlightedIndex(selectedIndex),
  });
  const open = menu.isOpen;

  const openMenu = (preferredIndex = selectedIndex) => {
    setHighlightedIndex(preferredIndex);
    menu.open();
  };

  const closeMenu = (restoreFocus = false) => {
    if (restoreFocus) {
      const reference = menu.refs.domReference.current;
      if (reference instanceof HTMLElement) reference.focus();
    }
    menu.close();
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

  return (
    <div className={clsx('inline-flex items-center', className)}>
      <button
        ref={menu.refs.setReference}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        {...menu.getReferenceProps({
          onKeyDown: (event) => {
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
          },
        })}
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

      {menu.isMounted && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            id={listboxId}
            role="listbox"
            aria-label="Choose an option"
            style={{ ...menu.floatingStyles, ...menu.transitionStyles }}
            {...menu.getFloatingProps()}
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
          </div>
        </FloatingPortal>
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
