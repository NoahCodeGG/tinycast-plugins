import { environment, OAuth } from "@raycast/api";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { CancelRegistration } from "./webdav";

export const providers = {
  dropbox: {
    title: "Dropbox", host: "localhost", port: 53682,
    authorize: "https://www.dropbox.com/oauth2/authorize", token: "https://api.dropboxapi.com/oauth2/token",
    scope: "files.content.read files.content.write", extra: { token_access_type: "offline" },
  },
  google: {
    title: "Google Drive", host: "127.0.0.1", port: 0,
    authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/drive", extra: { access_type: "offline" },
  },
  onedrive: {
    title: "OneDrive", host: "localhost", port: 0,
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access Files.ReadWrite", extra: {},
  },
  teams: {
    title: "Microsoft Teams", host: "localhost", port: 0,
    authorize: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
    scope: "offline_access Files.ReadWrite.All", extra: {},
  },
};

export type Provider = keyof typeof providers;
export type CloudAuth = {
  provider: Provider;
  clientId: string;
  clientSecret: string;
  access: string;
  refresh: string;
  expiresAt: number;
};

function startRelay(port: number, state: string, track: CancelRegistration) {
  const helper = join(environment.assetsPath, "kdbx-helper", "tinycast-kdbx");
  const child = spawn(helper, ["--oauth-loopback"], { stdio: ["pipe", "pipe", "pipe"], timeout: 182_000 });
  const close = () => { child.kill(); };
  return {
    close,
    ready: new Promise<number>((resolve, reject) => {
      let line = "";
      const failed = () => reject(new Error("无法启动本机 OAuth 回调，请检查端口占用后重试。"));
      child.stderr.resume();
      child.on("error", failed);
      child.stdin.on("error", failed);
      child.on("close", failed);
      child.stdout.on("data", (chunk) => {
        line += chunk.toString("ascii");
        if (line.includes("\n")) {
          const number = Number(line.trim());
          if (Number.isInteger(number) && number > 0 && number <= 65535) resolve(number);
          else failed();
        }
      });
      if (track(close)) child.stdin.end(JSON.stringify({ port, state }));
      else { close(); failed(); }
    }),
  };
}

async function exchange(auth: CloudAuth, parameters: Record<string, string>) {
  const body = new URLSearchParams({ ...parameters, client_id: auth.clientId });
  if (auth.clientSecret) body.set("client_secret", auth.clientSecret);
  const response = await fetch(providers[auth.provider].token, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(),
  });
  if (!response.ok) throw new Error("OAuth 令牌交换失败，请检查应用注册和授权。");
  const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!token.access_token || !/^[a-zA-Z0-9_~+./=-]+$/.test(token.access_token)) throw new Error("服务商未返回有效的访问令牌。");
  auth.access = token.access_token;
  auth.refresh = token.refresh_token ?? auth.refresh;
  auth.expiresAt = typeof token.expires_in === "number" && token.expires_in > 0 ? Date.now() + token.expires_in * 1000 : 0;
}

export async function authorizeCloud(auth: CloudAuth, track: CancelRegistration, active: () => boolean) {
  const options = providers[auth.provider];
  const state = randomBytes(24).toString("base64url");
  const relay = startRelay(options.port, state, track);
  try {
    const port = await relay.ready;
    if (!active()) throw new Error("授权已取消。");
    const redirectUri = `http://${options.host}:${port}/oauth/callback`;
    const client = new OAuth.PKCEClient({
      providerName: options.title, providerId: "noah-kdbx-" + auth.provider,
      redirectMethod: OAuth.RedirectMethod.App,
    });
    const request = await client.authorizationRequest({
      endpoint: options.authorize, clientId: auth.clientId, scope: options.scope,
      extraParameters: { ...options.extra, state, redirect_uri: redirectUri },
    });
    if (!active()) throw new Error("授权已取消。");
    const authorization = await client.authorize(request);
    if (!active()) throw new Error("授权已取消。");
    await exchange(auth, {
      grant_type: "authorization_code", code: authorization.authorizationCode,
      code_verifier: request.codeVerifier, redirect_uri: redirectUri,
    });
  } finally {
    relay.close();
  }
}

export async function authorizationHeader(auth: CloudAuth) {
  if (auth.expiresAt && Date.now() + 30_000 >= auth.expiresAt) {
    if (!auth.refresh) throw new Error("云端授权已过期，请重新打开云端库。");
    await exchange(auth, { grant_type: "refresh_token", refresh_token: auth.refresh });
  }
  if (!auth.access) throw new Error("云端授权不可用。");
  return "Bearer " + auth.access;
}

export function clearCloudAuth(auth: CloudAuth) {
  auth.access = "";
  auth.refresh = "";
  auth.clientSecret = "";
}
