import { Action, ActionPanel, Clipboard, Form, Icon, List, Toast, clearSearchBar, showToast, useNavigation, type Keyboard } from "@raycast/api";
import { useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ConversionInput } from "./conversion-input";

export type Result = { label: string; value: string } | { label: string; error: string };

export function CopyResult({ title = "复制结果", value, shortcut }: { title?: string; value: string; shortcut?: Keyboard.Shortcut }) {
  return <Action title={title} icon={Icon.CopyClipboard} shortcut={shortcut} onAction={async () => {
    await Clipboard.copy(value);
    await showToast({ style: Toast.Style.Success, title: "已复制" });
  }} />;
}

const previewLimit = 4_096;

function preview(text: string): string {
  if (!text) return "空字符串";
  const sample = text.slice(0, previewLimit).replace(/\r\n|\r/g, "\n");
  // Tinycast treats any line starting with a fence as a toggle, even inside a code block.
  const literal = sample.split("\n").map((line) => /^\s*```/.test(line) ? "\u200B" + line : line).join("\n");
  const suffix = text.length > previewLimit ? "\n预览已截短。" : "";
  return "```\n" + literal + "\n```" + suffix;
}

export function Results({ title, rows }: { title: string; rows: Result[] }) {
  return <ResultList rows={rows} title={title} placeholder="筛选结果" />;
}

const copyKeys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

function ResultList({ rows, title, placeholder, actions, empty, sourcePreview, onInput }: {
  rows: Result[];
  title: string;
  placeholder: string;
  actions?: ReactNode;
  empty?: ReactNode;
  sourcePreview?: string;
  onInput?: (text: string) => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  let nextKey = 0;
  const results = rows.map((row) => ({ row, key: "value" in row ? copyKeys[nextKey++] : undefined }));

  return (
    <List
      navigationTitle={title}
      searchBarPlaceholder={placeholder}
      filtering={!onInput}
      onSearchTextChange={onInput}
      isShowingDetail={showPreview && rows.length > 0}
      actions={actions ? <ActionPanel>{actions}</ActionPanel> : undefined}
    >
      {empty}
      {results.map(({ row, key }) => {
        const ownShortcut = key ? { modifiers: ["cmd"], key } satisfies Keyboard.Shortcut : undefined;
        const text = "value" in row
          ? (row.value.slice(0, 121).replace(/\r\n|\r|\n/g, " ↵ ") || "空字符串")
          : row.error;
        return (
          <List.Item
            key={row.label}
            id={row.label}
            title={row.label}
            subtitle={text.length > 120 ? text.slice(0, 120) + "…" : text}
            accessories={key ? [{ text: "⌘" + key, tooltip: "直接复制" + row.label }] : undefined}
            detail={showPreview ? <List.Item.Detail markdown={("value" in row ? preview(row.value) : row.error) + (sourcePreview ?? "")} /> : undefined}
            actions={<ActionPanel>
              {"value" in row && <CopyResult value={row.value} shortcut={ownShortcut} />}
              <Action
                title={showPreview ? "关闭结果预览" : "展开结果预览"}
                icon={Icon.Eye}
                shortcut={{ modifiers: ["cmd"], key: "p" }}
                onAction={() => setShowPreview((visible) => !visible)}
              />
              {actions}
              <ActionPanel.Section title="按编号复制">
                {results.map(({ row: other, key: shortcutKey }) => other !== row && shortcutKey && "value" in other && (
                  <CopyResult key={other.label} title={"复制" + other.label} value={other.value} shortcut={{ modifiers: ["cmd"], key: shortcutKey }} />
                ))}
              </ActionPanel.Section>
            </ActionPanel>}
          />
        );
      })}
    </List>
  );
}

export function OperationForm<Values extends Record<string, unknown>>({
  title, action, run, children, extraActions, status,
}: {
  title: string;
  action: string;
  run: (values: Values) => Promise<ReactNode> | ReactNode;
  children: ReactNode;
  extraActions?: ReactNode;
  status?: string;
}) {
  const { push } = useNavigation();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(false);

  async function submit(values: Values) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await run(values);
      if (result) push(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  return (
    <Form
      navigationTitle={title}
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm<Values> title={action} onSubmit={submit} />
          {extraActions}
        </ActionPanel>
      }
    >
      {children}
      {busy && status && <Form.Description text={status} />}
      {error && <Form.Description title="处理失败" text={error} />}
    </Form>
  );
}

export function useTextInput(initial = "") {
  const [text, setText] = useState(initial);
  return {
    field: { value: text, onChange: setText },
    pasteAction: (
      <Action title="读取剪贴板文本" onAction={async () => {
        const value = await Clipboard.readText();
        if (typeof value === "string") setText(value);
      }} />
    ),
  };
}

export function TextTool({
  title, placeholder, calculate, allowEmpty = false, refreshEmpty = false, extraActions,
}: {
  title: string;
  placeholder: string;
  calculate: (text: string) => Result[];
  allowEmpty?: boolean;
  refreshEmpty?: boolean;
  extraActions?: ReactNode;
}) {
  const recognized = useContext(ConversionInput);
  const [input, setInput] = useState<{ text: string; source: "search" | "clipboard" | "editor" | "recognized" }>(() =>
    recognized ? { text: recognized.text, source: "recognized" } : { text: "", source: "search" },
  );
  const [refresh, setRefresh] = useState(0);
  const revision = useRef(0);
  const result = useMemo(() => {
    if (!input.text && !allowEmpty) return { rows: [] };
    if (input.text.length > 65_536) return { rows: [], error: "文本最多支持 65,536 个 UTF-16 代码单元。" };
    try {
      const rows = calculate(input.text);
      const values = rows.filter((row) => "value" in row);
      const preferred = input.source === "recognized" ? values.findIndex((row) => row.label === recognized?.preferredLabel) : -1;
      if (preferred > 0) values.unshift(...values.splice(preferred, 1));
      return { rows: [...values, ...rows.filter((row) => "error" in row)] };
    } catch (error) {
      return { rows: [], error: error instanceof Error ? error.message : String(error) };
    }
  }, [input, allowEmpty, calculate, refresh, recognized]);

  function type(text: string) {
    revision.current++;
    // Tinycast's native search field collapses line breaks. A blank echo from clearing it
    // must not replace a multiline value supplied through the clipboard or editor.
    setInput((current) => (text || current.source === "search") && text !== current.text ? { text, source: "search" } : current);
  }

  async function replace(text: string, source: typeof input.source) {
    revision.current++;
    setInput({ text, source });
    await clearSearchBar();
  }

  async function paste() {
    const request = ++revision.current;
    const text = await Clipboard.readText();
    if (request !== revision.current) return;
    if (!text) {
      await showToast({ style: Toast.Style.Failure, title: "剪贴板没有文本" });
      return;
    }
    await replace(text, "clipboard");
  }

  const actions = (
    <>
      <Action title="读取剪贴板文本" icon={Icon.Clipboard} shortcut={{ modifiers: ["cmd", "shift"], key: "v" }} onAction={paste} />
      <Action.Push
        title="编辑多行文本"
        icon={Icon.Pencil}
        shortcut={{ modifiers: ["cmd"], key: "e" }}
        target={<MultilineEditor initial={input.text} apply={(text) => replace(text, "editor")} />}
      />
      {input.text && <Action title="清空输入" onAction={() => replace("", "search")} />}
      {refreshEmpty && !input.text && <Action title="刷新当前时间" icon={Icon.ArrowClockwise} onAction={() => setRefresh((now) => now + 1)} />}
      {extraActions}
    </>
  );
  const retainedInputTitle = input.source === "clipboard" ? "剪贴板输入" : input.source === "recognized" ? "识别到的输入" : "多行输入";
  const source = input.source !== "search" && input.text ? "\n\n**" + retainedInputTitle + "**\n\n" + preview(input.text) : "";
  return (
    <ResultList
      title={title}
      placeholder={input.source === "search" ? placeholder : "键入以替换" + retainedInputTitle}
      rows={result.rows}
      onInput={type}
      actions={actions}
      sourcePreview={source}
      empty={<List.EmptyView
        title={result.error ?? "输入或粘贴文本"}
        description="输入后立即转换。⌘⇧V 读取完整剪贴板文本。"
      />}
    />
  );
}

function MultilineEditor({ initial, apply }: { initial: string; apply: (text: string) => Promise<void> }) {
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle="编辑多行文本"
      actions={<ActionPanel>
        <Action.SubmitForm<{ input: string }> title="应用文本" onSubmit={async ({ input }) => {
          pop();
          await apply(input);
        }} />
      </ActionPanel>}
    >
      <Form.TextArea id="input" title="输入" defaultValue={initial} />
    </Form>
  );
}
