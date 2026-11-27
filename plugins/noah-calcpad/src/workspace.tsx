import { Action, ActionPanel, clearSearchBar, Color, Form, Icon, List, useNavigation } from "@raycast/api";
import { useMemo, useRef, useState } from "react";
import { calculateSheet, type Row } from "./calculate";
import { copyResult, Editor } from "./editor";
import { copySheetImage } from "./sheet-image";
import { bodyLimit, lineLimit, saveSheet, titleLimit, withinLimits, type Sheet } from "./sheets";

const lineBreak = /\r\n|\n|\r/;
const limitMessage = `每张稿纸最多 ${lineLimit} 行、${bodyLimit} 个字符。`;

function appendLine(body: string, line: string) {
  if (!line) return body;
  return body + (body && !/[\r\n]$/.test(body) ? "\n" : "") + line;
}

function expandedInput(input: string, carry?: string) {
  const expression = input.trim().normalize("NFKC");
  if (!carry || !/^[+\-*/^%×÷−]/.test(expression)) return input;
  const number = carry.startsWith("-") ? `(${carry})` : carry;
  return number + " " + input.trimStart();
}

function EditLine({ row, noteOnly, onSave }: { row: Row; noteOnly: boolean; onSave: (formula: string, note: string) => boolean }) {
  const [formula, setFormula] = useState(row.formula);
  const [note, setNote] = useState(row.note);
  const [error, setError] = useState<string>();
  const { pop } = useNavigation();

  function save() {
    if (/[#＃\r\n]/.test(formula) || lineBreak.test(note)) {
      setError("算式和备注各占一行，请把 # 后的内容填入备注。");
      return;
    }
    if (onSave(formula.trim(), note.trim())) pop();
    else setError(limitMessage);
  }

  return (
    <Form
      navigationTitle={noteOnly ? `第 ${row.line} 行备注` : `编辑第 ${row.line} 行`}
      actions={<ActionPanel><Action title={noteOnly ? "保存备注" : "保存此行"} onAction={save} /></ActionPanel>}
    >
      {noteOnly ? <Form.Description title="算式" text={row.formula} /> : (
        <Form.TextField id="formula" title="算式" autoFocus value={formula} onChange={setFormula} />
      )}
      <Form.TextField id="note" title="备注" autoFocus={noteOnly} value={note} onChange={setNote} />
      {error && <Form.Description title="无法保存" text={error} />}
    </Form>
  );
}

function RenameSheet({ sheet, onSave }: { sheet: Sheet; onSave: (title: string) => void }) {
  const [title, setTitle] = useState(sheet.title);
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle="修改稿纸名称"
      actions={<ActionPanel><Action title="保存名称" onAction={() => { onSave(title.trim()); pop(); }} /></ActionPanel>}
    >
      <Form.TextField id="name" title="名称" autoFocus placeholder="未命名稿纸"
        value={title} onChange={(value) => setTitle(value.slice(0, titleLimit))} />
    </Form>
  );
}

type WorkspaceProps = {
  initial: Sheet;
  onChange: (sheet: Sheet) => void;
  onNew: () => void;
  onBrowse: () => void;
  onDelete: (sheet: Sheet) => Promise<ReadonlySet<string>>;
};

export function Workspace({ initial, onChange, onNew, onBrowse, onDelete }: WorkspaceProps) {
  const [sheet, setSheet] = useState(initial);
  const [input, setInput] = useState("");
  const [carry, setCarry] = useState<string>();
  const [saveError, setSaveError] = useState(false);
  const current = useRef(initial);
  const base = useRef(initial.body);
  const carried = useRef<string>();
  const revision = useRef(0);
  const { push } = useNavigation();
  const rows = useMemo(() => calculateSheet(sheet.body), [sheet.body]);
  const hasInput = input.trim().length > 0;
  const withinSheet = !hasInput || withinLimits(appendLine(base.current, expandedInput(input, carry)));
  const activeLine = sheet.body.split(lineBreak).length;
  const activeRow = hasInput && withinSheet && rows.at(-1)?.line === activeLine ? rows.at(-1) : undefined;

  function receive(next: Sheet) {
    current.current = next;
    setSheet(next);
    onChange(next);
  }

  async function persist(next: Sheet) {
    const edit = ++revision.current;
    const saved = await saveSheet(next).then(() => true, () => false);
    if (edit === revision.current) setSaveError(!saved);
    return saved;
  }

  function update(fields: Partial<Pick<Sheet, "body" | "title" | "locked">>) {
    const next = { ...current.current, ...fields, modified: Date.now() };
    receive(next);
    void persist(next);
  }

  function updateBody(body: string) {
    if (!current.current.locked && body !== current.current.body) update({ body });
  }

  function changeInput(value: string) {
    if (current.current.locked) return;
    setInput(value);
    const expression = value.trim() ? expandedInput(value, carried.current) : "";
    const body = appendLine(base.current, expression);
    if (withinLimits(body)) updateBody(body);
  }

  async function finishInput(value?: string) {
    base.current = current.current.body;
    carried.current = value;
    setCarry(value);
    setInput("");
    await clearSearchBar();
  }

  async function editLine(row: Row, noteOnly = false) {
    if (current.current.locked) return;
    await finishInput();
    push(<EditLine row={row} noteOnly={noteOnly} onSave={(formula, note) => {
      // Keep the physical line number used by @N references, even when this line is cleared.
      const parts = base.current.split(/(\r\n|\n|\r)/);
      const index = (row.line - 1) * 2;
      const expression = noteOnly ? parts[index].split(/[#＃]/, 1)[0].trimEnd() : formula;
      parts[index] = expression + (note ? (expression ? " # " : "# ") + note : "");
      const body = parts.join("");
      if (!withinLimits(body)) return false;
      base.current = body;
      updateBody(body);
      return true;
    }} />);
  }

  async function rename() {
    if (current.current.locked) return;
    await finishInput();
    push(<RenameSheet sheet={current.current} onSave={(title) => {
      if (title !== current.current.title) update({ title });
    }} />);
  }

  async function toggleLock() {
    await finishInput();
    update({ locked: !current.current.locked });
  }

  async function editSheet() {
    if (current.current.locked) return;
    await finishInput();
    push(<Editor initial={current.current} onSave={(next) => {
      base.current = next.body;
      receive(next);
      return persist(next);
    }} />);
  }

  async function browseSheets() {
    await finishInput();
    onBrowse();
  }

  const sharedActions = (
    <>
      <ActionPanel.Section>
        <Action title="稿纸列表" icon={Icon.Folder} shortcut={{ modifiers: ["cmd"], key: "o" }} onAction={browseSheets} />
        <Action title="新建稿纸" icon={Icon.Plus} shortcut={{ modifiers: ["cmd"], key: "n" }} onAction={async () => {
          await finishInput();
          onNew();
        }} />
        {!sheet.locked && <Action title="修改稿纸名称" icon={Icon.Pencil} onAction={rename} />}
        {!sheet.locked && <Action title="编辑整张稿纸" icon={Icon.Document} shortcut={{ modifiers: ["cmd", "shift"], key: "e" }} onAction={editSheet} />}
        {!sheet.locked && <Action title="锁定稿纸" icon={Icon.Lock} onAction={toggleLock} />}
        {sheet.locked && <Action title="解锁稿纸" icon={Icon.LockUnlocked} onAction={toggleLock} />}
        <Action title="复制稿纸为图片" icon={Icon.Image} onAction={() => copySheetImage(current.current)} />
        {saveError && <Action title="重试保存" onAction={() => { void persist(current.current); }} />}
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action title="删除此稿纸" icon={Icon.Trash} style={Action.Style.Destructive} onAction={async () => {
          await finishInput();
          await onDelete(current.current);
        }} />
      </ActionPanel.Section>
    </>
  );

  function lineActions(row: Row) {
    if (sheet.locked) return null;
    return (
      <>
        <Action title={row.note ? "修改备注" : "添加备注"} icon={Icon.Pencil}
          shortcut={{ modifiers: ["cmd"], key: "b" }} onAction={() => editLine(row, true)} />
        <Action title="编辑此行" onAction={() => editLine(row)} />
      </>
    );
  }

  function copyAction(value: string) {
    return (
      <Action
        title="复制结果"
        icon={Icon.CopyClipboard}
        shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
        onAction={() => copyResult(value)}
      />
    );
  }

  const composerTitle = activeRow?.formula || activeRow?.note || (hasInput ? input : carry ? `从 ${carry} 继续` : "输入算式");
  const composerValue = activeRow?.value ?? (!hasInput ? carry : undefined);

  return (
    <List
      navigationTitle={sheet.title.trim() || "计算稿纸"}
      searchBarPlaceholder={sheet.locked ? "搜索已锁定稿纸中的算式或备注" : carry ? "输入运算符继续，或直接输入新算式" : "输入算式，例如 128 * 2"}
      filtering={sheet.locked === true}
      onSearchTextChange={sheet.locked ? undefined : changeInput}
      actions={sheet.locked ? <ActionPanel>{sharedActions}</ActionPanel> : undefined}
    >
      <List.Item
        id="input"
        title={sheet.locked ? "稿纸已锁定" : composerTitle}
        icon={sheet.locked ? Icon.Lock : undefined}
        subtitle={!withinSheet ? limitMessage : activeRow?.error || activeRow?.note}
        accessories={composerValue === undefined ? [] : [{ text: { value: "= " + composerValue, color: Color.Green } }]}
        actions={
          <ActionPanel>
            {!sheet.locked && (
              <Action
                title={activeRow?.value !== undefined ? "带入下一行" : hasInput ? "保留此行" : "输入算式"}
                onAction={() => { if (hasInput && withinSheet) return finishInput(activeRow?.value); }}
              />
            )}
            {composerValue !== undefined && copyAction(composerValue)}
            {activeRow && lineActions(activeRow)}
            {sharedActions}
          </ActionPanel>
        }
      />
      <List.Section title={saveError ? "稿纸保存失败 · 请从操作菜单重试" : "稿纸"}>
        {[...rows].reverse().filter((row) => row !== activeRow).map((row) => (
          <List.Item
            key={row.line}
            id={String(row.line)}
            title={`${row.line} · ${row.formula || row.note}`}
            subtitle={row.error || (row.formula ? row.note : undefined)}
            accessories={row.value === undefined ? [] : [{ text: "= " + row.value }]}
            actions={
              <ActionPanel>
                {!sheet.locked && row.value !== undefined && <Action title="从此结果继续" onAction={() => finishInput(row.value)} />}
                {row.value !== undefined && copyAction(row.value)}
                {lineActions(row)}
                {sharedActions}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
