import { radixResults } from "../text";
import { TextTool } from "../ui";

export default function NumberBase() {
  return <TextTool title="进制转换" placeholder={'如 42、0b101010、0o52 或 0x2A'} calculate={radixResults} />;
}
