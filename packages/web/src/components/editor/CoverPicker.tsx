import React, { useState } from 'react';
import { Popover, Button, Group, Text, Stack, ActionIcon, Tooltip } from '@mantine/core';
import { IconPhoto, IconTrash } from '@tabler/icons-react';

interface CoverPickerProps {
  coverType: string | null;
  coverValue: string | null;
  onChange: (type: string | null, value: string | null) => void;
  children: React.ReactNode;
}

const GRADIENTS = [
  'linear-gradient(to right, #ff7e5f, #feb47b)',
  'linear-gradient(to right, #00c6ff, #0072ff)',
  'linear-gradient(to right, #f12711, #f5af19)',
  'linear-gradient(to right, #8e2de2, #4a00e0)',
  'linear-gradient(to right, #11998e, #38ef7d)',
  'linear-gradient(to right, #fc4a1a, #f7b733)',
  'linear-gradient(to right, #00b09b, #96c93d)',
  'linear-gradient(to right, #ff9966, #ff5e62)',
  'linear-gradient(to right, #a8c0ff, #3f2b96)',
  'linear-gradient(to right, #4568dc, #b06ab3)',
  'linear-gradient(to right, #ed4264, #ffedbc)',
  'linear-gradient(to right, #2b5876, #4e4376)',
];

const SOLID_COLORS = [
  '#18181b',
  '#27272a',
  '#3f3f46',
  '#52525b',
  '#71717a',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#a855f7',
  '#ec4899',
];

export function CoverPicker({ coverType, coverValue, onChange, children }: CoverPickerProps) {
  const [opened, setOpened] = useState(false);

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
        <div onClick={() => setOpened((o) => !o)} className="cursor-pointer inline-block">
          {children}
        </div>
      </Popover.Target>
      <Popover.Dropdown className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4 rounded-lg shadow-xl w-80 min-w-[20rem]">
        <Stack gap="md">
          <div>
            <Group justify="space-between" mb="xs">
              <Text size="sm" fw={500} className="text-zinc-700 dark:text-zinc-300">
                Gradients
              </Text>
              {(coverType || coverValue) && (
                <Tooltip label="Remove cover">
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    onClick={() => {
                      onChange(null, null);
                      setOpened(false);
                    }}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
            <div className="grid grid-cols-4 gap-2">
              {GRADIENTS.map((gradient) => (
                <button
                  key={gradient}
                  className={`w-full h-11 rounded-md cursor-pointer transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-900 ${
                    coverType === 'gradient' && coverValue === gradient ? 'ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-zinc-900' : ''
                  }`}
                  style={{ background: gradient }}
                  onClick={() => {
                    onChange('gradient', gradient);
                    setOpened(false);
                  }}
                  aria-label="Select gradient"
                />
              ))}
            </div>
          </div>

          <div>
            <Text size="sm" fw={500} className="text-zinc-700 dark:text-zinc-300 mb-2">
              Solid Colors
            </Text>
            <div className="grid grid-cols-6 gap-2">
              {SOLID_COLORS.map((color) => (
                <button
                  key={color}
                  className={`w-full h-9 rounded-md cursor-pointer transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-900 ${
                    coverType === 'solid' && coverValue === color ? 'ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-zinc-900' : ''
                  }`}
                  style={{ backgroundColor: color }}
                  onClick={() => {
                    onChange('solid', color);
                    setOpened(false);
                  }}
                  aria-label={`Select color ${color}`}
                />
              ))}
            </div>
          </div>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
