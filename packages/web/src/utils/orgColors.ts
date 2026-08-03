export interface OrgColor {
  dot: string;
  ring: string;
  label: string;
}

const PALETTE: OrgColor[] = [
  { dot: 'bg-emerald-500', ring: 'ring-emerald-500', label: 'text-emerald-600 dark:text-emerald-400' },
  { dot: 'bg-blue-500',    ring: 'ring-blue-500',    label: 'text-blue-600 dark:text-blue-400' },
  { dot: 'bg-violet-500',  ring: 'ring-violet-500',  label: 'text-violet-600 dark:text-violet-400' },
  { dot: 'bg-amber-500',   ring: 'ring-amber-500',   label: 'text-amber-600 dark:text-amber-400' },
  { dot: 'bg-rose-500',    ring: 'ring-rose-500',    label: 'text-rose-600 dark:text-rose-400' },
];

export function buildOrgColorMap(orgIds: string[]): Map<string, OrgColor> {
  const map = new Map<string, OrgColor>();
  orgIds.forEach((id, i) => {
    const color = PALETTE[i % PALETTE.length];
    if (color) map.set(id, color);
  });
  return map;
}
