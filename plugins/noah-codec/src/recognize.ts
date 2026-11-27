import { decodeBase64, decodeUtf8 } from "./base64";
import { decodeHTMLStrict } from "entities";
import { decodeUnicode, timestampResults } from "./text";

export type Suggestion = { tool: string; title: string };

export function recognizeInput(input: string): Suggestion[] {
  const text = input.trim();
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(text)) {
    return [{ tool: "image-base64", title: "Base64 转图片" }];
  }
  if (!text || text.length > 65_536) return [];

  const results: Suggestion[] = [];
  if (/%[\da-f]{2}/i.test(text)) {
    try {
      decodeURIComponent(text);
      results.push({ tool: "url-conversion", title: "URL 解码" });
    } catch {
      // Keep invalid or partially typed values available through manual tool search.
    }
  }
  if (text.includes("&") && decodeHTMLStrict(text) !== text) {
    results.push({ tool: "unicode-html", title: "Unicode 与 HTML 实体解码" });
  } else if (/^(?:U\+|\\[ux])/i.test(text)) {
    try {
      if (decodeUnicode(text) !== undefined) results.push({ tool: "unicode-html", title: "Unicode 解码" });
    } catch {
      // Invalid byte escapes or Unicode code points are not suggestions.
    }
  }
  if (/^[+-]?0(?:x[\da-f]+|b[01]+|o[0-7]+)$/i.test(text)) {
    results.push({ tool: "number-base", title: "进制转换" });
  }
  if (/^(?:[+-]?(?:\d{10}|\d{13}|\d+\s*m?s)|\d{4}-\d{2}-\d{2}(?:[T ]\d.*)?)$/i.test(text)) {
    try {
      timestampResults(text);
      results.push({ tool: "timestamp", title: "时间戳转换" });
    } catch {
      // Pattern recognition does not make an invalid date valid.
    }
  }
  if (/[a-z+/=_-]/i.test(text) && text.length >= 4 && /^[a-z\d+/_=\s-]+$/i.test(text)) {
    try {
      const decoded = decodeUtf8(decodeBase64(text));
      if (decoded.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(decoded)) {
        results.push({ tool: "base64-text", title: "Base64 解码" });
      }
    } catch {
      // The values are suggestions, so invalid encodings simply do not appear.
    }
  }
  return results;
}
