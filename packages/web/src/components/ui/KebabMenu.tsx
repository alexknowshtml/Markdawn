import { FloatingPortal } from '@floating-ui/react';
import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useId } from 'react';
import { useKebabMenu } from '../../hooks/useKebabMenu';

export type KebabMenuItem = {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
};

type KebabMenuProps = {
  items: KebabMenuItem[];
  triggerClassName?: string;
  menuClassName?: string;
  onOpenChange?: (isOpen: boolean) => void;
};

const defaultMenuItemClass =
  'flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 w-full text-left cursor-pointer rounded-xl transition-colors';

const defaultMenuClass =
  'w-40 bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/5 shadow-xl rounded-xl p-1.5 flex flex-col z-[9999]';

export function KebabMenu({
  items,
  triggerClassName,
  menuClassName,
  onOpenChange,
}: KebabMenuProps) {
  const kebab = useKebabMenu();
  const menuId = useId();

  useEffect(() => {
    onOpenChange?.(kebab.isMounted);
  }, [kebab.isMounted, onOpenChange]);

  return (
    <>
      <button
        ref={kebab.refs.setReference}
        type="button"
        id={menuId}
        aria-label="Open menu"
        className={`${triggerClassName ?? ''} ${kebab.isOpen ? 'opacity-100 bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100' : ''}`}
        {...kebab.getReferenceProps({ onClick: (e) => e.stopPropagation() })}
      >
        <MoreHorizontal size={16} />
      </button>

      {kebab.isMounted && (
        <FloatingPortal>
          <div
            ref={kebab.refs.setFloating}
            style={kebab.floatingStyles}
            {...kebab.getFloatingProps()}
            className="z-[9999]"
          >
            <div
              style={kebab.transitionStyles}
              role="menu"
              aria-labelledby={menuId}
              className={menuClassName ?? defaultMenuClass}
            >
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    kebab.close();
                    item.onClick();
                  }}
                  className={`${defaultMenuItemClass} ${item.className ?? ''}`}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
