import { Check, ChevronDown } from 'lucide-react';
import { useRef, useState } from 'react';
import type { OrgWithWorkspaces } from '../../hooks/use-orgs';
import type { SelectedOrg } from '../../hooks/use-org-picker';
import type { OrgColor } from '../../utils/orgColors';
import { useClickOutside } from '../../hooks/useClickOutside';

interface OrgPickerProps {
  orgs: OrgWithWorkspaces[];
  selectedOrg: SelectedOrg;
  orgColorMap: Map<string, OrgColor>;
  onSelect: (id: SelectedOrg) => void;
}

export function OrgPicker({ orgs, selectedOrg, orgColorMap, onSelect }: OrgPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));

  const activeOrg = selectedOrg !== 'all' ? orgs.find((o) => o.id === selectedOrg) : null;
  const activeColor = activeOrg ? orgColorMap.get(activeOrg.id) : null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
      >
        {activeColor ? (
          <span className={`h-2 w-2 rounded-full shrink-0 ${activeColor.dot}`} />
        ) : (
          <span className="h-2 w-2 rounded-full shrink-0 bg-zinc-400" />
        )}
        <span className="flex-1 truncate text-left">
          {activeOrg ? activeOrg.name : 'All Workspaces'}
        </span>
        <ChevronDown size={14} className="shrink-0 text-zinc-400" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
          {orgs.map((org) => {
            const color = orgColorMap.get(org.id);
            const isActive = selectedOrg === org.id;
            return (
              <button
                key={org.id}
                type="button"
                onClick={() => { onSelect(org.id); setOpen(false); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-700 cursor-pointer"
              >
                {color && <span className={`h-2 w-2 rounded-full shrink-0 ${color.dot}`} />}
                <span className="flex-1 truncate">{org.name}</span>
                {isActive && <Check size={13} className="shrink-0 text-zinc-500" />}
              </button>
            );
          })}
          <div className="my-1 border-t border-zinc-100 dark:border-zinc-700" />
          <button
            type="button"
            onClick={() => { onSelect('all'); setOpen(false); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-700 cursor-pointer"
          >
            <span className="h-2 w-2 rounded-full shrink-0 bg-zinc-400" />
            <span className="flex-1">All Workspaces</span>
            {selectedOrg === 'all' && <Check size={13} className="shrink-0 text-zinc-500" />}
          </button>
        </div>
      )}
    </div>
  );
}
