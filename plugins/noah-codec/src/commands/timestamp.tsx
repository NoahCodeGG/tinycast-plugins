import { Action, ActionPanel, Icon, List, LocalStorage, Toast, showToast, useNavigation } from "@raycast/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { timestampResults } from "../text";
import { normalizeTimeZone, readTimeZones, timeZoneMatches, timeZoneTitle } from "../time-zones";
import { TextTool } from "../ui";

const storageKey = "timestamp.extra-time-zones";

function TimeZones({ initial, onChange }: { initial: string[]; onChange: (zones: string[]) => void }) {
  const { pop } = useNavigation();
  const [zones, setZones] = useState(initial);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const writing = useRef(false);
  const matches = useMemo(() => timeZoneMatches(query), [query]);
  const selected = query.trim() ? zones.filter((id) => matches.includes(id) || id.toLowerCase().includes(query.trim().toLowerCase())) : zones;
  const available = matches.filter((id) => !zones.includes(id));

  async function update(zone: string, add: boolean) {
    if (writing.current) return;
    const id = normalizeTimeZone(zone);
    if (!id) return;
    writing.current = true;
    setSaving(true);
    try {
      const next = add ? [...new Set([...zones, id])] : zones.filter((existing) => existing !== id);
      await LocalStorage.setItem(storageKey, JSON.stringify(next));
      setZones(next);
      onChange(next);
    } catch {
      await showToast({ style: Toast.Style.Failure, title: "保存时区失败" });
    } finally {
      writing.current = false;
      setSaving(false);
    }
  }

  const done = <Action title="完成" shortcut={{ modifiers: ["cmd"], key: "t" }} onAction={pop} />;

  function row(id: string, added: boolean) {
    return (
      <List.Item
        key={id}
        id={id}
        title={timeZoneTitle(id)}
        subtitle={timeZoneTitle(id) === id ? undefined : id}
        icon={added ? Icon.CheckCircle : Icon.Globe}
        actions={<ActionPanel>
          <Action title={added ? "移除时区" : "添加时区"} onAction={() => update(id, !added)} />
          {done}
        </ActionPanel>}
      />
    );
  }

  return (
    <List
      navigationTitle="其他时区"
      searchBarPlaceholder="搜索城市、IANA 时区或 UTC+05:30"
      filtering={false}
      onSearchTextChange={setQuery}
      isLoading={saving}
      actions={<ActionPanel>{done}</ActionPanel>}
    >
      <List.EmptyView title="未找到时区" description="试试纽约、America/New_York 或 UTC+05:30。" />
      {selected.length > 0 && <List.Section title="已添加">{selected.map((id) => row(id, true))}</List.Section>}
      {available.length > 0 && <List.Section title="可添加">{available.map((id) => row(id, false))}</List.Section>}
    </List>
  );
}

export default function Timestamp() {
  const [zones, setZones] = useState<string[] | null>();
  const [readAttempt, setReadAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void LocalStorage.getItem(storageKey).then(
      (value) => { if (active) setZones(readTimeZones(value)); },
      () => { if (active) setZones(null); },
    );
    return () => { active = false; };
  }, [readAttempt]);
  const calculate = useCallback((text: string) => timestampResults(text, zones ?? undefined), [zones]);

  return <TextTool
    title="时间戳转换"
    placeholder="如 1700000000s、2024-01-01 08:00:00，留空取当前时间"
    calculate={calculate}
    allowEmpty
    refreshEmpty
    extraActions={zones === null ? <Action title="重试读取时区设置" onAction={() => setReadAttempt((n) => n + 1)} /> : zones && <Action.Push
      title="其他时区"
      icon={Icon.Globe}
      shortcut={{ modifiers: ["cmd"], key: "t" }}
      target={<TimeZones initial={zones} onChange={setZones} />}
    />}
  />;
}
