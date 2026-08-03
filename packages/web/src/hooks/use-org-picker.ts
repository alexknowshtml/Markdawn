import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'markdawn-selected-org';

export type SelectedOrg = string | 'all';

export function useOrgPicker(orgIds: string[]): {
  selectedOrg: SelectedOrg;
  setSelectedOrg: (id: SelectedOrg) => void;
} {
  const [selectedOrg, setSelectedOrgState] = useState<SelectedOrg>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'all' || (stored && orgIds.includes(stored))) return stored;
    } catch {
      // ignore
    }
    return orgIds[0] ?? 'all';
  });

  // If stored org is no longer in the list, fall back to first available
  useEffect(() => {
    if (selectedOrg !== 'all' && orgIds.length > 0 && !orgIds.includes(selectedOrg)) {
      setSelectedOrgState(orgIds[0] ?? 'all');
    }
  }, [orgIds, selectedOrg]);

  const setSelectedOrg = useCallback((id: SelectedOrg) => {
    setSelectedOrgState(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // ignore
    }
  }, []);

  return { selectedOrg, setSelectedOrg };
}
