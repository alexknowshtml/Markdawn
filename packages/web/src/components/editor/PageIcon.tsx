import { FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useIsReadOnly } from '../../contexts/EditorReadOnlyContext';
import { useShareContext } from '../../contexts/ShareContext';
import { useUpdatePage } from '../../hooks/use-pages';
import { EmojiPicker } from '../EmojiPicker';

interface PageIconProps {
  pageId: string;
  initialIcon: string | null;
}

export function PageIcon({ pageId, initialIcon }: PageIconProps) {
  const readOnly = useIsReadOnly();
  const { isAnonymous } = useShareContext();
  const [icon, setIcon] = useState<string | null>(initialIcon);
  const updatePageMutation = useUpdatePage();

  useEffect(() => {
    setIcon(initialIcon);
  }, [initialIcon]);

  const handleIconChange = async (newIcon: string | null) => {
    if (readOnly) return;
    setIcon(newIcon);
    try {
      await updatePageMutation.mutateAsync({
        pageId,
        updates: { icon: newIcon },
      });
    } catch {
      // Error toast handled globally by MutationCache.onError
      setIcon(initialIcon);
    }
  };

  const content = (
    <div className="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-4xl">
      {icon ? icon : <FileText className="w-8 h-8 text-zinc-400 dark:text-zinc-500" />}
    </div>
  );

  if (readOnly || isAnonymous) {
    return content;
  }

  return (
    <EmojiPicker icon={icon} onChange={handleIconChange}>
      {content}
    </EmojiPicker>
  );
}
