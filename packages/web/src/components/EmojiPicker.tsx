import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import { Popover } from '@mantine/core';
import type React from 'react';
import { useState } from 'react';
import { useTheme } from '../hooks/useTheme';

interface EmojiPickerProps {
  icon: string | null;
  onChange: (icon: string | null) => void;
  children: React.ReactNode;
}

export function EmojiPicker({ icon, onChange, children }: EmojiPickerProps) {
  const [opened, setOpened] = useState(false);
  const { isDark } = useTheme();

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-start"
      withArrow
      shadow="md"
      transitionProps={{ transition: 'pop', duration: 150 }}
    >
      <Popover.Target>
        <button
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
      </Popover.Target>
      <Popover.Dropdown p={0} className="border-none bg-transparent">
        <Picker
          data={data}
          onEmojiSelect={(emoji: { native: string }) => {
            onChange(emoji.native);
            setOpened(false);
          }}
          theme={isDark ? 'dark' : 'light'}
        />
      </Popover.Dropdown>
    </Popover>
  );
}
