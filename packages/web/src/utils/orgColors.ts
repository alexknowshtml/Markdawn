export interface OrgColor {
  dot: string;
  ring: string;
  label: string;
  headerBg: string;
  headerText: string;
}

const PALETTE: OrgColor[] = [
  { dot: 'bg-emerald-500', ring: 'ring-emerald-500', label: 'text-emerald-600 dark:text-emerald-400', headerBg: 'bg-emerald-50 dark:bg-emerald-950/30', headerText: 'text-emerald-700 dark:text-emerald-400' },
  { dot: 'bg-blue-500',    ring: 'ring-blue-500',    label: 'text-blue-600 dark:text-blue-400',       headerBg: 'bg-blue-50 dark:bg-blue-950/30',       headerText: 'text-blue-700 dark:text-blue-400' },
  { dot: 'bg-violet-500',  ring: 'ring-violet-500',  label: 'text-violet-600 dark:text-violet-400',   headerBg: 'bg-violet-50 dark:bg-violet-950/30',   headerText: 'text-violet-700 dark:text-violet-400' },
  { dot: 'bg-amber-500',   ring: 'ring-amber-500',   label: 'text-amber-600 dark:text-amber-400',     headerBg: 'bg-amber-50 dark:bg-amber-950/30',     headerText: 'text-amber-700 dark:text-amber-400' },
  { dot: 'bg-rose-500',    ring: 'ring-rose-500',    label: 'text-rose-600 dark:text-rose-400',       headerBg: 'bg-rose-50 dark:bg-rose-950/30',       headerText: 'text-rose-700 dark:text-rose-400' },
];

export function buildOrgColorMap(orgIds: string[]): Map<string, OrgColor> {
  const map = new Map<string, OrgColor>();
  orgIds.forEach((id, i) => {
    const color = PALETTE[i % PALETTE.length];
    if (color) map.set(id, color);
  });
  return map;
}
