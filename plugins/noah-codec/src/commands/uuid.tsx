import { Action, ActionPanel, List } from "@raycast/api";
import { randomUUID } from "node:crypto";
import { useState } from "react";
import { CopyResult } from "../ui";

export default function Uuid() {
  const [uuid, setUuid] = useState(() => randomUUID().toLowerCase());
  return (
    <List navigationTitle="生成 UUID">
      <List.Item
        title={uuid}
        subtitle="UUID v4"
        actions={
          <ActionPanel>
            <CopyResult title="复制 UUID" value={uuid} />
            <Action title="重新生成" onAction={() => setUuid(randomUUID().toLowerCase())} />
          </ActionPanel>
        }
      />
    </List>
  );
}
