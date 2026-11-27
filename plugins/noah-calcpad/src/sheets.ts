import { LocalStorage } from "@raycast/api";

const prefix = "sheet/";
export const titleLimit = 80;
export const bodyLimit = 24_000;
export const lineLimit = 300;
export type Sheet = { id: string; title: string; body: string; modified: number; locked?: boolean };

export function sheetTitle(sheet: Sheet): string {
  return sheet.title.trim() || "未命名稿纸";
}

export function withinLimits(body: string): boolean {
  return body.length <= bodyLimit && body.split(/\r\n|\n|\r/).length <= lineLimit;
}

export async function loadSheets(): Promise<Sheet[]> {
  const items = await LocalStorage.allItems();
  const sheets: Sheet[] = [];
  for (const [key, item] of Object.entries(items)) {
    if (!key.startsWith(prefix) || typeof item !== "string") continue;
    try {
      const { title, body, modified, locked } = JSON.parse(item);
      if (typeof title !== "string" || typeof body !== "string" || !Number.isFinite(modified)) continue;
      sheets.push({ id: key.slice(prefix.length), title, body, modified, locked: locked === true });
    } catch {
      // Leave an unreadable record in storage and continue loading the other sheets.
    }
  }
  return sheets;
}

const writes = new Map<string, Promise<void>>();
const removing = new Set<string>();

async function queueWrite(key: string, write: () => Promise<void>) {
  const previous = writes.get(key);
  const next = previous ? previous.then(write, write) : write();
  writes.set(key, next);
  try {
    await next;
  } finally {
    if (writes.get(key) === next) writes.delete(key);
  }
}

export function saveSheet({ id, ...sheet }: Sheet): Promise<void> {
  if (removing.has(id)) return Promise.reject(new Error("Sheet has been removed"));
  const key = prefix + id;
  return queueWrite(key, () => LocalStorage.setItem(key, JSON.stringify(sheet)));
}

export async function removeSheet(id: string): Promise<void> {
  removing.add(id);
  const key = prefix + id;
  try {
    await queueWrite(key, () => LocalStorage.removeItem(key));
  } catch (error) {
    removing.delete(id);
    throw error;
  }
}
