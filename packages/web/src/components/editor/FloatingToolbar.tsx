import {
  IconBold,
  IconCode,
  IconH1,
  IconH2,
  IconH3,
  IconH4,
  IconH5,
  IconH6,
  IconItalic,
  IconLink,
  IconList,
  IconListCheck,
  IconListNumbers,
  IconPhoto,
  IconStrikethrough,
} from '@tabler/icons-react';
import type React from 'react';
import { useRef } from 'react';

export interface FloatingToolbarProps {
  onBold: () => void;
  onItalic: () => void;
  onStrike: () => void;
  onCode: () => void;
  onLink: () => void;
  onImageUpload: (file: File) => void;
  onH1: () => void;
  onH2: () => void;
  onH3: () => void;
  onH4: () => void;
  onH5: () => void;
  onH6: () => void;
  onBulletList: () => void;
  onOrderedList: () => void;
  onTaskList: () => void;
  visible: boolean;
  position: { top: number; left: number };
  isBoldActive?: boolean;
  isItalicActive?: boolean;
  isStrikeActive?: boolean;
  isCodeActive?: boolean;
  isLinkActive?: boolean;
  isH1Active?: boolean;
  isH2Active?: boolean;
  isH3Active?: boolean;
  isH4Active?: boolean;
  isH5Active?: boolean;
  isH6Active?: boolean;
  isBulletListActive?: boolean;
  isOrderedListActive?: boolean;
  isTaskListActive?: boolean;
}

export function FloatingToolbar({
  onBold,
  onItalic,
  onStrike,
  onCode,
  onLink,
  onImageUpload,
  onH1,
  onH2,
  onH3,
  onH4,
  onH5,
  onH6,
  onBulletList,
  onOrderedList,
  onTaskList,
  visible,
  position,
  isBoldActive,
  isItalicActive,
  isStrikeActive,
  isCodeActive,
  isLinkActive,
  isH1Active,
  isH2Active,
  isH3Active,
  isH4Active,
  isH5Active,
  isH6Active,
  isBulletListActive,
  isOrderedListActive,
  isTaskListActive,
}: FloatingToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImageClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImageUpload(file);
      e.target.value = '';
    }
  };

  if (!visible) return null;

  return (
    <div
      className="floating-toolbar flex items-center gap-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl"
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        transform: 'translateX(-50%)',
        zIndex: 1000,
      }}
    >
      <button
        type="button"
        onClick={onBold}
        className={`floating-toolbar-btn p-1.5 rounded hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer ${isBoldActive ? 'bg-zinc-600 text-white' : ''}`}
        title="Bold (Ctrl+B)"
      >
        <IconBold size={16} />
      </button>
      <button
        type="button"
        onClick={onItalic}
        className={`floating-toolbar-btn p-1.5 rounded hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer ${isItalicActive ? 'bg-zinc-600 text-white' : ''}`}
        title="Italic (Ctrl+I)"
      >
        <IconItalic size={16} />
      </button>
      <button
        type="button"
        onClick={onStrike}
        className={`floating-toolbar-btn p-1.5 rounded hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer ${isStrikeActive ? 'bg-zinc-600 text-white' : ''}`}
        title="Strikethrough"
      >
        <IconStrikethrough size={16} />
      </button>
      <button
        type="button"
        onClick={onCode}
        className={`floating-toolbar-btn p-1.5 rounded hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer ${isCodeActive ? 'bg-zinc-600 text-white' : ''}`}
        title="Inline Code"
      >
        <IconCode size={16} />
      </button>
      <div className="w-px h-5 bg-zinc-600 mx-1" />
      <button
        type="button"
        onClick={onLink}
        className={`floating-toolbar-btn p-1.5 rounded hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer ${isLinkActive ? 'bg-zinc-600 text-white' : ''}`}
        title="Add Link"
      >
        <IconLink size={16} />
      </button>
      <div className="w-px h-5 bg-zinc-600 mx-1" />
      <button
        type="button"
        onClick={onH1}
        className={`floating-toolbar-btn p-1.5 rounded hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer font-bold ${isH1Active ? 'bg-zinc-600 text-white' : ''}`}
        title="Heading 1"
      >
        <IconH1 size={16} />
      </button>
      <button
        type="button"
        onClick={onH2}
        className={`floating-toolbar-btn p-1.5 rounded hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer font-bold ${isH2Active ? 'bg-zinc-600 text-white' : ''}`}
        title="Heading 2"
      >
        <IconH2 size={16} />
      </button>
      <button
        type="button"
        onClick={onH3}
        className={`floating-toolbar-btn p-1.5 rounded hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer font-bold ${isH3Active ? 'bg-zinc-600 text-white' : ''}`}
        title="Heading 3"
      >
        <IconH3 size={16} />
      </button>
      <button
        type="button"
        onClick={onH4}
        className={`floating-toolbar-btn p-1.5 rounded hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer font-bold ${isH4Active ? 'bg-zinc-600 text-white' : ''}`}
        title="Heading 4"
      >
        <IconH4 size={16} />
      </button>
      <button
        type="button"
        onClick={onH5}
        className={`floating-toolbar-btn p-1.5 rounded hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer font-bold ${isH5Active ? 'bg-zinc-600 text-white' : ''}`}
        title="Heading 5"
      >
        <IconH5 size={16} />
      </button>
      <button
        type="button"
        onClick={onH6}
        className={`floating-toolbar-btn p-1.5 rounded hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer font-bold ${isH6Active ? 'bg-zinc-600 text-white' : ''}`}
        title="Heading 6"
      >
        <IconH6 size={16} />
      </button>
      <div className="w-px h-5 bg-zinc-600 mx-1" />
      <button
        type="button"
        onClick={onBulletList}
        className={`floating-toolbar-btn p-1.5 rounded hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer ${isBulletListActive ? 'bg-zinc-600 text-white' : ''}`}
        title="Bullet List"
      >
        <IconList size={16} />
      </button>
      <button
        type="button"
        onClick={onOrderedList}
        className={`floating-toolbar-btn p-1.5 rounded hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer ${isOrderedListActive ? 'bg-zinc-600 text-white' : ''}`}
        title="Ordered List"
      >
        <IconListNumbers size={16} />
      </button>
      <button
        type="button"
        onClick={onTaskList}
        className={`floating-toolbar-btn p-1.5 rounded hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer ${isTaskListActive ? 'bg-zinc-600 text-white' : ''}`}
        title="Task List"
      >
        <IconListCheck size={16} />
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
}
