import { ArrowLeft, ArrowRight, Link2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useBacklinks, useOutgoingLinks } from '../../hooks/use-backlinks';
import { buildPagePath } from '../../utils/url';

interface BacklinksPanelProps {
  pageId: string;
}

export function BacklinksPanel({ pageId }: BacklinksPanelProps) {
  const { data: backlinks } = useBacklinks(pageId);
  const { data: outgoing } = useOutgoingLinks(pageId);

  const hasBacklinks = backlinks && backlinks.length > 0;
  const hasOutgoing = outgoing && outgoing.length > 0;

  if (!hasBacklinks && !hasOutgoing) {
    return null;
  }

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Link2 size={14} className="text-zinc-500 dark:text-zinc-400" />
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          Links
        </span>
      </div>

      {hasBacklinks && (
        <div className="mb-4">
          <div className="flex items-center gap-1.5 mb-2">
            <ArrowLeft size={12} className="text-zinc-400 dark:text-zinc-500" />
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {backlinks.length} linked mention{backlinks.length > 1 ? 's' : ''}
            </span>
          </div>
          <div className="space-y-1">
            {backlinks.slice(0, 5).map((link) => (
              <Link
                key={link.id}
                to={buildPagePath(link.sourceTitle, link.sourcePageId)}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-colors"
              >
                <span className="text-base">{link.sourceIcon || '📄'}</span>
                <span className="truncate">{link.sourceTitle}</span>
              </Link>
            ))}
            {backlinks.length > 5 && (
              <p className="text-xs text-zinc-400 dark:text-zinc-500 px-2">
                +{backlinks.length - 5} more
              </p>
            )}
          </div>
        </div>
      )}

      {hasOutgoing && (
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <ArrowRight size={12} className="text-zinc-400 dark:text-zinc-500" />
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {outgoing.length} outgoing link{outgoing.length > 1 ? 's' : ''}
            </span>
          </div>
          <div className="space-y-1">
            {outgoing.slice(0, 5).map((link) =>
              link.targetPageId ? (
                <Link
                  key={link.id}
                  to={buildPagePath(link.targetPageTitle || link.targetTitle, link.targetPageId)}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-colors"
                >
                  <span className="text-base">{link.targetPageIcon || '📄'}</span>
                  <span className="truncate">{link.targetPageTitle || link.targetTitle}</span>
                </Link>
              ) : (
                <div
                  key={link.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-400 dark:text-zinc-500"
                >
                  <span className="text-base">{link.targetPageIcon || '📄'}</span>
                  <span className="truncate">{link.targetPageTitle || link.targetTitle}</span>
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">(not found)</span>
                </div>
              ),
            )}
            {outgoing.length > 5 && (
              <p className="text-xs text-zinc-400 dark:text-zinc-500 px-2">
                +{outgoing.length - 5} more
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
