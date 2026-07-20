import { useCallback, useEffect, useMemo, useState } from 'react';

export function useSidebarController(folderIds: readonly string[]) {
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (initialized || folderIds.length === 0) return;
    setExpandedFolderIds(new Set(folderIds));
    setInitialized(true);
  }, [folderIds, initialized]);

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedFolderIds((previous) => {
      const next = new Set(previous);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);
  const allExpanded = useMemo(
    () => folderIds.length > 0 && folderIds.every((id) => expandedFolderIds.has(id)),
    [folderIds, expandedFolderIds],
  );
  const toggleAll = useCallback(() => {
    setExpandedFolderIds(allExpanded ? new Set() : new Set(folderIds));
  }, [allExpanded, folderIds]);
  const expandFolder = useCallback((folderId: string) => {
    setExpandedFolderIds((previous) => new Set(previous).add(folderId));
  }, []);
  const toggleSection = useCallback((section: string) => {
    setCollapsedSections((previous) => {
      const next = new Set(previous);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }, []);
  const toggleWorkspace = useCallback((ownerId: string) => {
    setCollapsedWorkspaceIds((previous) => {
      const next = new Set(previous);
      if (next.has(ownerId)) next.delete(ownerId);
      else next.add(ownerId);
      return next;
    });
  }, []);

  return {
    allExpanded,
    collapsedSections,
    collapsedWorkspaceIds,
    expandFolder,
    expandedFolderIds,
    toggleAll,
    toggleFolder,
    toggleSection,
    toggleWorkspace,
  };
}
