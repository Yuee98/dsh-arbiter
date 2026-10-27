import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const customTwMerge = extendTailwindMerge({
  prefix: 'arb',
});

export function cn(...inputs: ClassValue[]): string {
  return customTwMerge(clsx(inputs));
}
