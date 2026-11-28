export const defaultSourcePercent = 30;

const minFlowHeight = 280;
const minSourceBodyHeight = 120;
const keyboardStep = 2;

export function sourcePercentBounds(paneHeight: number, headingHeight: number) {
  const min = Math.min(100, (headingHeight + minSourceBodyHeight) / paneHeight * 100);
  const max = Math.max(min, (paneHeight - minFlowHeight) / paneHeight * 100);
  return { min, max };
}

export function clampSourcePercent(percent: number, { min, max }: { min: number; max: number }) {
  return Math.min(max, Math.max(min, percent));
}

export function parseSourcePercent(stored: string | null) {
  const percent = Number(stored);
  return percent > 0 && percent < 100 ? percent : defaultSourcePercent;
}

export function sourcePercentForKey(key: string, percent: number) {
  if (key === "ArrowUp") return percent + keyboardStep;
  if (key === "ArrowDown") return percent - keyboardStep;
  if (key === "Home") return defaultSourcePercent;
  return undefined;
}
