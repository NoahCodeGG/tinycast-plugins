const common = [
  ["Asia/Shanghai", "上海"],
  ["Asia/Tokyo", "东京"],
  ["Asia/Hong_Kong", "香港"],
  ["Asia/Singapore", "新加坡"],
  ["Asia/Kolkata", "加尔各答"],
  ["Asia/Dubai", "迪拜"],
  ["Europe/London", "伦敦"],
  ["Europe/Paris", "巴黎"],
  ["Europe/Berlin", "柏林"],
  ["America/New_York", "纽约"],
  ["America/Chicago", "芝加哥"],
  ["America/Los_Angeles", "洛杉矶"],
  ["Australia/Sydney", "悉尼"],
  ["Pacific/Auckland", "奥克兰"],
] as const;

export const twoDigits = (value: number) => String(value).padStart(2, "0");
export function formatYear(year: number) {
  return year >= 0 && year <= 9_999
    ? String(year).padStart(4, "0")
    : (year < 0 ? "-" : "+") + String(Math.abs(year)).padStart(6, "0");
}

function fixedOffset(input: string) {
  const match = /^UTC([+-])(\d{1,2})(?::(\d{2}))?$/i.exec(input);
  if (!match) return;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  if (hours > 23 || minutes > 59) return;
  const total = hours * 60 + minutes;
  return {
    minutes: match[1] === "-" ? -total : total,
    id: "UTC" + (total ? match[1] : "+") + twoDigits(hours) + ":" + twoDigits(minutes),
  };
}

export function normalizeTimeZone(input: string): string | undefined {
  const value = input.trim();
  if (!value) return;
  const fixed = fixedOffset(value);
  if (fixed) return fixed.id;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return;
  }
}

let knownNames: Map<string, { id: string; name: string }> | undefined;
function timeZoneNames() {
  if (knownNames) return knownNames;
  const names = new Map<string, { id: string; name: string }>();
  for (const [id, name] of common) {
    const canonical = normalizeTimeZone(id);
    if (canonical) names.set(canonical, { id, name });
  }
  knownNames = names;
  return names;
}

export function timeZoneTitle(id: string) {
  return timeZoneNames().get(id)?.name ?? id.replace(/_/g, " ");
}

export function timeZoneMatches(query: string) {
  const text = query.trim();
  const exact = normalizeTimeZone(text);
  const all = text ? Intl.supportedValuesOf?.("timeZone") ?? [] : [];
  const needle = text.toLowerCase().replace(/_/g, " ");
  const matches = exact ? [exact] : [];
  for (const [id, { name, id: original }] of timeZoneNames()) {
    if (name.includes(text) || original.toLowerCase().replace(/_/g, " ").includes(needle)) matches.push(id);
  }
  return [...new Set([...matches, ...all.filter((id) => id.toLowerCase().replace(/_/g, " ").includes(needle))])];
}

export function readTimeZones(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    return [...new Set(values.flatMap((value) => {
      const zone = typeof value === "string" ? normalizeTimeZone(value) : undefined;
      return zone ? [zone] : [];
    }))];
  } catch {
    return [];
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
export function formatTimeInZone(date: Date, zone: string): string {
  const fixed = fixedOffset(zone);
  const timeZone = fixed ? "UTC" : zone;
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23", era: "short",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      timeZoneName: "longOffset",
    });
    formatters.set(timeZone, formatter);
  }
  const instant = fixed ? new Date(date.getTime() + fixed.minutes * 60_000) : date;
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
  const year = parts.era === "BC" ? 1 - Number(parts.year) : Number(parts.year);
  const day = [formatYear(year), parts.month, parts.day].join("-");
  const clock = [parts.hour, parts.minute, parts.second].join(":");
  const offset = fixed?.id ?? parts.timeZoneName.replace(/^GMT/, "UTC");
  return day + " " + clock + " " + offset;
}
