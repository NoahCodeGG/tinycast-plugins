import { Clipboard, closeMainWindow, showHUD } from "@raycast/api";
import { preferredColor, rememberScreenColor, sampleScreen } from "../screen";

export default async function PickScreenColor() {
  await closeMainWindow({ clearRootSearch: true });
  let hex: string | undefined;
  try {
    hex = await sampleScreen();
  } catch {
    await showHUD("无法完成屏幕取色");
    return;
  }
  if (!hex) return;
  const value = preferredColor(hex);
  const [copy, history] = await Promise.allSettled([Clipboard.copy(value), rememberScreenColor(hex)]);
  if (copy.status === "rejected") {
    await showHUD("无法复制色值 " + value);
  } else {
    await showHUD("已复制 " + value + (history.status === "rejected" ? " · 无法保存历史" : ""));
  }
}
