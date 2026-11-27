import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { parseColor, toHex, type Swatch } from "./color";

export type AISettings = { baseUrl: string; model: string; imageModel: string; apiKey: string };

export function getEndpoint(baseUrl: string, path: string) {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error("请输入有效的 API 地址，如 https://example.com/v1。");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("请使用 HTTPS API 地址。本机服务可使用 HTTP。");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") + path;
  return url;
}

function post(settings: AISettings, path: string, value: object, maxBytes: number, timeout: number): Promise<unknown> {
  const url = getEndpoint(settings.baseUrl, path);
  const body = JSON.stringify(value);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        req.destroy();
        reject(new Error(`请求失败（HTTP ${res.statusCode ?? "未知"}）。`));
        return;
      }
      const data: Uint8Array[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error("接口响应超过大小限制。"));
          return;
        }
        data.push(Uint8Array.from(chunk));
      });
      res.on("error", () => reject(new Error("接口连接中断。")));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(data).toString("utf8")));
        } catch {
          reject(new Error("接口未返回有效 JSON。"));
        }
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("等待模型响应超时。"));
    }, timeout);
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => reject(new Error("无法连接 API，请检查地址和网络连接。")));
    req.end(body);
  });
}

function readText(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, limit) : "";
}

async function chat(settings: AISettings, instruction: string, input: object) {
  if (!settings.model.trim()) throw new Error("请填写配色模型名称。");
  const response = await post(settings, "/chat/completions", {
    model: settings.model.trim(),
    messages: [
      { role: "system", content: instruction },
      { role: "user", content: JSON.stringify(input) },
    ],
  }, 256 * 1024, 45_000) as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = response?.choices?.[0]?.message?.content;
  try {
    if (typeof content === "string") return JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ""));
  } catch {
    // A provider may ignore the output instructions.
  }
  throw new Error("模型未按要求返回 JSON，请重试或更换模型。");
}

export async function aiPalette(settings: AISettings, input: { base: string; style: string; tone: string; count: number; prompt: string }) {
  const result = await chat(settings,
    "你是配色设计师。根据用户提供的主色、风格、冷暖和说明，返回 JSON 对象 {title, colors:[{name,hex}]}。colors 数量等于 count，包含指定主色，HEX 统一使用 #RRGGBB。用中文命名，不要输出 Markdown。", input);
  const colors: Swatch[] = Array.isArray(result?.colors) ? result.colors.slice(0, input.count).flatMap((row: unknown) => {
    if (!row || typeof row !== "object" || !("hex" in row) || typeof row.hex !== "string" || !/^#[a-f\d]{6}$/i.test(row.hex)) return [];
    const hex = row.hex.toUpperCase();
    return [{ name: readText("name" in row ? row.name : undefined, 50) || hex, hex }];
  }) : [];
  if (colors.length !== input.count || new Set(colors.map(({ hex }) => hex)).size !== input.count) {
    throw new Error("模型返回的颜色数量有误或存在重复值，请重试。");
  }
  if (!colors.some(({ hex }) => hex === input.base)) {
    colors[0] = { name: "主色", hex: input.base };
  }
  return { title: readText(result?.title, 60) || "AI 配色", colors };
}

export async function aiName(settings: AISettings, colors: Swatch[], prompt: string) {
  const result = await chat(settings,
    "根据色板和描述给色卡取一个简短的中文名称，只返回 JSON {title}。", { colors, prompt });
  const title = readText(result?.title, 60);
  if (!title) throw new Error("模型未返回有效的色卡名称。");
  return title;
}

export async function aiImage(settings: AISettings, colors: Swatch[], title: string, prompt: string) {
  if (!settings.imageModel.trim()) throw new Error("请填写支持返回 PNG Base64 的图像模型。");
  const hex = colors.map(({ hex }) => parseColor(hex)).filter((value) => value !== undefined).map(toHex).join("、");
  const result = await post(settings, "/images/generations", {
    model: settings.imageModel.trim(),
    n: 1,
    prompt: `生成一张竖版配色灵感卡，主题：${prompt || title}。主画面应使用以下颜色：${hex}。标题为「${title}」。请保留底部干净区域用于色块叠加。`,
  }, 18 * 1024 * 1024, 110_000) as { data?: { b64_json?: unknown }[] } | null;
  const png = result?.data?.[0]?.b64_json;
  if (typeof png !== "string") throw new Error("图像接口未返回 PNG Base64。");
  const buffer = Buffer.from(png, "base64");
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) throw new Error("图像接口返回的图片格式不是 PNG。");
  return buffer;
}
