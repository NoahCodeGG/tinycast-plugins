import { Action, ActionPanel, Clipboard, environment, Form, Icon, List, LocalStorage, Toast, showToast, useNavigation } from "@raycast/api";
import { basename, join } from "node:path";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { contrastRatio, formats, harmony, parseColor, parseList, toHex, type RGBA, type Swatch } from "./color";
import { cardPng, gradientPng, pngMarkdown, readImagePalette, savePng, stageClipboardPng } from "./images";
import palettes from "./data/palettes.json";
import { preferredColor, readRecentColors, rememberScreenColor, sampleScreen } from "./screen";

export type Palette = { title: string; colors: Swatch[]; angle?: number };
type Favorite = Palette & { id: string };
const favoriteKey = "color-favorites-v1";
let favorites = { items: [] as Favorite[], pending: true };
let favoriteLoad: Promise<void> | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getFavorites = () => favorites;
function publishFavorites(value: Favorite[]) {
  favorites = { items: value, pending: false };
  for (const listener of listeners) listener();
}
const helper = () => join(environment.assetsPath, "color-helper");
const colorsOf = (palette: Palette) => palette.colors.map(({ hex }) => parseColor(hex)!);
const favoriteId = (palette: Palette) => JSON.stringify([palette.angle ?? null, palette.colors.map(({ hex }) => hex)]);
let favoriteWrites = Promise.resolve();

function savedFavorites(raw: unknown): Favorite[] {
  if (typeof raw !== "string") return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((item) => typeof item?.id === "string" && typeof item.title === "string" &&
      Array.isArray(item.colors) && item.colors.length > 0 && item.colors.length <= 12 &&
      item.colors.every((swatch: Swatch) => typeof swatch?.name === "string" && typeof swatch.hex === "string" && parseColor(swatch.hex)) &&
      (item.angle === undefined || (Number.isFinite(item.angle) && item.colors.length >= 2)));
  } catch {
    return [];
  }
}

function loadFavorites() {
  favoriteLoad ??= LocalStorage.getItem(favoriteKey).then((value) => {
    publishFavorites(savedFavorites(value));
  }, async () => {
    publishFavorites([]);
    await notify("无法读取收藏", true);
  });
  return favoriteLoad;
}

async function updateFavorite(palette: Palette, remove: boolean) {
  const id = favoriteId(palette);
  const run = favoriteWrites.then(async () => {
    await loadFavorites();
    const current = savedFavorites(await LocalStorage.getItem(favoriteKey));
    const rest = current.filter((item) => item.id !== id);
    const next = remove ? rest : [{ ...palette, id }, ...rest];
    await LocalStorage.setItem(favoriteKey, JSON.stringify(next));
    publishFavorites(next);
  });
  favoriteWrites = run.catch(() => {});
  try {
    await run;
    await notify(remove ? "已移除收藏" : "已收藏");
  } catch {
    await notify("无法更新收藏", true);
  }
}

export function notify(title: string, failure = false) {
  return showToast({ title, style: failure ? Toast.Style.Failure : Toast.Style.Success });
}

export function Copy({ title, value }: { title: string; value: string }) {
  return <Action title={title} icon={Icon.CopyClipboard} onAction={async () => {
    try {
      await Clipboard.copy(value);
      await notify("已复制");
    } catch {
      await notify("无法复制", true);
    }
  }} />;
}

export function FavoriteAction({ palette, remove = false }: { palette: Palette; remove?: boolean }) {
  return <Action title={remove ? "移除收藏" : palette.angle !== undefined ? "收藏渐变" : palette.colors.length > 1 ? "收藏整张色卡" : "收藏此颜色"} icon={Icon.Star} onAction={() => updateFavorite(palette, remove)} />;
}

export function Favorites() {
  const { items, pending } = useSyncExternalStore(subscribe, getFavorites);
  useEffect(() => { void loadFavorites(); }, []);
  return <List navigationTitle="收藏颜色" searchBarPlaceholder="搜索名称或色值" isLoading={pending}>
    <List.EmptyView title="还没有收藏" description="可从颜色、色卡或渐变的操作菜单添加。" />
    {items.map((item) => <List.Item key={item.id} title={item.title} icon={swatchIcon(item.colors[0].hex)}
      subtitle={item.colors.map(({ hex }) => hex).join("  ")} keywords={item.colors.flatMap(({ name, hex }) => [name, hex, hex.slice(1)])}
      actions={<ActionPanel>
        <Action.Push title="打开收藏" target={item.angle === undefined
          ? item.colors.length === 1 ? <Inspector initial={item.colors[0].hex} /> : <PaletteView palette={item} />
          : <GradientView palette={item} />} />
        <FavoriteAction palette={item} remove />
      </ActionPanel>} />)}
  </List>;
}

export function TaskForm<Values extends Record<string, unknown>>({ title, submit, run, children, actions }: {
  title: string; submit: string; run: (values: Values) => Promise<void> | void; children: ReactNode; actions?: ReactNode;
}) {
  const busy = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function handle(values: Values) {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError("");
    try {
      await run(values);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "处理失败。");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }
  return <Form navigationTitle={title} isLoading={loading}
    actions={<ActionPanel><Action.SubmitForm<Values> title={submit} onSubmit={handle} />{actions}</ActionPanel>}>
    {children}
    {error && <Form.Description title="处理失败" text={error} />}
  </Form>;
}

export function swatchIcon(hex: string) {
  const parsed = parseColor(hex);
  return { source: Icon.CircleFilled, tintColor: parsed ? toHex(parsed.slice(0, 3) as [number, number, number]) : "#888888" };
}

function CardActions({ png, filename }: { png: () => Buffer; filename: string }) {
  return <>
    <Action.Push title="导出 PNG" icon={Icon.Download} target={<ImageExport png={png} filename={filename} />} />
    <Action title="复制 PNG" icon={Icon.CopyClipboard} onAction={async () => {
      try {
        await stageClipboardPng(png(), (file) => Clipboard.copy({ file }));
        await notify("已复制 PNG");
      } catch {
        await notify("无法复制 PNG", true);
      }
    }} />
  </>;
}

export function ImageExport({ png, filename }: { png: () => Buffer; filename: string }) {
  const { pop } = useNavigation();
  return <TaskForm<{ folders: string[] }> title="导出 PNG" submit="保存图片" run={async ({ folders }) => {
    if (!folders?.[0]) throw new Error("请选择保存目录。");
    try {
      await savePng(folders[0], filename, png());
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException)?.code === "EEXIST") throw new Error(`目录中已有「${filename}」，请另选目录。`);
      throw new Error("无法保存图片，请检查目录的写入权限。");
    }
    await notify("已保存 " + filename);
    pop();
  }}>
    <Form.FilePicker id="folders" title="保存目录" canChooseDirectories canChooseFiles={false} allowMultipleSelection={false} />
    <Form.Description title="文件名" text={filename} />
  </TaskForm>;
}

export function RecentColors() {
  const [items, setItems] = useState<string[]>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let mounted = true;
    void readRecentColors().then(
      (value) => { if (mounted) setItems(value); },
      () => {
        if (!mounted) return;
        setItems([]);
        setFailed(true);
      },
    );
    return () => { mounted = false; };
  }, []);
  return <List navigationTitle="最近取色" searchBarPlaceholder="搜索色值" isLoading={items === undefined}>
    {items && <List.EmptyView title={failed ? "无法读取最近取色" : "还没有取色记录"}
      description={failed ? undefined : "在启动器运行「快速屏幕取色」，点击任意屏幕像素。"} />}
    {items?.map((hex) => {
      const formatted = preferredColor(hex);
      return <List.Item key={hex} title={hex} subtitle={formatted === hex ? undefined : formatted}
        icon={swatchIcon(hex)} keywords={[hex.slice(1), formatted]} actions={<ActionPanel>
          <Copy title="复制色值" value={formatted} />
          <Action.Push title="查看色值" target={<Inspector initial={hex} />} />
          <FavoriteAction palette={{ title: hex, colors: [{ name: hex, hex }] }} />
        </ActionPanel>} />;
    })}
  </List>;
}

export function ScreenAction({ onPick }: { onPick: (hex: string) => void }) {
  return <Action title="屏幕取色" icon={Icon.EyeDropper} shortcut={{ modifiers: ["cmd", "shift"], key: "p" }} onAction={async () => {
    let hex: string | undefined;
    try {
      hex = await sampleScreen();
    } catch {
      await notify("无法完成屏幕取色", true);
      return;
    }
    if (!hex) return;
    try {
      await rememberScreenColor(hex);
    } catch {
      await notify("无法保存取色历史", true);
    }
    onPick(hex);
  }} />;
}

export function Inspector({ initial = "#6E64D0" }: { initial?: string }) {
  const [input, setInput] = useState(initial);
  const [plain, setPlain] = useState(false);
  const color = parseColor(input);
  const previews = useMemo(() => {
    const selected = parseColor(input);
    if (!selected) return {};
    const values = [toHex(selected), ...harmony(selected).map(({ hex }) => hex)];
    return Object.fromEntries([...new Set(values)].map((hex) => [hex, pngMarkdown(cardPng([parseColor(hex)!]))]));
  }, [input]);
  const hex = color ? toHex(color) : "";
  const palette = { title: hex, colors: [{ name: hex, hex }] };
  const actions = <>
    <Action.Push title="编辑色值" icon={Icon.Pencil} shortcut={{ modifiers: ["cmd"], key: "e" }}
      target={<ColorInput initial={input} apply={setInput} />} />
    <ScreenAction onPick={setInput} />
    <Action title="读取剪贴板色值" icon={Icon.Clipboard} shortcut={{ modifiers: ["cmd", "shift"], key: "v" }} onAction={async () => {
      const value = await Clipboard.readText();
      if (value && parseColor(value)) setInput(value);
      else await notify("剪贴板没有可识别的色值", true);
    }} />
    {color && <>
      <FavoriteAction palette={palette} />
      <Action.Push title="比较颜色" icon={Icon.Contrast} target={<Compare initial={hex + "\n#FFFFFF"} />} />
      <Action title={plain ? "复制 HEX 时保留 #" : "复制 HEX 时去掉 #"} onAction={() => setPlain(!plain)} />
    </>}
  </>;
  return <List navigationTitle="颜色转换" searchBarPlaceholder="输入新色值，如 #3457D5 或 rgb(52 87 213)" filtering={false}
    onSearchTextChange={(value) => { if (value) setInput(value); }} isShowingDetail={Boolean(color)}
    actions={<ActionPanel>{actions}</ActionPanel>}>
    <List.EmptyView title="请输入有效色值" description="支持 HEX、RGB(A)、HSL(A)、HSV / HSB 和 CMYK。按 ⌘E 可修改完整输入。" />
    {color && <List.Section title="色值">
      {formats(color).map(({ name, hex: value }) => <List.Item key={name} title={name} subtitle={value}
        icon={swatchIcon(hex)} detail={<List.Item.Detail markdown={previews[hex] + "\n\n**" + value + "**"} />}
        actions={<ActionPanel><Copy title={"复制 " + name} value={plain && name === "HEX" ? value.slice(1) : value} />{actions}</ActionPanel>} />)}
    </List.Section>}
    {color && <List.Section title="相关配色">
      {harmony(color).map((swatch) => <List.Item key={swatch.name} title={swatch.name} subtitle={swatch.hex}
        icon={swatchIcon(swatch.hex)} detail={<List.Item.Detail markdown={previews[swatch.hex]} />}
        actions={<ActionPanel>
          <Copy title="复制 HEX" value={plain ? swatch.hex.slice(1) : swatch.hex} />
          <Action title="查看色值" onAction={() => setInput(swatch.hex)} />
          <FavoriteAction palette={{ title: swatch.hex, colors: [swatch] }} />
        </ActionPanel>} />)}
    </List.Section>}
  </List>;
}

function ColorInput({ initial, apply }: { initial: string; apply: (value: string) => void }) {
  const { pop } = useNavigation();
  return <TaskForm<{ input: string }> title="编辑色值" submit="应用颜色" run={({ input }) => {
    if (!parseColor(input)) throw new Error("无法识别色值，请检查格式和分量范围。");
    apply(input);
    pop();
  }}>
    <Form.TextField id="input" title="颜色" defaultValue={initial} />
    <Form.Description text="#6E64D0 · rgb(110 100 208 / 50%) · hsl(246 53% 60%) · hsv(246, 52%, 82%) · cmyk(47%, 52%, 0%, 18%)" />
  </TaskForm>;
}

export function Compare({ initial = "#6E64D0\n#FFFFFF" }: { initial?: string }) {
  const { push } = useNavigation();
  return <TaskForm<{ input: string }> title="比较颜色" submit="预览对比" run={({ input }) => {
    const colors = parseList(input);
    const palette = {
      title: "颜色对比",
      colors: colors.map((color, i) => ({ name: i === 0 ? "背景色" : `颜色 ${i + 1}`, hex: toHex(color) })),
    };
    push(<PaletteView palette={palette} compare />);
  }}>
    <Form.TextArea id="input" title="颜色" defaultValue={initial} />
    <Form.Description text="输入 2–12 个颜色，每行一个或用空格分隔。第一项作为背景色，结果会显示其他颜色与它的对比度。" />
  </TaskForm>;
}

export function PaletteView({ palette, compare = false, extraActions }: { palette: Palette; compare?: boolean; extraActions?: ReactNode }) {
  const colors = useMemo(() => colorsOf(palette), [palette]);
  const card = useMemo(() => cardPng(colors), [colors]);
  const preview = pngMarkdown(card);
  return <List navigationTitle={palette.title} isShowingDetail searchBarPlaceholder="搜索色值或色名">
    {palette.colors.map((swatch, i) => {
      const ratio = compare && i !== 0 ? contrastRatio(colors[i], colors[0]) : undefined;
      return <List.Item key={i} title={swatch.name} subtitle={swatch.hex} keywords={[swatch.hex, swatch.hex.slice(1)]}
        icon={swatchIcon(swatch.hex)} detail={<List.Item.Detail markdown={preview + "\n\n**" + swatch.hex + "**" +
          (ratio === undefined ? "" : `\n\n对比度 **${ratio.toFixed(2)}:1** · 普通文本 WCAG AA ${ratio >= 4.5 ? "通过" : "未通过"}` +
            (colors[0][3] !== 255 ? "\n\n透明背景先叠加在白色上。" : ""))} />}
        actions={<ActionPanel>
          <Copy title="复制 HEX" value={swatch.hex} />
          <Action.Push title="查看色值" target={<Inspector initial={swatch.hex} />} />
          <FavoriteAction palette={{ title: swatch.name === swatch.hex ? swatch.hex : swatch.name + " " + swatch.hex, colors: [swatch] }} />
          <Copy title="复制全部色值" value={palette.colors.map(({ hex }) => hex).join("\n")} />
          {palette.colors.length > 1 && <FavoriteAction palette={palette} />}
          <CardActions png={() => card} filename="色卡.png" />
          {extraActions}
        </ActionPanel>} />;
    })}
  </List>;
}

const traditional = ["中国传统色", "日本传统色"] as const;
const ui = ["Flat UI", "Fluent Design", "Open Color", "Ant Design", "Material Design"] as const;

export function Catalog({ kind }: { kind: "traditional" | "ui" }) {
  return <List navigationTitle={kind === "ui" ? "UI 色卡" : "传统色"} searchBarPlaceholder="搜索色卡">
    {(kind === "ui" ? ui : traditional).map((name) => <List.Item key={name} title={name} icon={Icon.Swatch}
      subtitle={palettes[name].length + " 色"}
      actions={<ActionPanel><Action.Push title="浏览颜色" target={<CatalogColors name={name} />} /></ActionPanel>} />)}
  </List>;
}

function CatalogColors({ name }: { name: keyof typeof palettes }) {
  const [input, setInput] = useState("");
  const query = input.trim().toLowerCase();
  const rows = palettes[name].filter(([label, hex, group]) =>
    !query || [label, hex, group ?? ""].some((value) => value.toLowerCase().includes(query)));
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = row[2] ?? "";
    const entry = groups.get(group) ?? [];
    entry.push(row);
    groups.set(group, entry);
  }

  return <List navigationTitle={name} searchBarPlaceholder={name === "中国传统色" ? "搜索色名、HEX 或节气" : "搜索色名或 HEX"}
    filtering={false} onSearchTextChange={setInput}>
    <List.EmptyView title="没有匹配的颜色" />
    {[...groups].map(([group, colors]) => <List.Section key={group} title={group || undefined}>
      {colors.map(([label, hex], i) => <List.Item key={i} title={label} subtitle={hex}
        icon={swatchIcon(hex)} actions={<ActionPanel>
          <Copy title="复制 HEX" value={hex} />
          <Action.Push title="查看色值" target={<Inspector initial={hex} />} />
          <FavoriteAction palette={{ title: label + " " + hex, colors: [{ name: label, hex }] }} />
        </ActionPanel>} />)}
    </List.Section>)}
  </List>;
}

export function ImagePalette() {
  const { push } = useNavigation();
  const [count, setCount] = useState("6");
  const busy = useRef(false);
  async function extract(file: string | undefined, count: string) {
    const colors = await readImagePalette(helper(), file, Number(count || "6"));
    push(<PaletteView palette={{ title: file ? basename(file) : "剪贴板图片色卡", colors }} />);
  }
  async function run(file: string | undefined, count: string) {
    if (busy.current) return;
    busy.current = true;
    try {
      await extract(file, count);
    } finally {
      busy.current = false;
    }
  }
  return <TaskForm<{ files: string[]; count: string }> title="图片色卡" submit="提取主色"
    run={async ({ files, count }) => {
      if (!files?.[0]) throw new Error("请选择一张图片。");
      await run(files[0], count);
    }}
    actions={<Action title="从剪贴板提取颜色" icon={Icon.Clipboard} shortcut={{ modifiers: ["cmd", "shift"], key: "v" }} onAction={async () => {
      try {
        const contents = await Clipboard.read();
        const file = contents?.file ? String(contents.file) : undefined;
        const path = file?.startsWith("file:") ? decodeURIComponent(new URL(file).pathname) : file;
        await run(path, count);
      } catch (reason) {
        await notify(reason instanceof Error ? reason.message : "无法读取剪贴板", true);
      }
    }} />}>
    <Form.FilePicker id="files" title="图片" allowMultipleSelection={false} />
    <Form.Dropdown id="count" title="最多提取" value={count} onChange={setCount}>
      {["3", "4", "5", "6", "7", "8", "9", "10"].map((value) => <Form.Dropdown.Item key={value} title={value + " 色"} value={value} />)}
    </Form.Dropdown>
  </TaskForm>;
}

const gradients = [
  ["晨光", "#F8D37B", "#F38381"], ["珊瑚", "#EF529D", "#FC7767"], ["极光", "#36D8C8", "#6764D9"],
  ["莓紫", "#652960", "#CA405F"], ["薄荷", "#52D974", "#278C9E"], ["海雾", "#A2D9F4", "#3872CB"],
  ["青黛", "#1F5363", "#6BBE84"], ["日暮", "#271649", "#D95970", "#F8A663"],
  ["柠檬", "#F4EC8E", "#F6C944"], ["银灰", "#EDF0F4", "#7A8798"],
];

export function Gradients() {
  return <List navigationTitle="渐变色" searchBarPlaceholder="搜索预设或创建渐变">
    <List.Item title="新建渐变" icon={Icon.Plus} actions={<ActionPanel>
      <Action.Push title="编辑渐变" target={<GradientForm />} />
    </ActionPanel>} />
    {gradients.map(([title, ...stops]) => <List.Item key={title} title={title} subtitle={stops.join(" → ")}
      icon={swatchIcon(stops[0])} keywords={stops}
      actions={<ActionPanel><Action.Push title="查看渐变" target={<GradientView palette={{
        title, colors: stops.map((hex, i) => ({ name: "色标 " + (i + 1), hex })), angle: 135,
      }} />} /></ActionPanel>} />)}
  </List>;
}

function GradientForm({ initial }: { initial?: Palette }) {
  const { push } = useNavigation();
  return <TaskForm<{ colors: string; angle: string }> title="编辑渐变" submit="预览渐变" run={({ colors, angle }) => {
    const degrees = Number(angle);
    if (!angle.trim() || !Number.isFinite(degrees)) throw new Error("请输入有效角度。");
    push(<GradientView palette={{
      title: initial?.title ?? "自定义渐变",
      colors: parseList(colors).map((value, i) => ({ name: "色标 " + (i + 1), hex: toHex(value) })),
      angle: ((degrees % 360) + 360) % 360,
    }} />);
  }}>
    <Form.TextArea id="colors" title="色标" defaultValue={initial?.colors.map(({ hex }) => hex).join("\n") ?? "#6E64D0\n#53C4B2"} />
    <Form.TextField id="angle" title="角度（°）" defaultValue={String(initial?.angle ?? 135)} />
  </TaskForm>;
}

function GradientView({ palette }: { palette: Palette }) {
  const angle = palette.angle ?? 135;
  const colors = useMemo(() => colorsOf(palette), [palette]);
  const css = `linear-gradient(${angle}deg, ${palette.colors.map(({ hex }) => hex).join(", ")})`;
  const markdown = useMemo(() => pngMarkdown(gradientPng(colors, angle, 480, 200)), [colors, angle]);
  const common = <>
    <Action.Push title="编辑色标与角度" icon={Icon.Pencil} target={<GradientForm initial={palette} />} />
    <FavoriteAction palette={palette} />
    <Action.Push title="选择尺寸并导出 PNG" icon={Icon.Download} target={<GradientExport colors={colors} angle={angle} />} />
    <Action title="复制渐变 PNG（1000 × 1000）" icon={Icon.CopyClipboard} onAction={async () => {
      try {
        await stageClipboardPng(gradientPng(colors, angle, 1000, 1000), (file) => Clipboard.copy({ file }));
        await notify("已复制渐变 PNG");
      } catch {
        await notify("无法复制渐变 PNG", true);
      }
    }} />
  </>;
  return <List navigationTitle={palette.title} isShowingDetail searchBarPlaceholder="搜索色标或 CSS">
    <List.Item title="CSS" subtitle={css} detail={<List.Item.Detail markdown={markdown + "\n\n`" + css + "`"} />}
      actions={<ActionPanel><Copy title="复制 CSS" value={css} />{common}</ActionPanel>} />
    {palette.colors.map(({ name, hex }, i) => <List.Item key={i} title={name} subtitle={hex}
      icon={swatchIcon(hex)} detail={<List.Item.Detail markdown={markdown} />}
      actions={<ActionPanel><Copy title="复制色值" value={hex} />{common}</ActionPanel>} />)}
  </List>;
}

function GradientExport({ colors, angle }: { colors: RGBA[]; angle: number }) {
  const { push } = useNavigation();
  return <TaskForm<{ width: string; height: string }> title="渐变 PNG 尺寸" submit="选择保存目录" run={({ width, height }) => {
    const [w, h] = [Number(width), Number(height)];
    if (![w, h].every((edge) => Number.isInteger(edge) && edge >= 1 && edge <= 2400)) {
      throw new Error("宽和高须为 1–2400 的整数。");
    }
    push(<ImageExport png={() => gradientPng(colors, angle, w, h)} filename="渐变.png" />);
  }}>
    <Form.TextField id="width" title="宽度（px）" defaultValue="1000" />
    <Form.TextField id="height" title="高度（px）" defaultValue="1000" />
  </TaskForm>;
}
