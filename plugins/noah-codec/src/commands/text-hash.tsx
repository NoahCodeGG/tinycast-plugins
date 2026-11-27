import { textHashes } from "../files";
import { TextTool } from "../ui";

export default function TextHash() {
  return <TextTool title="文本哈希" placeholder={'输入 UTF-8 文本，留空计算空字符串的哈希'} calculate={textHashes} allowEmpty />;
}
