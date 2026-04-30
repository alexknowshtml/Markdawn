import React, { useEffect, useState, useRef } from 'react';
import clsx from 'clsx';

export interface HeadingNode {
  id: string;
  text: string;
  level: number;
  children?: HeadingNode[];
}

interface TableOfContentsProps {
  editorElement: HTMLElement | null;
}

export function TableOfContents({ editorElement }: TableOfContentsProps) {
  const [headings, setHeadings] = useState<HeadingNode[]>([]);
  const [isHovered, setIsHovered] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState<string>('');
  const observerRef = useRef<IntersectionObserver | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editorElement) {
      setHeadings([]);
      return;
    }

    const extractHeadings = () => {
      const headingElements = editorElement.querySelectorAll('h1, h2, h3, h4, h5, h6');
      const extractedHeadings: HeadingNode[] = [];
      const stack: { level: number; node: HeadingNode }[] = [];

      headingElements.forEach((el) => {
        const level = parseInt(el.tagName[1] ?? '1', 10);
        const text = el.textContent?.trim() || '';
        let id = el.id;

        if (!id) {
          id = text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
          el.id = id;
        }

        const node: HeadingNode = { id, text, level, children: [] };

        while (stack.length > 0) {
          const top = stack[stack.length - 1];
          if (!top || top.level < level) break;
          stack.pop();
        }

        if (stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top) {
            top.node.children?.push(node);
          }
        } else {
          extractedHeadings.push(node);
        }

        stack.push({ level, node });
      });

      setHeadings(extractedHeadings);
    };

    extractHeadings();

    const timeoutId = setTimeout(extractHeadings, 100);

    const mutationObserver = new MutationObserver(() => {
      extractHeadings();
    });

    mutationObserver.observe(editorElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    return () => {
      clearTimeout(timeoutId);
      mutationObserver.disconnect();
    };
  }, [editorElement]);

  useEffect(() => {
    if (!editorElement || headings.length === 0) {
      observerRef.current?.disconnect();
      return;
    }

    const headingElements = editorElement.querySelectorAll('h1, h2, h3, h4, h5, h6');

    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = entry.target.id;
            if (id) {
              setActiveHeadingId(id);
            }
          }
        });
      },
      {
        rootMargin: '-20% 0px -80% 0px',
        threshold: 0,
      }
    );

    headingElements.forEach((el) => {
      observerRef.current?.observe(el);
    });

    return () => {
      observerRef.current?.disconnect();
    };
  }, [editorElement, headings]);

  const scrollToHeading = (headingId: string) => {
    if (!editorElement) return;
    const element = editorElement.querySelector(`#${headingId}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const renderHeading = (heading: HeadingNode, depth = 0) => {
    const isActive = activeHeadingId === heading.id;
    const hasChildren = heading.children && heading.children.length > 0;

    return (
      <div key={heading.id}>
        <button
          onClick={() => scrollToHeading(heading.id)}
          className={clsx(
            'w-full text-left py-1.5 px-2 rounded-md transition-all duration-200',
            'text-sm truncate',
            isActive
              ? 'bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-medium'
              : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100',
            depth > 0 && 'ml-2'
          )}
          style={{
            paddingLeft: `${8 + depth * 12}px`,
          }}
        >
          <span className="text-sm">{heading.text || 'Untitled'}</span>
        </button>
        {hasChildren &&
          heading.children?.map((child) => renderHeading(child, depth + 1))}
      </div>
    );
  };

  const getAllHeadingsFlat = (nodes: HeadingNode[]): HeadingNode[] => {
    const result: HeadingNode[] = [];
    const visit = (heads: HeadingNode[]) => {
      heads.forEach((h) => {
        result.push(h);
        if (h.children && h.children.length > 0) {
          visit(h.children);
        }
      });
    };
    visit(nodes);
    return result;
  };

  const renderTickMarks = () => {
    const allHeadings = getAllHeadingsFlat(headings);
    return allHeadings.map((heading) => {
      const isActive = activeHeadingId === heading.id;
      const width = Math.max(12, 24 - heading.level * 3);

      return (
        <button
          key={heading.id}
          onClick={() => scrollToHeading(heading.id)}
          className={clsx(
            'w-full h-[2px] rounded-full transition-all duration-300 mb-1.5',
            isActive
              ? 'bg-zinc-900 dark:bg-zinc-100'
              : 'bg-zinc-400 dark:bg-zinc-600 hover:bg-zinc-600 dark:hover:bg-zinc-400'
          )}
          style={{
            width: `${width}px`,
            marginLeft: 'auto',
            marginRight: 'auto',
          }}
          title={heading.text}
        />
      );
    });
  };

  if (headings.length === 0) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={clsx(
        'fixed right-2 top-1/2 -translate-y-1/2 z-30',
        'transition-all duration-300 ease-out'
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div
        className={clsx(
          'flex flex-col items-center py-4 px-2 rounded-l-xl',
          'bg-transparent backdrop-blur-xl',
          'border border-transparent',
          'shadow-lg',
          'transition-all duration-300 ease-out',
          isHovered ? 'opacity-0 translate-x-2 pointer-events-none' : 'opacity-100 translate-x-0'
        )}
      >
        <div className="flex flex-col gap-0.5 max-h-[60vh] overflow-y-auto scrollbar-hide">
          {renderTickMarks()}
        </div>
      </div>

      <div
        className={clsx(
          'absolute right-0 top-0 min-w-[220px] max-w-[280px]',
          'bg-white/90 dark:bg-zinc-900/90 backdrop-blur-xl',
          'border border-zinc-200/60 dark:border-zinc-700/50',
          'shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.4)]',
          'rounded-xl p-3',
          'transition-all duration-300 ease-out',
          'max-h-[70vh] overflow-y-auto',
          !isHovered ? 'opacity-0 translate-x-4 pointer-events-none scale-95' : 'opacity-100 translate-x-0 scale-100'
        )}
      >
        <div className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-2 px-2">
          On this page
        </div>
        <div className="space-y-0.5">
          {headings.map((heading) => renderHeading(heading))}
        </div>
      </div>
    </div>
  );
}
