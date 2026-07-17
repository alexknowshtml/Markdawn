import { useRef } from 'react';

export function useStableValueWhile<T>(value: T, frozen: boolean): T {
  const stableValueRef = useRef(value);
  if (!frozen) stableValueRef.current = value;
  return stableValueRef.current;
}
