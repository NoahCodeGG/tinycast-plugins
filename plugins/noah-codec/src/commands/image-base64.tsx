import { Action, ActionPanel, Form, List } from "@raycast/api";
import { basename } from "node:path";
import { useContext } from "react";
import { ConversionInput } from "../conversion-input";
import { encodeImage, saveImage } from "../image";
import { OperationForm, Results, useTextInput } from "../ui";

function EncodeImage() {
  return (
    <OperationForm<{ files: string[] }>
      title="图片转 Base64"
      action="转换图片"
      status="正在读取图片…"
      run={async ({ files }) => {
        if (!files[0]) throw new Error("请选择图片文件。");
        const { data, uri } = await encodeImage(files[0]);
        return <Results title={basename(files[0])} rows={[
          { label: "Base64", value: data },
          { label: "Data URI", value: uri },
        ]} />;
      }}
    >
      <Form.FilePicker id="files" title="图片" allowMultipleSelection={false} />
      <Form.Description text="支持 PNG、JPEG、GIF、WebP、BMP 和 TIFF，最大 8 MiB。" />
    </OperationForm>
  );
}

function DecodeImage({ initial }: { initial?: string }) {
  const text = useTextInput(initial);
  return (
    <OperationForm<{ input: string; folders: string[] }>
      title="Base64 转图片"
      action="保存图片"
      status="正在保存图片…"
      extraActions={text.pasteAction}
      run={async ({ input, folders }) => {
        if (!input.trim()) throw new Error("请输入 Base64 或图片 Data URI。");
        if (!folders[0]) throw new Error("请选择保存目录。");
        const path = await saveImage(input, folders[0]);
        return (
          <List navigationTitle="图片已保存">
            <List.Item
              title={basename(path)}
              subtitle={path}
              actions={
                <ActionPanel>
                  <Action.ShowInFinder title="在 Finder 中显示" path={path} />
                  <Action.CopyToClipboard title="复制文件路径" content={path} />
                </ActionPanel>
              }
            />
          </List>
        );
      }}
    >
      <Form.TextArea id="input" title="Base64" placeholder="粘贴原始 Base64 或图片 Data URI" {...text.field} />
      <Form.FilePicker id="folders" title="保存目录" allowMultipleSelection={false} canChooseDirectories canChooseFiles={false} />
    </OperationForm>
  );
}

export default function ImageBase64() {
  const recognized = useContext(ConversionInput);
  if (recognized) return <DecodeImage initial={recognized.text} />;
  return (
    <List navigationTitle="图片 Base64 转换">
      <List.Item title="图片转 Base64" actions={<ActionPanel><Action.Push title="选择图片" target={<EncodeImage />} /></ActionPanel>} />
      <List.Item title="Base64 转图片" actions={<ActionPanel><Action.Push title="输入 Base64" target={<DecodeImage />} /></ActionPanel>} />
    </List>
  );
}
