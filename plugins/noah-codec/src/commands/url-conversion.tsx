import { urlResults } from "../text";
import { TextTool } from "../ui";

export default function UrlConversion() {
  return <TextTool title="URL 编解码" placeholder={'输入 URL 组成部分，如查询参数值'} calculate={urlResults} />;
}
