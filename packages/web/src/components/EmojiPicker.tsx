import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import type React from 'react';
import { useRef, useState } from 'react';
import { Popover } from '../components/ui/popover';
import { useTheme } from '../hooks/useTheme';

interface EmojiPickerProps {
  icon: string | null;
  onChange: (icon: string | null) => void;
  children: React.ReactNode;
}

export function EmojiPicker({ icon, onChange, children }: EmojiPickerProps) {
  const [opened, setOpened] = useState(false);
  const { isDark } = useTheme();
  const targetRef = useRef<HTMLButtonElement>(null);

  return (
    <Popover opened={opened} onChange={setOpened}>
      <button
        ref={targetRef}
        type="button"
        onClick={() => setOpened((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpened((o) => !o);
          }
        }}
        className="cursor-pointer inline-block bg-transparent border-none p-0"
      >
        {children}
      </button>
      {opened && (
        <div
          className="absolute z-50 animate-scale-in"
          style={{
            top: targetRef.current ? targetRef.current.offsetHeight + 4 : 0,
            left: 0,
          }}
        >
          <Picker
            data={data}
            onEmojiSelect={(emoji: { native: string }) => {
              onChange(emoji.native);
              setOpened(false);
            }}
            theme={isDark ? 'dark' : 'light'}
          />
        </div>
      )}
    </Popover>
  );
}
