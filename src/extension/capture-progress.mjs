const START_PERCENT = 4;
const COMPLETION_CEILING = 95;
const TIME_CONSTANT_MS = 1800;

export function captureProgressForElapsed(elapsedMs) {
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const range = COMPLETION_CEILING - START_PERCENT;
  const progress = START_PERCENT + range * (1 - Math.exp(-elapsed / TIME_CONSTANT_MS));
  return Math.min(COMPLETION_CEILING, Math.round(progress));
}
