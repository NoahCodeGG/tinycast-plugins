import { base64Results } from "../text";
import { TextTool } from "../ui";

export default function Base64Text() {
  return <TextTool title="Base64 文本转换" placeholder={'输入文本、Base64 或 Base64URL'} calculate={base64Results} />;
}
