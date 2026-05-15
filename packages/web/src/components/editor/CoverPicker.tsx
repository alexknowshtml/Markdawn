import { IconTrash } from '@tabler/icons-react';
import type React from 'react';
import { useRef, useState } from 'react';
import { Tooltip } from '../Tooltip';

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
  const ref = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLButtonElement>(null);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        ref={targetRef}
        type="button"
        onClick={() => setOpened((o) => !o)}
        className="cursor-pointer inline-block bg-transparent border-none p-0"
      >
        {children}
      </button>
      {opened && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpened(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpened(false);
            }}
            aria-hidden="true"
          />
          <div
            className="absolute z-50 animate-scale-in bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4 rounded-lg shadow-xl"
            style={{ minWidth: '20rem', top: '100%', left: 0, marginTop: '4px' }}
          >
            <div className="flex flex-col gap-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Gradients</p>
                  {(coverType || coverValue) && (
                    <Tooltip label="Remove cover">
                      <button
                        type="button"
                        onClick={() => {
                          onChange(null, null);
                          setOpened(false);
                        }}
                        className="cursor-pointer p-1 rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                        aria-label="Remove cover"
                      >
                        <IconTrash size={14} />
                      </button>
                    </Tooltip>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {GRADIENTS.map((gradient) => (
                    <button
                      type="button"
                      key={gradient}
                      className={`w-full h-11 rounded-md cursor-pointer transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-900 ${
                        coverType === 'gradient' && coverValue === gradient
                          ? 'ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-zinc-900'
                          : ''
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
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                  Solid Colors
                </p>
                <div className="grid grid-cols-6 gap-2">
                  {SOLID_COLORS.map((color) => (
                    <button
                      type="button"
                      key={color}
                      className={`w-full h-9 rounded-md cursor-pointer transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-900 ${
                        coverType === 'solid' && coverValue === color
                          ? 'ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-zinc-900'
                          : ''
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
            </div>
          </div>
        </>
      )}
    </div>
  );
}
