import { Action, ActionPanel, Clipboard, Icon, List, useNavigation, type LaunchProps } from "@raycast/api";
import { useState } from "react";
import { AIHome } from "../ai-views";
import { parseColor, toHex } from "../color";
import { Catalog, Compare, Favorites, Gradients, ImagePalette, Inspector, notify, RecentColors, ScreenAction, swatchIcon } from "../views";

const tools = [
  { title: "颜色转换", icon: Icon.Swatch, keywords: ["HEX", "RGB", "HSL", "CMYK", "color", "转换"], target: <Inspector /> },
  { title: "比较颜色", icon: Icon.Contrast, keywords: ["对比", "对比度", "compare"], target: <Compare /> },
  { title: "图片色卡", icon: Icon.Image, keywords: ["图片", "主色", "image", "提取"], target: <ImagePalette /> },
  { title: "UI 色卡", icon: Icon.AppWindow, keywords: ["Flat UI", "Fluent", "Open Color", "Ant Design", "Material"], target: <Catalog kind="ui" /> },
  { title: "传统色", icon: Icon.Book, keywords: ["中国传统色", "日本传统色", "traditional"], target: <Catalog kind="traditional" /> },
  { title: "渐变色", icon: Icon.Layers, keywords: ["CSS", "gradient", "预览", "渐变"], target: <Gradients /> },
  { title: "最近取色", icon: Icon.Clock, keywords: ["历史", "取色记录", "recent colors"], target: <RecentColors /> },
  { title: "收藏颜色", icon: Icon.Star, keywords: ["收藏", "favorites"], target: <Favorites /> },
  { title: "AI 配色", icon: Icon.Stars, keywords: ["AI", "生成", "色卡", "模型"], target: <AIHome /> },
];

export default function ColorAssistant(props: LaunchProps) {
  const incoming = props?.fallbackText;
  return incoming && parseColor(incoming) ? <Inspector initial={incoming} /> : <Home />;
}

function Home() {
  const [input, setInput] = useState("");
  const { push } = useNavigation();
  const query = input.trim().toLowerCase();
  const parsed = parseColor(input);
  const pick = (hex: string) => push(<Inspector initial={hex} />);
  const paste = <Action title="读取剪贴板色值" icon={Icon.Clipboard} shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
    onAction={async () => {
      const value = await Clipboard.readText();
      if (value && parseColor(value)) pick(value);
      else await notify("剪贴板没有可识别的色值", true);
    }} />;
  return <List navigationTitle="颜色助手" searchBarPlaceholder="输入色值或搜索工具" filtering={false} onSearchTextChange={setInput}
    actions={<ActionPanel>{paste}<ScreenAction onPick={pick} /></ActionPanel>}>
    <List.EmptyView title="没有匹配项" description="输入色值（如 #6E64D0），或搜索取色、色卡、渐变等工具。" />
    {parsed && <List.Item title={"转换 " + toHex(parsed)} icon={swatchIcon(toHex(parsed))}
      actions={<ActionPanel><Action.Push title="查看颜色" target={<Inspector initial={input} />} />{paste}</ActionPanel>} />}
    {(!query || ["屏幕取色", "取色", "eyedropper", "picker"].some((tag) => tag.includes(query))) &&
      <List.Item title="屏幕取色" icon={Icon.EyeDropper} actions={<ActionPanel><ScreenAction onPick={pick} />{paste}</ActionPanel>} />}
    {tools.filter(({ title, keywords }) => [title, ...keywords].some((s) => s.toLowerCase().includes(query))).map(({ title, icon, target }) =>
      <List.Item key={title} title={title} icon={icon}
        actions={<ActionPanel><Action.Push title="打开" target={target} />{paste}<ScreenAction onPick={pick} /></ActionPanel>} />)}
  </List>;
}
