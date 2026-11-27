import { Action, ActionPanel, Clipboard, Icon, List, Toast, clearSearchBar, showToast, type LaunchProps } from "@raycast/api";
import { execFile } from "node:child_process";
import { useMemo, useRef, useState } from "react";
import { ConversionInput } from "../conversion-input";
import manifest from "../manifest.json";
import { recognizeInput } from "../recognize";
import Base64Text from "./base64-text";
import FileHash from "./file-hash";
import ImageBase64 from "./image-base64";
import NumberBase from "./number-base";
import TextHash from "./text-hash";
import Timestamp from "./timestamp";
import UnicodeHtml from "./unicode-html";
import UrlConversion from "./url-conversion";
import Uuid from "./uuid";

const tools = new Map([
  ["base64-text", Base64Text],
  ["image-base64", ImageBase64],
  ["url-conversion", UrlConversion],
  ["timestamp", Timestamp],
  ["uuid", Uuid],
  ["text-hash", TextHash],
  ["file-hash", FileHash],
  ["number-base", NumberBase],
  ["unicode-html", UnicodeHtml],
]);

const quicklink = {
  name: "识别编码输入",
  link: "tinycast://extensions/noah-codec/codec-tools?fallbackText={argument}",
};
const quicklinkEditor = "tinycast://command/create-quicklink?context=" + encodeURIComponent(JSON.stringify(quicklink));

async function openQuicklinkEditor() {
  try {
    // The extension open() API handles extension deep links only. Send the built-in command
    // through macOS so it reaches Tinycast's normal Quicklink editor.
    await new Promise<void>((resolve, reject) => {
      execFile("/usr/bin/open", ["-g", quicklinkEditor], (error) => error ? reject(error) : resolve());
    });
  } catch {
    await showToast({ style: Toast.Style.Failure, title: "无法打开 Quicklink 编辑器" });
  }
}

export default function CodecTools(props: LaunchProps) {
  const initial = props?.fallbackText ?? "";
  const recognized = recognizeInput(initial);
  const Tool = recognized.length === 1 ? tools.get(recognized[0].tool) : undefined;
  if (Tool) {
    return <ConversionInput.Provider value={{ text: initial, preferredLabel: recognized[0].title }}><Tool /></ConversionInput.Provider>;
  }
  return <ToolList initial={initial} />;
}

function ToolList({ initial }: { initial: string }) {
  const [input, setInput] = useState(initial);
  const clipboardInput = useRef(false);
  const revision = useRef(0);
  const suggestions = useMemo(() => recognizeInput(input), [input]);
  const query = input.toLowerCase().trim();

  function update(value: string) {
    revision.current++;
    if (!value && clipboardInput.current) return;
    clipboardInput.current = false;
    setInput(value);
  }

  async function paste() {
    const current = ++revision.current;
    const text = await Clipboard.readText();
    if (current !== revision.current) return;
    if (!text) {
      await showToast({ style: Toast.Style.Failure, title: "剪贴板没有文本" });
      return;
    }
    clipboardInput.current = true;
    setInput(text);
    await clearSearchBar();
  }

  async function clear() {
    revision.current++;
    clipboardInput.current = false;
    setInput("");
    await clearSearchBar();
  }

  const setup = <Action title="配置主搜索入口" icon={Icon.Link} onAction={openQuicklinkEditor} />;
  const commonActions = <>
    <Action title="识别剪贴板文本" icon={Icon.Clipboard} shortcut={{ modifiers: ["cmd", "shift"], key: "v" }} onAction={paste} />
    {input && <Action title="清空输入" onAction={clear} />}
    {setup}
  </>;

  const suggestionsByName = new Set(suggestions.map(({ tool }) => tool));
  const matching = manifest.commands.filter(({ name, title, description, keywords }) =>
    tools.has(name) && !suggestionsByName.has(name) &&
    (!query || [title, description, ...keywords].some((value) => value.toLowerCase().includes(query))),
  );

  return (
    <List
      navigationTitle="编码小助手"
      searchBarPlaceholder={clipboardInput.current ? "输入以替换剪贴板内容" : "输入值以识别，或搜索工具"}
      filtering={false}
      onSearchTextChange={update}
      actions={<ActionPanel>{commonActions}</ActionPanel>}
    >
      <List.EmptyView title="没有识别出对应的工具" description="搜索工具名，或清空输入返回工具列表。" />
      {suggestions.length > 0 && <List.Section title="从输入识别">
        {suggestions.map(({ tool, title }) => {
          const Tool = tools.get(tool);
          if (!Tool) return null;
          return <List.Item
            key={tool}
            title={title}
            subtitle="带入当前输入"
            actions={<ActionPanel>
              <Action.Push title="打开并带入输入" target={<ConversionInput.Provider value={{ text: input, preferredLabel: title }}><Tool /></ConversionInput.Provider>} />
              {commonActions}
            </ActionPanel>}
          />;
        })}
      </List.Section>}
      {matching.map(({ name, title, description, keywords }) => {
        const Tool = tools.get(name);
        if (!Tool) return null;
        return (
          <List.Item
            key={name}
            title={title}
            subtitle={description}
            keywords={keywords}
            actions={<ActionPanel>
              <Action.Push title="打开工具" target={<Tool />} />
              {commonActions}
            </ActionPanel>}
          />
        );
      })}
    </List>
  );
}
