import { unicodeResults } from "../text";
import { TextTool } from "../ui";

export default function UnicodeHtml() {
  return <TextTool title="Unicode 与 HTML 实体" placeholder={'如 你好、U+1F600、\\u4F60、\\xE4\\xBD\\xA0 或 &amp;'} calculate={unicodeResults} />;
}
