import { Action, ActionPanel, Alert, Clipboard, confirmAlert, Form, Icon, List, showToast, Toast } from "@raycast/api";
import { useMemo, useRef, useState } from "react";
import { calculateSheet, type Row } from "./calculate";
import { bodyLimit, lineLimit, sheetTitle, titleLimit, withinLimits, type Sheet } from "./sheets";

export async function copyResult(value: string) {
  await Clipboard.copy(value);
  await showToast({ style: Toast.Style.Success, title: "已复制结果" });
}

function Results({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <List navigationTitle={title + " · 逐行结果"} searchBarPlaceholder="搜索算式、结果或备注">
      <List.EmptyView title="暂无计算结果" />
      {rows.map(({ line, formula, note, value, error }) => (
        <List.Item
          key={line}
          title={line + " · " + (formula || note)}
          subtitle={[value === undefined ? error : "= " + value, formula && note].filter(Boolean).join("  ·  ")}
          actions={value === undefined ? undefined : (
            <ActionPanel>
              <Action title="复制结果" icon={Icon.CopyClipboard} onAction={() => copyResult(value)} />
            </ActionPanel>
          )}
        />
      ))}
    </List>
  );
}

export function Editor({ initial, onSave }: { initial: Sheet; onSave: (sheet: Sheet) => Promise<boolean> }) {
  const [sheet, setSheet] = useState(initial);
  const [fieldError, setFieldError] = useState<string>();
  const [saveError, setSaveError] = useState(false);
  const current = useRef(initial);
  const revision = useRef(0);
  const rows = useMemo(() => calculateSheet(sheet.body), [sheet.body]);
  const latest = rows.reduce<string | undefined>((previous, row) => row.value ?? previous, undefined);
  const preview = rows.filter((row) => row.formula).map(
    ({ line, formula, value, error }) => line + " · " + formula + (value === undefined ? "  →  " + error : "  =  " + value),
  ).join("\n");
  const title = sheetTitle(sheet);

  function persist(next: Sheet) {
    const edit = ++revision.current;
    void onSave(next).then((saved) => {
      if (revision.current === edit) setSaveError(!saved);
    });
  }

  function update(fields: Partial<Pick<Sheet, "title" | "body">>) {
    const next = { ...current.current, ...fields, modified: Date.now() };
    current.current = next;
    setSheet(next);
    persist(next);
  }

  function updateBody(body: string) {
    if (!withinLimits(body)) {
      setFieldError("每张稿纸最多 " + lineLimit + " 行、" + bodyLimit + " 个字符。");
      return;
    }
    setFieldError(undefined);
    update({ body });
  }

  async function clear() {
    const confirmed = await confirmAlert({
      title: "清空当前稿纸？",
      message: "这会移除此稿纸的全部算式和备注。",
      primaryAction: { title: "清空", style: Alert.ActionStyle.Destructive },
    });
    if (confirmed) updateBody("");
  }

  return (
    <Form
      navigationTitle={title}
      actions={
        <ActionPanel>
          {latest !== undefined && (
            <Action
              title="将最后结果带入下一行"
              shortcut={{ modifiers: ["cmd", "shift"], key: "return" }}
              onAction={() => {
                const body = current.current.body;
                updateBody(body + (/\r$|\n$/.test(body) ? "" : "\n") + latest);
              }}
            />
          )}
          <Action.Push title="搜索逐行结果" target={<Results title={title} rows={rows} />} />
          {latest !== undefined && (
            <Action
              title="复制最后结果"
              icon={Icon.CopyClipboard}
              shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
              onAction={() => copyResult(latest)}
            />
          )}
          {saveError && <Action title="重试保存" onAction={() => persist(current.current)} />}
          {sheet.body && <Action title="清空当前稿纸" style={Action.Style.Destructive} onAction={clear} />}
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="标题"
        placeholder="未命名稿纸"
        value={sheet.title}
        onChange={(value) => update({ title: value.slice(0, titleLimit) })}
      />
      <Form.TextArea
        id="body"
        title="算式"
        autoFocus
        placeholder={"price = 128 * 2  # 原价\nans * 85%  # 折后价"}
        info="每行一个算式。用 ans 引用最近结果，@2 引用第 2 行，# 后写备注。"
        value={sheet.body}
        error={fieldError}
        onChange={updateBody}
      />
      {saveError && <Form.Description title="保存失败" text="稿纸仍可编辑。请从操作菜单选择“重试保存”。" />}
      {preview && <Form.Description title="逐行结果" text={preview} />}
    </Form>
  );
}
