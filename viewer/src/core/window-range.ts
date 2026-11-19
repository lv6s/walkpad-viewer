export interface TimeRange { a: number; b: number }

export function clampRange(a: number, b: number, duration: number): TimeRange | null {
  if (![a, b, duration].every(Number.isFinite) || duration <= 0 || b <= a) return null;
  const span = Math.min(duration, Math.max(Math.min(0.02, duration), b - a));
  const start = Math.max(0, Math.min(a, duration - span));
  return {a: start, b: start + span};
}
