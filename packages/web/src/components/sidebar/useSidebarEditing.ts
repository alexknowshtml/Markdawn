import type { KeyboardEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidebarEditingTarget } from './sidebarRuntime';

type SidebarEditingOptions = {
  canRenameEntity(kind: 'page' | 'folder', id: string): boolean;
  renamePage(pageId: string, title: string, onSettled: () => void): void;
  renameFolder(folderId: string, name: string, onSettled: () => void): void;
};

export function useSidebarEditing({
  canRenameEntity,
  renamePage,
  renameFolder,
}: SidebarEditingOptions) {
  const [target, setTarget] = useState<SidebarEditingTarget>(null);
  const editingAllowed = target ? canRenameEntity(target.kind, target.id) : false;
  const canRenameRef = useRef(canRenameEntity);
  canRenameRef.current = canRenameEntity;

  useEffect(() => {
    if (target && !editingAllowed) setTarget(null);
  }, [editingAllowed, target]);

  const updateTarget = useCallback((nextTarget: SidebarEditingTarget) => {
    if (nextTarget === null || canRenameRef.current(nextTarget.kind, nextTarget.id)) {
      setTarget(nextTarget);
    }
  }, []);

  const save = useCallback(() => {
    if (!target) return;
    if (!canRenameRef.current(target.kind, target.id)) {
      setTarget(null);
      return;
    }
    const value = target.value.trim();
    const onSettled = () => setTarget(null);
    if (target.kind === 'folder') {
      renameFolder(target.id, value || 'New Folder', onSettled);
    } else {
      renamePage(target.id, value || 'Untitled', onSettled);
    }
  }, [renameFolder, renamePage, target]);

  return {
    target,
    setTarget: updateTarget,
    save,
    onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Enter') save();
      else if (event.key === 'Escape') setTarget(null);
    },
  };
}
