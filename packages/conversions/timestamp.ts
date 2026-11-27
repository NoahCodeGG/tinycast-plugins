const unix = /^([+-]?\d+)\s*(ms|s)?$/i;
const iso = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/i;

export function parseTimestamp(value: string): Date | undefined {
  const input = value.trim();
  const epoch = unix.exec(input);
  let milliseconds: number;

  if (epoch) {
    const amount = Number(epoch[1]);
    if (!Number.isSafeInteger(amount)) return;
    const unit = epoch[2]?.toLowerCase() ?? (Math.abs(amount) >= 100_000_000_000 ? "ms" : "s");
    milliseconds = unit === "ms" ? amount : amount * 1000;
  } else {
    const match = iso.exec(input);
    if (!match) return;
    const day = new Date(match[1] + "T00:00:00Z");
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== match[1]) return;
    milliseconds = Date.parse(input);
    // Date.parse accepts 24:00 by advancing to the next day.
    if (input.slice(11, 13) === "24") return;
  }

  const date = new Date(milliseconds);
  if (Number.isFinite(date.getTime())) return date;
}
