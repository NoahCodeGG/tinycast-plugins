import { Action, ActionPanel, Alert, confirmAlert, Icon, List, showToast, Toast, useNavigation } from "@raycast/api";
import { randomUUID } from "node:crypto";
import { useEffect, useRef, useState } from "react";
import { loadSheets, removeSheet, sheetTitle, type Sheet } from "../sheets";
import { Workspace } from "../workspace";

function blankSheet(): Sheet {
  return { id: randomUUID(), title: "", body: "", modified: Date.now() };
}

type DeleteSheets = (target: Sheet[], all?: boolean) => Promise<ReadonlySet<string>>;

function SheetList({ initial, onOpen, onNew, onDelete }: {
  initial: Sheet[];
  onOpen: (sheet: Sheet) => void;
  onNew: () => void;
  onDelete: DeleteSheets;
}) {
  const [sheets, setSheets] = useState(initial);
  const { pop } = useNavigation();

  async function remove(target: Sheet[], all = false) {
    const deleted = await onDelete(target, all);
    setSheets((current) => current.filter(({ id }) => !deleted.has(id)));
  }

  const newSheet = <Action title="新建稿纸" icon={Icon.Plus} shortcut={{ modifiers: ["cmd"], key: "n" }} onAction={() => {
    onNew();
    pop();
  }} />;
  const removeAll = sheets.length > 0 && (
    <Action title="删除所有稿纸" icon={Icon.Trash} style={Action.Style.Destructive} onAction={() => remove(sheets, true)} />
  );

  return (
    <List
      navigationTitle="稿纸列表"
      searchBarPlaceholder="搜索稿纸名称"
      actions={<ActionPanel>{newSheet}{removeAll}</ActionPanel>}
    >
      <List.EmptyView title={sheets.length ? "没有匹配的稿纸" : "还没有保存的稿纸"} />
      {sheets.map((sheet) => (
        <List.Item
          key={sheet.id}
          id={sheet.id}
          title={sheetTitle(sheet)}
          subtitle={sheet.body.split(/\r\n|\n|\r/).find((line) => line.trim())?.slice(0, 80)}
          accessories={sheet.locked ? [{ icon: Icon.Lock, tooltip: "已锁定" }] : []}
          actions={
            <ActionPanel>
              <Action title="打开稿纸" onAction={() => { onOpen(sheet); pop(); }} />
              {newSheet}
              <ActionPanel.Section>
                <Action title="删除此稿纸" icon={Icon.Trash} style={Action.Style.Destructive} onAction={() => remove([sheet])} />
                {removeAll}
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

export default function CalculationPad() {
  const sheets = useRef<Sheet[]>([]);
  const deleting = useRef(false);
  const [active, setActive] = useState<Sheet>();
  const [loadError, setLoadError] = useState(false);
  const { push } = useNavigation();

  async function reload() {
    setLoadError(false);
    try {
      sheets.current = (await loadSheets()).sort((a, b) => b.modified - a.modified);
      setActive(sheets.current[0] ?? blankSheet());
    } catch {
      setLoadError(true);
    }
  }

  useEffect(() => { void reload(); }, []);

  function upsert(sheet: Sheet) {
    sheets.current = [sheet, ...sheets.current.filter(({ id }) => id !== sheet.id)];
  }

  function create() {
    setActive(blankSheet());
  }

  async function deleteSheets(target: Sheet[], all = false) {
    const deleted = new Set<string>();
    if (deleting.current || !target.length) return deleted;
    deleting.current = true;
    try {
      const confirmed = await confirmAlert({
        title: all ? "删除所有稿纸？" : `删除「${sheetTitle(target[0])}」？`,
        message: all ? `将永久删除 ${target.length} 张稿纸，包括已锁定的稿纸。` : "算式和备注将永久删除。",
        primaryAction: { title: all ? "全部删除" : "删除", style: Alert.ActionStyle.Destructive },
        dismissAction: { title: "取消" },
      });
      if (!confirmed) return deleted;

      const results = await Promise.allSettled(target.map(({ id }) => removeSheet(id)));
      results.forEach((result, index) => {
        if (result.status === "fulfilled") deleted.add(target[index].id);
      });
      sheets.current = sheets.current.filter(({ id }) => !deleted.has(id));
      setActive((current) => current && deleted.has(current.id) ? sheets.current[0] ?? blankSheet() : current);
      if (deleted.size !== target.length) {
        await showToast({ style: Toast.Style.Failure, title: `有 ${target.length - deleted.size} 张稿纸删除失败` });
      }
      return deleted;
    } finally {
      deleting.current = false;
    }
  }

  function browse() {
    push(<SheetList initial={sheets.current} onOpen={setActive} onNew={create}
      onDelete={deleteSheets} />);
  }

  if (!active) {
    return (
      <List
        isLoading={!loadError}
        actions={loadError ? <ActionPanel><Action title="重新加载" onAction={reload} /></ActionPanel> : undefined}
      >
        <List.EmptyView title={loadError ? "无法读取稿纸" : "正在读取稿纸"} />
      </List>
    );
  }

  return (
    <Workspace
      key={active.id}
      initial={active}
      onChange={upsert}
      onNew={create}
      onBrowse={browse}
      onDelete={(sheet) => deleteSheets([sheet])}
    />
  );
}
