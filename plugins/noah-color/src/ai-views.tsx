import { Action, ActionPanel, Detail, Form, Icon, List, LocalStorage, useNavigation } from "@raycast/api";
import { useEffect, useState } from "react";
import { aiImage, aiName, aiPalette, getEndpoint, type AISettings } from "./ai";
import { parseColor, parseList, toHex } from "./color";
import { pngMarkdown, prepareAiCard } from "./images";
import { ImageExport, notify, PaletteView, TaskForm, type Palette } from "./views";

const storageKey = "color-ai-settings-v1";
const defaults = { baseUrl: "https://api.openai.com/v1", model: "", imageModel: "", apiKey: "" };
let current = defaults;
let configured: Promise<void> | undefined;

async function readSettings() {
  configured ??= LocalStorage.getItem(storageKey).then((raw) => {
    if (typeof raw !== "string") return;
    const saved = JSON.parse(raw);
    if (typeof saved?.baseUrl === "string" && typeof saved.model === "string" && typeof saved.imageModel === "string") {
      current = { ...saved, apiKey: "" };
    }
  }).catch(() => {});
  await configured;
  return current;
}

function ConfigAction() {
  return <Action.Push title="配置 AI 接口" icon={Icon.Gear} target={<Settings />} />;
}

function Settings() {
  const [settings, setSettings] = useState<AISettings>();
  const { pop } = useNavigation();
  useEffect(() => { void readSettings().then(setSettings); }, []);
  if (!settings) return <Form isLoading navigationTitle="AI 接口配置" />;
  return <TaskForm<AISettings> title="AI 接口配置" submit="保存配置" run={async (values) => {
    const baseUrl = values.baseUrl.trim().replace(/\/+$/, "");
    getEndpoint(baseUrl, "/chat/completions");
    const next = { baseUrl, model: (values.model ?? "").trim(), imageModel: (values.imageModel ?? "").trim() };
    await LocalStorage.setItem(storageKey, JSON.stringify(next));
    current = { ...next, apiKey: (values.apiKey ?? "").trim() };
    await notify("已保存配置");
    pop();
  }}>
    <Form.TextField id="baseUrl" title="接口地址" defaultValue={settings.baseUrl} />
    <Form.TextField id="model" title="配色模型" defaultValue={settings.model} />
    <Form.TextField id="imageModel" title="图像模型" defaultValue={settings.imageModel} />
    <Form.PasswordField id="apiKey" title="API 密钥" defaultValue={settings.apiKey} />
    <Form.Description text="填写兼容 OpenAI 的接口（含 /v1 等路径前缀）。图像模型须返回 PNG Base64。密钥仅在当前插件运行期间使用，留空可连接无需认证的本地服务。" />
  </TaskForm>;
}

function choices(values: string[]) {
  return values.map((value) => <Form.Dropdown.Item key={value} title={value} value={value} />);
}

export function AIHome() {
  return <List navigationTitle="AI 配色" searchBarPlaceholder="搜索 AI 功能">
    <List.Item title="根据主色生成配色" icon={Icon.Stars} actions={<ActionPanel>
      <Action.Push title="设置配色条件" target={<GeneratePalette />} /><ConfigAction />
    </ActionPanel>} />
    <List.Item title="根据已有颜色生成色卡图片" icon={Icon.Image} actions={<ActionPanel>
      <Action.Push title="填写颜色" target={<GenerateCard />} /><ConfigAction />
    </ActionPanel>} />
    <List.Item title="AI 接口配置" icon={Icon.Gear} actions={<ActionPanel><ConfigAction /></ActionPanel>} />
  </List>;
}

function GeneratePalette() {
  const { push } = useNavigation();
  return <TaskForm<{ base: string; style: string; tone: string; count: string; prompt: string }>
    title="AI 配色" submit="生成配色" actions={<ConfigAction />} run={async ({ base, style, tone, count, prompt }) => {
      const primary = parseColor(base);
      if (!primary || primary[3] !== 255) throw new Error("请输入有效的不透明主色。");
      const palette = await aiPalette(await readSettings(), { base: toHex(primary), style: style || "现代", tone: tone || "不限", count: Number(count || "5"), prompt: (prompt ?? "").trim().slice(0, 2000) });
      push(<PaletteView palette={palette} extraActions={
        <Action.Push title="AI 生成色卡图片" icon={Icon.Image} target={<GenerateCard initial={palette} />} />
      } />);
    }}>
    <Form.TextField id="base" title="主色" defaultValue="#6E64D0" />
    <Form.Dropdown id="style" title="风格">{choices(["现代", "复古", "自然", "活泼", "浪漫"])}</Form.Dropdown>
    <Form.Dropdown id="tone" title="冷暖">{choices(["不限", "暖色", "冷色"])}</Form.Dropdown>
    <Form.Dropdown id="count" title="颜色数量" defaultValue="5">{choices(["3", "4", "5", "6", "7", "8"])}</Form.Dropdown>
    <Form.TextArea id="prompt" title="补充说明" placeholder="例如：用于面包店的品牌和包装" />
  </TaskForm>;
}

function GenerateCard({ initial }: { initial?: Palette }) {
  const { push } = useNavigation();
  return <TaskForm<{ input: string; title: string; prompt: string }>
    title="AI 色卡图片" submit="生成色卡图片" actions={<ConfigAction />} run={async ({ input, title, prompt }) => {
      const values = parseList(input);
      const colors = values.map((value, index) => ({ name: "颜色 " + (index + 1), hex: toHex(value) }));
      const settings = await readSettings();
      if (!settings.imageModel.trim()) throw new Error("请先在操作菜单配置图像模型。");
      const description = (prompt ?? "").trim().slice(0, 2000);
      const name = (title ?? "").trim().slice(0, 60) || await aiName(settings, colors, description);
      const { png, preview } = prepareAiCard(await aiImage(settings, colors, name, description), values);
      const filename = (name.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "AI 色卡") + ".png";
      const markdown = ["# " + name.replace(/[<>&`|!*#[\]]/g, ""), "", colors.map(({ hex }) => `\`${hex}\``).join(" · "), "", pngMarkdown(preview)].join("\n");
      push(<Detail navigationTitle="AI 色卡图片已生成" markdown={markdown} actions={<ActionPanel>
        <Action.Push title="保存 PNG" icon={Icon.Download} target={<ImageExport png={() => png} filename={filename} />} />
        <Action.Push title="查看颜色" target={<PaletteView palette={{ title: name, colors }} />} />
      </ActionPanel>} />);
    }}>
    <Form.TextArea id="input" title="色板" defaultValue={initial?.colors.map(({ hex }) => hex).join("\n") ?? "#6E64D0\n#53C4B2\n#F4AD65"} />
    <Form.TextField id="title" title="色卡名称" placeholder="留空由配色模型命名" />
    <Form.TextArea id="prompt" title="画面描述" placeholder="例如：日落时分的海岸，极简海报" />
  </TaskForm>;
}
