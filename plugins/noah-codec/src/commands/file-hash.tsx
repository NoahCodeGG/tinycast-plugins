import { Form } from "@raycast/api";
import { basename } from "node:path";
import { fileHashes } from "../files";
import { OperationForm, Results } from "../ui";

export default function FileHash() {
  return (
    <OperationForm<{ files: string[] }>
      title="文件哈希"
      action="计算哈希"
      status="正在读取文件并计算哈希…"
      run={async ({ files }) => {
        if (!files[0]) throw new Error("请选择要计算哈希的文件。");
        return <Results title={basename(files[0])} rows={await fileHashes(files[0])} />;
      }}
    >
      <Form.FilePicker id="files" title="文件" allowMultipleSelection={false} />
    </OperationForm>
  );
}
