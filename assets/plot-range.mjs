export function fitPlotRange({ low, high, minSpan, center, range }, previous) {
  if (range) return range;
  const hasData = Number.isFinite(low) && Number.isFinite(high);
  const midpoint = center ?? (hasData ? (low + high) / 2 : 0);
  const step = minSpan / 2;
  const current = previous ?? [midpoint - step, midpoint + step];
  if (!hasData) return current;

  const [lower, upper] = current;
  if (low < lower || high > upper) {
    const padding = (Math.max(upper, high) - Math.min(lower, low)) * 0.12;
    return [
      low < lower ? lower - Math.ceil((lower - low + padding) / step) * step : lower,
      high > upper ? upper + Math.ceil((high - upper + padding) / step) * step : upper,
    ];
  }

  // 留出余量，仅当新量程明显更紧时才收缩，避免小幅波动反复改动刻度。
  const radius = Math.max(step, Math.ceil(Math.max(midpoint - low, high - midpoint) * 1.12 / step) * step);
  return 2 * radius <= (upper - lower) * 0.75 ? [midpoint - radius, midpoint + radius] : current;
}
