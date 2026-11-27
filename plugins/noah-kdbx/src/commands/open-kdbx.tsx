import { Action, ActionPanel, clearSearchBar, Clipboard, Color, confirmAlert, Detail, Form, Icon, type Keyboard, List, LocalStorage, showToast, Toast } from "@raycast/api";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { useEffect, useRef, useState } from "react";
import { runHelper, VaultError, type Attachment, type Changes, type Credentials, type CustomField, type Entry, type EntryDetails, type Field, type Management, type Vault, type Version, type WriteOperation } from "../helper";
import { authorizeCloud, clearCloudAuth, providers, type CloudAuth, type Provider } from "../cloud-oauth";
import { downloadCloud, remoteResource, uploadCloud, type CloudDrive } from "../cloud-drive";
import { downloadWebDav, RemoteConflict, uploadWebDav, webDavConnection, type CancelRegistration, type WebDav } from "../webdav";
import { matchesSearch, searchTerms } from "../search";

type RekeyValues = { name: string; master: string; confirmation: string; keyfile: string[] };
type AdvancedValues = { pattern: string; regex: boolean; protected: boolean; history: boolean };
type CloudAppValues = { clientId: string; clientSecret?: string };
type CloudValues = { remote: string; master: string; folder: string[] };
type WebDavValues = { url: string; account: string; serverSecret: string; master: string; folder: string[] };
type Session = { path: string; vault: Vault };
type RemoteBinding = { cloud: CloudDrive } | { webDav: WebDav };
type UnlockValues = { master?: string };
type RecentVault = { path: string; keyfile?: string };
type CreateValues = { master: string; confirmation: string; name: string };
type EditValues = { name: string; title: string; username: string; url: string; notes: string; otp: string; secret: string; group: string; tags: string; color: string; icon: string; iconFile: string[] };
type ManageValues = { name: string; title?: string; group?: string; parent?: string; files?: string[]; field?: string; customValue?: string; protected?: boolean };
type ManageForm = { kind: Management["kind"]; entry?: Entry; version?: Version; attachment?: Attachment; custom?: CustomField };
type Inspector = { entry: Entry; mode: "history" | "attachments" | "custom"; details: EntryDetails; version?: Version };
type ExportValues = { name: string; directory: string[] };
const managementTitles: Record<ManageForm["kind"], string> = {
  add_group: "新建分组",
  rename_group: "重命名分组",
  move_group: "移动分组",
  trash_group: "将分组移入回收站",
  restore_group: "恢复分组",
  purge_group: "永久删除分组",
  trash_entry: "移入回收站",
  restore_entry: "恢复条目",
  purge_entry: "永久删除条目",
  add_attachment: "添加附件",
  remove_attachment: "删除附件",
  set_custom: "设置自定义字段",
  remove_custom: "删除自定义字段",
  restore_history: "恢复历史字段",
  delete_history: "删除历史版本",
};
const allGroups = "";
const idleTimeout = 5 * 60_000;
const recentVaultsKey = "recent-local-vaults-v1";
const recentVaultsLimit = 12;
function commandKey(key: Keyboard.KeyEquivalent, ...modifiers: Keyboard.KeyModifier[]): Keyboard.Shortcut {
  return { modifiers: ["cmd", ...modifiers], key };
}

const backKey = commandKey("[");
const saveKey = commandKey("s");
const saveCopyKey = commandKey("s", "shift");
const moveToTrashKey = commandKey("backspace");
const deleteKey = commandKey("backspace", "shift");
const restoreKey = commandKey("r");

const fieldNames: Record<Field, string> = { username: "用户名", password: "密码", url: "网址", notes: "备注", totp: "验证码" };

function readRecentVaults(stored: string | undefined): RecentVault[] {
  const records: unknown = stored ? JSON.parse(stored) : [];
  if (!Array.isArray(records)) return [];
  const unique = new Map<string, RecentVault>();
  for (const record of records) {
    if (typeof record?.path !== "string" || !isAbsolute(record.path) || !record.path.toLowerCase().endsWith(".kdbx")
        || unique.has(record.path)) continue;
    const keyfile = typeof record.keyfile === "string" && isAbsolute(record.keyfile) ? record.keyfile : undefined;
    unique.set(record.path, { path: record.path, keyfile });
    if (unique.size === recentVaultsLimit) break;
  }
  return [...unique.values()];
}

const entryColors = [
  { title: "无颜色", value: "none" },
  { title: "红色", value: "#EF4444" },
  { title: "橙色", value: "#F97316" },
  { title: "黄色", value: "#EAB308" },
  { title: "绿色", value: "#22C55E" },
  { title: "蓝色", value: "#3B82F6" },
  { title: "紫色", value: "#A855F7" },
];

const entryIcons = [
  { value: "0", title: "钥匙", image: Icon.Key },
  { value: "1", title: "网页", image: Icon.Globe },
  { value: "3", title: "服务器", image: Icon.HardDrive },
  { value: "9", title: "身份", image: Icon.Person },
  { value: "19", title: "邮件", image: Icon.Envelope },
  { value: "36", title: "归档", image: Icon.Folder },
  { value: "48", title: "文件夹", image: Icon.Folder },
  { value: "61", title: "星标", image: Icon.Star },
];

function entryImage(entry: Entry, session: Session) {
  if (!entry.icon) return undefined;
  const image = session.vault.icons[entry.icon];
  return image ? `data:image/png;base64,${image}`
    : entryIcons.find(({ value }) => value === entry.icon)?.image ?? Icon.Image;
}

function versionTitle(version: Version) {
  const date = version.modified ? new Date(version.modified).toLocaleString() : `版本 ${version.index + 1}`;
  return [date, version.username].filter(Boolean).join(" · ");
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function tableText(value: string) {
  return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\|/g, "｜").replace(/[\\`*_<>\[\]]/g, "\\$&");
}

export default function OpenKdbx() {
  const [creating, setCreating] = useState(false);
  const [directory, setDirectory] = useState<string[]>([]);
  const [generator, setGenerator] = useState(false);
  const [secret, setSecret] = useState("");
  const [length, setLength] = useState("24");
  const [upper, setUpper] = useState(true);
  const [lower, setLower] = useState(true);
  const [digits, setDigits] = useState(true);
  const [symbols, setSymbols] = useState(true);
  const [database, setDatabase] = useState<string[]>([]);
  const [keyfile, setKeyfile] = useState<string[]>([]);
  const [recentVaults, setRecentVaults] = useState<RecentVault[]>([]);
  const [loadingRecents, setLoadingRecents] = useState(true);
  const recentVaultsRef = useRef<RecentVault[]>([]);
  const recentWrite = useRef(Promise.resolve());
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activePath, setActivePath] = useState("");
  const [selectedEntry, setSelectedEntry] = useState<string>();
  const activePathRef = useRef("");
  const [rekeying, setRekeying] = useState(false);
  const [advancedSearch, setAdvancedSearch] = useState(false);
  const [tableView, setTableView] = useState(false);
  const [advancedMatches, setAdvancedMatches] = useState<Set<string>>();
  const [openingCloud, setOpeningCloud] = useState(false);
  const [savingRemote, setSavingRemote] = useState(false);
  const [provider, setProvider] = useState<Provider>();
  const [cloudClientId, setCloudClientId] = useState("");
  const [cloudAuthorized, setCloudAuthorized] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [browsingVaults, setBrowsingVaults] = useState(false);
  const [unified, setUnified] = useState(false);
  const currentSession = sessions.find(({ path }) => path === activePath);
  const vault = currentSession?.vault;
  const [inspector, setInspector] = useState<Inspector>();
  const [preview, setPreview] = useState<{ name: string; url: string }>();
  const [exporting, setExporting] = useState<Attachment>();
  const [management, setManagement] = useState<ManageForm>();
  const [trash, setTrash] = useState(false);
  const [edit, setEdit] = useState<{ entry?: Entry; draft?: Pick<EditValues, "title" | "username" | "url" | "name" | "group" | "tags" | "color" | "icon"> }>();
  const [group, setGroup] = useState(allGroups);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const credentialsByPath = useRef(new Map<string, Credentials>());
  const webDavByPath = useRef(new Map<string, WebDav>());
  const cloudByPath = useRef(new Map<string, CloudDrive>());
  const pendingCloudAuth = useRef<CloudAuth>();
  const job = useRef<{ cancel: () => void }>();
  const expiry = useRef<ReturnType<typeof setTimeout>>();

  function activatePath(path: string, entry?: Entry) {
    activePathRef.current = path;
    setActivePath(path);
    setSelectedEntry(entry && `${path}:${entry.id}`);
  }

  function discard() {
    for (const credentials of credentialsByPath.current.values()) credentials.master = "";
    credentialsByPath.current.clear();
    for (const connection of webDavByPath.current.values()) connection.authorization = undefined;
    webDavByPath.current.clear();
    for (const connection of cloudByPath.current.values()) clearCloudAuth(connection.auth);
    cloudByPath.current.clear();
    if (pendingCloudAuth.current) clearCloudAuth(pendingCloudAuth.current);
    pendingCloudAuth.current = undefined;
    const previous = job.current;
    job.current = undefined;
    previous?.cancel();
    clearTimeout(expiry.current);
  }

  useEffect(() => discard, []);

  useEffect(() => {
    let mounted = true;
    void LocalStorage.getItem<string>(recentVaultsKey)
      .then(readRecentVaults)
      .then((saved) => {
        if (!mounted) return;
        recentVaultsRef.current = saved;
        setRecentVaults(saved);
        if (saved[0]) {
          setDatabase([saved[0].path]);
          setKeyfile(saved[0].keyfile ? [saved[0].keyfile] : []);
        }
      })
      .catch(() => {})
      .finally(() => { if (mounted) setLoadingRecents(false); });
    return () => { mounted = false; };
  }, []);

  function updateRecents(records: RecentVault[]) {
    recentVaultsRef.current = records;
    setRecentVaults(records);
    recentWrite.current = recentWrite.current
      .then(() => LocalStorage.setItem(recentVaultsKey, JSON.stringify(records)))
      .catch(() => { void showToast({ style: Toast.Style.Failure, title: "无法保存最近打开的密码库" }); });
  }

  function chooseDatabase(value: string[]) {
    if (value[0] === database[0]) return;
    const remembered = recentVaultsRef.current.find(({ path }) => path === value[0]);
    setDatabase(value);
    setKeyfile(remembered?.keyfile ? [remembered.keyfile] : []);
    setError("");
    if (adding) renew();
  }

  function lock(message = "") {
    const previous = credentialsByPath.current.get(activePathRef.current);
    if (previous) {
      setDatabase([previous.database]);
      setKeyfile(previous.keyfile ? [previous.keyfile] : []);
    }
    discard();
    setSessions([]);
    activatePath("");
    setAdding(false);
    setConnecting(false);
    setOpeningCloud(false);
    setSavingRemote(false);
    setCloudAuthorized(false);
    setAdvancedSearch(false);
    setTableView(false);
    setRekeying(false);
    setAdvancedMatches(undefined);
    setBrowsingVaults(false);
    setUnified(false);
    setEdit(undefined);
    setManagement(undefined);
    setInspector(undefined);
    setExporting(undefined);
    setPreview(undefined);
    setTrash(false);
    setSecret("");
    setGenerator(false);
    setCreating(false);
    setGroup(allGroups);
    setBusy(false);
    setQuery("");
    setError(message);
  }

  function renew() {
    clearTimeout(expiry.current);
    expiry.current = setTimeout(() => lock("密码库已自动锁定。"), idleTimeout);
  }

  function resetFilters() {
    setAdvancedMatches(undefined);
    setGroup(allGroups);
    setQuery("");
    return clearSearchBar();
  }

  function register(credentials: Credentials, vault: Vault, replaced?: string) {
    if (replaced) {
      credentialsByPath.current.delete(replaced);
      const connection = webDavByPath.current.get(replaced);
      if (connection) {
        webDavByPath.current.delete(replaced);
        webDavByPath.current.set(credentials.database, connection);
      }
    }
    if (replaced) {
      const cloud = cloudByPath.current.get(replaced);
      if (cloud) {
        cloudByPath.current.delete(replaced);
        cloudByPath.current.set(credentials.database, cloud);
      }
    }
    credentialsByPath.current.set(credentials.database, credentials);
    const session = { path: credentials.database, vault };
    setSessions((open) => [...open.filter(({ path }) => path !== replaced && path !== session.path), session]);
    activatePath(session.path);
    if (!webDavByPath.current.has(session.path) && !cloudByPath.current.has(session.path)) {
      const saved = recentVaultsRef.current;
      if (saved[0]?.path !== session.path || saved[0].keyfile !== credentials.keyfile) {
        updateRecents([
          { path: session.path, keyfile: credentials.keyfile },
          ...saved.filter(({ path }) => path !== session.path),
        ].slice(0, recentVaultsLimit));
      }
    }
  }

  function beginAdding() {
    if (job.current) return;
    setDatabase([]);
    setKeyfile([]);
    setError("");
    setAdding(true);
    setBrowsingVaults(false);
    renew();
  }

  async function openSession(path: string, entry?: Entry) {
    if (job.current || !credentialsByPath.current.has(path)) return;
    activatePath(path, entry);
    setUnified(false);
    setTrash(false);
    setBrowsingVaults(false);
    setError("");
    renew();
    await resetFilters();
  }

  async function showAll() {
    if (job.current) return;
    setUnified(true);
    setSelectedEntry(undefined);
    setTrash(false);
    setBrowsingVaults(false);
    setError("");
    renew();
    await resetFilters();
  }

  function forget(path: string, message = "") {
    const credentials = credentialsByPath.current.get(path);
    if (!credentials) return;
    if (credentialsByPath.current.size === 1) {
      lock(message);
      return;
    }
    credentials.master = "";
    credentialsByPath.current.delete(path);
    const connection = webDavByPath.current.get(path);
    if (connection) connection.authorization = undefined;
    webDavByPath.current.delete(path);
    const cloud = cloudByPath.current.get(path);
    if (cloud) clearCloudAuth(cloud.auth);
    cloudByPath.current.delete(path);
    job.current = undefined;
    setBusy(false);
    const remaining = sessions.filter((session) => session.path !== path);
    setSessions(remaining);
    if (path === activePath) {
      activatePath(remaining[0].path);
      setEdit(undefined);
      setManagement(undefined);
      setInspector(undefined);
      setExporting(undefined);
      setPreview(undefined);
      setSecret("");
      setGenerator(false);
      setTrash(false);
      void resetFilters();
    }
    if (remaining.length === 1) setUnified(false);
    if (message) void showToast({ style: Toast.Style.Failure, title: basename(path), message });
  }

  function beginWebDav(save = false) {
    if (job.current) return;
    setSavingRemote(save);
    setConnecting(true);
    setKeyfile([]);
    setError("");
    if (credentialsByPath.current.size) renew();
  }

  async function runSessionWork(work: (registerCancel: CancelRegistration, active: () => boolean) => Promise<void>) {
    if (job.current) return;
    let cancelCurrent = () => {};
    const token = { cancel: () => cancelCurrent() };
    const active = () => job.current === token;
    job.current = token;
    setBusy(true);
    setError("");
    try {
      await work((cancel) => {
        if (!active()) return false;
        cancelCurrent = cancel;
        return true;
      }, active);
    } catch (failure) {
      if (!active()) return;
      const message = failure instanceof Error ? failure.message : "操作失败。";
      setError(message);
      void showToast({ style: Toast.Style.Failure, title: message });
    } finally {
      if (active()) {
        job.current = undefined;
        setBusy(false);
      }
    }
  }

  function beginCloud(save = false) {
    if (job.current) return;
    setSavingRemote(save);
    setProvider(undefined);
    setCloudClientId("");
    setOpeningCloud(true);
    setKeyfile([]);
    setError("");
    if (credentialsByPath.current.size) renew();
  }

  function resetCloudAuthorization() {
    if (pendingCloudAuth.current) clearCloudAuth(pendingCloudAuth.current);
    pendingCloudAuth.current = undefined;
    setCloudAuthorized(false);
    setError("");
  }

  async function selectCloud(value: string) {
    if (job.current || value === provider) return;
    if (value && !Object.hasOwn(providers, value)) return;
    const selected = value ? value as Provider : undefined;
    resetCloudAuthorization();
    setProvider(selected);
    setCloudClientId("");
    setKeyfile([]);
    if (!selected) return;
    renew();
    await runSessionWork(async (track, active) => {
      const clientId = await LocalStorage.getItem<string>("cloud-oauth-client:" + selected);
      if (!active() || !clientId) return;
      setCloudClientId(clientId);
      if (selected !== "google") await signInCloud(selected, clientId, "", track, active);
    });
  }

  async function signInCloud(selected: Provider, clientId: string, clientSecret: string, track: CancelRegistration, active: () => boolean) {
    const auth: CloudAuth = { provider: selected, clientId, clientSecret, access: "", refresh: "", expiresAt: 0 };
    try {
      await authorizeCloud(auth, track, active);
      if (!active()) return;
      await LocalStorage.setItem("cloud-oauth-client:" + selected, clientId);
      if (!active()) return;
      pendingCloudAuth.current = auth;
      setCloudClientId(clientId);
      setCloudAuthorized(true);
      renew();
    } finally {
      if (pendingCloudAuth.current !== auth) clearCloudAuth(auth);
    }
  }

  async function submitCloudApp(values: CloudAppValues) {
    if (!provider || job.current) return;
    const clientId = values.clientId?.trim() ?? "";
    if (!clientId || clientId.length > 300) {
      setError("请输入服务商分配的 OAuth 客户端 ID。");
      return;
    }
    const secret = provider === "google" ? values.clientSecret ?? "" : "";
    values.clientSecret = "";
    setCloudClientId(clientId);
    await runSessionWork((track, active) => signInCloud(provider, clientId, secret, track, active));
  }

  async function connectCloud(values: CloudValues) {
    const auth = pendingCloudAuth.current;
    if (!auth || job.current) return;
    const folder = values.folder?.[0];
    const master = values.master ?? "";
    if (!folder || (!master && !keyfile[0]) || master.length > 1_024) {
      setError("请选择保存目录，并提供 KDBX 主密码或密钥文件。");
      return;
    }
    let remote: string;
    try {
      remote = remoteResource(auth.provider, values.remote ?? "");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "云端文件地址无效。");
      return;
    }
    const connection: CloudDrive = { auth, remote };
    const credentials = { database: "", keyfile: keyfile[0], master };
    values.master = "";
    await runSessionWork(async (track, active) => {
      try {
        credentials.database = await downloadCloud(connection, folder, track);
        if (!active()) return;
        const helper = runHelper(credentials, { kind: "list" });
        if (!track(helper.cancel)) { helper.cancel(); return; }
        const ready = await helper.result;
        if (!active()) return;
        connection.syncedStamp = ready.stamp;
        cloudByPath.current.set(credentials.database, connection);
        register(credentials, ready);
        pendingCloudAuth.current = undefined;
        setCloudAuthorized(false);
        setOpeningCloud(false);
        setAdding(false);
        setBrowsingVaults(false);
        setUnified(sessions.length > 0);
        setTrash(false);
        renew();
        await resetFilters();
      } finally {
        if (credentialsByPath.current.get(credentials.database) !== credentials) {
          credentials.master = "";
        }
      }
    });
  }

  async function saveToCloud(values: Pick<CloudValues, "remote">) {
    const auth = pendingCloudAuth.current;
    if (!auth || !currentSession || job.current) return;
    try {
      const connection: CloudDrive = { auth, remote: remoteResource(auth.provider, values.remote ?? "", true) };
      await publishRemote(currentSession, { cloud: connection }, () => {
        pendingCloudAuth.current = undefined;
        setCloudAuthorized(false);
        setOpeningCloud(false);
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "云端文件地址无效。");
    }
  }

  async function saveToWebDav(values: Pick<WebDavValues, "url" | "account" | "serverSecret">) {
    if (!currentSession || job.current) return;
    let connection: WebDav;
    try {
      connection = webDavConnection(values.url ?? "", values.account ?? "", values.serverSecret ?? "");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "WebDAV 地址无效。");
      return;
    }
    values.serverSecret = "";
    await publishRemote(currentSession, { webDav: connection }, () => setConnecting(false));
  }

  async function publishRemote(session: Session, binding: RemoteBinding, close: () => void) {
    const credentials = credentialsByPath.current.get(session.path);
    if (!credentials) return;
    renew();
    await runSessionWork(async (track, active) => {
      await uploadRemote(session, credentials, binding, track, active, true);
      if (!active()) return;
      const remote = "cloud" in binding ? binding.cloud : binding.webDav;
      remote.syncedStamp = session.vault.stamp;
      const previous = cloudByPath.current.get(session.path);
      if (previous) clearCloudAuth(previous.auth);
      cloudByPath.current.delete(session.path);
      webDavByPath.current.delete(session.path);
      if ("cloud" in binding) cloudByPath.current.set(session.path, binding.cloud);
      else webDavByPath.current.set(session.path, binding.webDav);
      setSavingRemote(false);
      setUnified(false);
      close();
      await showToast({ style: Toast.Style.Success, title: "已在云端创建加密密码库" });
    });
  }

  function remoteBinding(path: string): RemoteBinding | undefined {
    const cloud = cloudByPath.current.get(path);
    if (cloud) return { cloud };
    const webDav = webDavByPath.current.get(path);
    if (webDav) return { webDav };
  }

  function syncStatus(session: Session) {
    const binding = remoteBinding(session.path);
    if (!binding) return undefined;
    const remote = "cloud" in binding ? binding.cloud : binding.webDav;
    if (remote.syncState === "syncing") return { text: "同步中…", icon: { source: Icon.ArrowClockwise, tintColor: Color.Blue } };
    if (remote.syncState === "failed") return { text: "同步失败", icon: { source: Icon.ExclamationMark, tintColor: Color.Red } };
    if (remote.syncedStamp !== session.vault.stamp) return { text: "待同步", icon: { source: Icon.CircleFilled, tintColor: Color.Blue } };
    return { text: "已同步", icon: { source: Icon.CheckCircle, tintColor: Color.Green } };
  }

  async function checkUploadSource(session: Session, credentials: Credentials, track: CancelRegistration, active: () => boolean) {
    if (!active()) throw new Error("已取消上传。");
    const check = runHelper(credentials, { kind: "list" });
    if (!track(check.cancel)) { check.cancel(); throw new Error("已取消上传。"); }
    const result = await check.result;
    if (result.stamp !== session.vault.stamp) throw new VaultError("changed");
  }

  function uploadRemote(session: Session, credentials: Credentials, binding: RemoteBinding, track: CancelRegistration, active: () => boolean, create = false) {
    const verify = () => checkUploadSource(session, credentials, track, active);
    return "cloud" in binding
      ? uploadCloud(binding.cloud, session.path, track, verify, create)
      : uploadWebDav(binding.webDav, session.path, track, verify, create);
  }

  async function synchronize(session: Session, credentials: Credentials, binding: RemoteBinding, track: CancelRegistration, active: () => boolean) {
    const remote = "cloud" in binding ? binding.cloud : binding.webDav;
    remote.syncState = "syncing";
    try {
      const synced = await uploadWithMerge(session, credentials, binding, track, active);
      if (!active() || !synced) return;
      remote.syncedStamp = synced.stamp;
      remote.syncState = undefined;
      const destination = "cloud" in binding ? providers[binding.cloud.auth.provider].title : "WebDAV";
      await showToast({ style: Toast.Style.Success, title: "加密密码库已上传到 " + destination });
    } catch (failure) {
      if (active()) remote.syncState = "failed";
      throw failure;
    }
  }

  async function uploadWithMerge(session: Session, credentials: Credentials, binding: RemoteBinding, track: CancelRegistration, active: () => boolean) {
    try {
      await uploadRemote(session, credentials, binding, track, active);
      return session.vault;
    } catch (error) {
      if (!(error instanceof RemoteConflict) || !active()) throw error;
      const scratch = await mkdtemp(join(tmpdir(), "tinycast-vault-merge-"));
      try {
        const latest: RemoteBinding = "cloud" in binding ? { cloud: { ...binding.cloud } } : { webDav: { ...binding.webDav } };
        const remote = "cloud" in latest
          ? await downloadCloud(latest.cloud, scratch, track)
          : await downloadWebDav(latest.webDav, scratch, track);
        if (!active()) return;
        const merge = runHelper(credentials, {
          kind: "merge", stamp: session.vault.stamp, remote,
          name: "合并-" + randomBytes(8).toString("hex") + ".kdbx",
        });
        if (!track(merge.cancel)) { merge.cancel(); return; }
        const vault = await merge.result;
        if (!active() || !vault.database) return;
        const merged = { ...credentials, database: vault.database };
        try {
          await uploadRemote({ vault, path: merged.database }, merged, latest, track, active);
          if (!active()) return;
          if ("cloud" in binding && "cloud" in latest) Object.assign(binding.cloud, latest.cloud);
          if ("webDav" in binding && "webDav" in latest) Object.assign(binding.webDav, latest.webDav);
          register(merged, vault, session.path);
          await resetFilters();
          return vault;
        } finally {
          if (credentialsByPath.current.get(merged.database) === merged) credentials.master = "";
          else merged.master = "";
        }
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async function syncCurrent(session: Session, binding: RemoteBinding) {
    if (job.current) return;
    const credentials = credentialsByPath.current.get(session.path);
    if (!credentials) return;
    renew();
    await runSessionWork((track, active) => synchronize(session, credentials, binding, track, active));
  }

  function syncAction(session: Session) {
    const binding = remoteBinding(session.path);
    if (!binding) return undefined;
    const destination = "cloud" in binding ? providers[binding.cloud.auth.provider].title : "WebDAV";
    return <Action title={"上传到 " + destination} icon={Icon.ArrowClockwise} shortcut={saveKey} onAction={() => syncCurrent(session, binding)} />;
  }

  async function syncAfterSave(credentials: Credentials, vault: Vault) {
    const path = credentials.database;
    const binding = remoteBinding(path);
    if (!binding || !("cloud" in binding ? binding.cloud : binding.webDav).autoSync
        || credentialsByPath.current.get(path) !== credentials) return;
    await runSessionWork((track, active) => synchronize({ path, vault }, credentials, binding, track, active));
  }

  async function connectWebDav(values: WebDavValues) {
    const folder = values.folder?.[0];
    if (!folder || (!values.master && !keyfile[0]) || values.master.length > 1_024) {
      setError("请选择本地保存目录，并输入 KDBX 主密码或选择密钥文件。");
      return;
    }
    let connection: WebDav;
    try {
      connection = webDavConnection(values.url ?? "", values.account ?? "", values.serverSecret ?? "");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "WebDAV 地址无效。");
      return;
    }
    const credentials: Credentials = { database: "", master: values.master, keyfile: keyfile[0] };
    values.master = "";
    values.serverSecret = "";
    await runSessionWork(async (track, active) => {
      try {
        credentials.database = await downloadWebDav(connection, folder, track);
        if (!active()) return;
        const helper = runHelper(credentials, { kind: "list" });
        if (!track(helper.cancel)) { helper.cancel(); return; }
        const ready = await helper.result;
        if (!active()) return;
        connection.syncedStamp = ready.stamp;
        webDavByPath.current.set(credentials.database, connection);
        register(credentials, ready);
        setConnecting(false);
        setAdding(false);
        setBrowsingVaults(false);
        setUnified(sessions.length > 0);
        setTrash(false);
        renew();
        await resetFilters();
      } finally {
        if (credentialsByPath.current.get(credentials.database) !== credentials) {
          credentials.master = "";
          connection.authorization = undefined;
        }
      }
    });
  }

  async function searchAdvanced(values: AdvancedValues) {
    const pattern = values.pattern?.trim() ?? "";
    if (!pattern || [...pattern].length > 512) {
      setError("请输入 1 到 512 个字符的搜索内容。");
      return;
    }
    values.pattern = "";
    renew();
    await runSessionWork(async (track, active) => {
      const matches = new Set<string>();
      for (const session of unified ? sessions : currentSession ? [currentSession] : []) {
        const credentials = credentialsByPath.current.get(session.path);
        if (!active() || !credentials) return;
        const search = runHelper(credentials, {
          kind: "search", stamp: session.vault.stamp, pattern, regex: Boolean(values.regex),
          include_protected: Boolean(values.protected), history: Boolean(values.history), trash,
        });
        if (!track(search.cancel)) { search.cancel(); return; }
        const result = await search.result;
        for (const id of result.ids) matches.add(session.path + ":" + id);
      }
      if (!active()) return;
      await resetFilters();
      if (!active()) return;
      setAdvancedMatches(matches);
      setAdvancedSearch(false);
    });
  }

  async function rekey(values: RekeyValues) {
    const credentials = credentialsByPath.current.get(activePath);
    if (!credentials || !vault?.writable || job.current) return;
    const name = values.name?.trim();
    const keyfile = values.keyfile?.[0];
    if (!name || !name.toLowerCase().endsWith(".kdbx") || /[/:]/.test(name)) {
      setError("请输入新的 .kdbx 副本文件名。");
      return;
    }
    if ((!values.master && !keyfile) || values.master.length > 1_024 || values.master !== values.confirmation) {
      setError("请输入两次相同的主密码，或选择一个密钥文件。");
      return;
    }
    const next: Credentials = { database: "", master: values.master, keyfile };
    values.master = "";
    values.confirmation = "";
    renew();
    let saved: Vault | undefined;
    await runSessionWork(async (track, active) => {
      try {
        const pending = runHelper(credentials, { kind: "rekey", stamp: vault.stamp, name, new_master: next.master, new_keyfile: keyfile });
        if (!track(pending.cancel)) { pending.cancel(); return; }
        const result = await pending.result;
        if (!active() || !result.database) return;
        next.database = result.database;
        const previous = credentials.database;
        credentials.master = "";
        register(next, result, previous);
        saved = result;
        setRekeying(false);
        await resetFilters();
        await showToast({ style: Toast.Style.Success, title: "已保存并打开使用新凭据的密码库" });
      } finally {
        if (credentialsByPath.current.get(next.database) !== next) next.master = "";
      }
    });
    if (saved) await syncAfterSave(next, saved);
  }

  async function unlock(values: UnlockValues) {
    if (job.current) return;
    const selected = database[0];
    const master = values.master ?? "";
    if (!selected || !selected.toLowerCase().endsWith(".kdbx")) {
      setError("请选择 .kdbx 密码库文件。");
      return;
    }
    if (!master && !keyfile[0]) {
      setError("请输入主密码或选择密钥文件。");
      return;
    }
    if (master.length > 1_024) {
      setError("主密码最多支持 1,024 个字符。");
      return;
    }

    const credentials = { database: selected, keyfile: keyfile[0], master };
    values.master = "";
    setBusy(true);
    setError("");
    let task: { cancel: () => void } | undefined;
    try {
      const pending = runHelper(credentials, { kind: "list" });
      job.current = task = pending;
      const result = await pending.result;
      if (job.current !== task) return;
      // KDBX copies can share entry UUIDs. The file stamp begins with device and inode.
      const identity = result.stamp.split(":", 2).join(":");
      const previous = sessions.find(({ vault }) => vault.stamp.split(":", 2).join(":") === identity);
      const replaced = previous?.path ?? selected;
      for (const path of new Set([selected, replaced])) {
        const old = credentialsByPath.current.get(path);
        if (old) old.master = "";
      }
      register(credentials, result, replaced);
      setAdding(false);
      setTrash(false);
      setUnified(sessions.some(({ path }) => path !== replaced && path !== selected));
      renew();
      await resetFilters();
    } catch (failure) {
      if (!task || job.current === task) setError(failure instanceof VaultError ? failure.message : "无法打开密码库。");
    } finally {
      if (credentialsByPath.current.get(credentials.database) !== credentials) credentials.master = "";
      if (!task || job.current === task) {
        job.current = undefined;
        setBusy(false);
      }
    }
  }

  async function copy(entry: Entry, field: Field | { custom: string }, session = currentSession) {
    if (!session || job.current) return;
    const credentials = credentialsByPath.current.get(session.path);
    if (!credentials) return;
    renew();
    setBusy(true);
    let task: { cancel: () => void } | undefined;
    try {
      const source = { stamp: session.vault.stamp, entry: entry.id };
      const pending = runHelper(credentials, typeof field === "string"
        ? { kind: "read", ...source, field }
        : { kind: "read_custom", ...source, field: field.custom });
      job.current = task = pending;
      const { value } = await pending.result;
      if (job.current !== task) return;
      await Clipboard.copy(value, { concealed: true });
      if (job.current === task) await showToast({ style: Toast.Style.Success, title: "已复制" + (typeof field === "string" ? fieldNames[field] : "字段值") });
    } catch (failure) {
      if (task && job.current !== task) return;
      if (failure instanceof VaultError && ["changed", "database_file", "replace_conflict"].includes(failure.code)) {
        forget(session.path, failure.message);
      } else {
        await showToast({ style: Toast.Style.Failure, title: failure instanceof VaultError ? failure.message : "复制失败。" });
      }
    } finally {
      if (!task || job.current === task) {
        job.current = undefined;
        setBusy(false);
      }
    }
  }

  async function create(values: CreateValues) {
    if (job.current) return;
    const folder = directory[0];
    const name = values.name.trim();
    if (!folder || !name.toLowerCase().endsWith(".kdbx") || /[/:]/.test(name)) {
      setError("请选择保存目录，并输入 .kdbx 文件名。");
      return;
    }
    if (!values.master || values.master.length > 1_024 || values.master !== values.confirmation) {
      setError("请输入两次相同的主密码，最多 1,024 个字符。");
      return;
    }
    const credentials = { database: folder, keyfile: keyfile[0], master: values.master };
    values.master = "";
    values.confirmation = "";
    setBusy(true);
    setError("");
    let task: { cancel: () => void } | undefined;
    try {
      const creatingTask = runHelper(credentials, { kind: "create", name });
      task = creatingTask;
      job.current = task;
      const result = await creatingTask.result;
      if (job.current !== task || !result.database) return;
      credentials.database = result.database;
      register(credentials, result);
      setCreating(false);
      renew();
    } catch (failure) {
      if (!task || job.current === task) {
        setError(failure instanceof VaultError ? failure.message : "无法新建密码库。");
      }
    } finally {
      if (credentialsByPath.current.get(credentials.database) !== credentials) credentials.master = "";
      if (!task || job.current === task) {
        job.current = undefined;
        setBusy(false);
      }
    }
  }

  function generate() {
    const count = Number(length);
    if (!Number.isInteger(count) || count < 12 || count > 128) {
      setError("密码长度须为 12 到 128 个字符。");
      return;
    }
    const categories = [
      upper && "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      lower && "abcdefghijklmnopqrstuvwxyz",
      digits && "0123456789",
      symbols && "!@#$%^&*()-_=+[]{}:;,.?",
    ].filter((category): category is string => Boolean(category));
    if (!categories.length) {
      setError("请至少选择一种字符。");
      return;
    }
    const alphabet = categories.join("");
    const ceiling = 256 - (256 % alphabet.length);
    let candidate = "";
    while (candidate.length < count) {
      const bytes = randomBytes(count);
      for (const byte of bytes) {
        if (byte < ceiling) candidate += alphabet[byte % alphabet.length];
        if (candidate.length === count) break;
      }
      bytes.fill(0);
    }
    setSecret(candidate);
    setGenerator(false);
    setError("");
    renew();
  }

  function beginEdit(entry?: Entry, session = currentSession) {
    if (!session?.vault.writable || !credentialsByPath.current.has(session.path) || job.current) return;
    if (unified) void openSession(session.path, entry);
    renew();
    setError("");
    setSecret("");
    setGenerator(false);
    setEdit({ entry });
  }

  async function save(values: EditValues, replace = false) {
    const credentials = credentialsByPath.current.get(activePath);
    if (!credentials || !vault?.writable || !edit || job.current) return;
    const original = edit.entry;
    const title = values.title.trim();
    const name = values.name.trim();
    if (!title) { setError("请输入条目标题。"); return; }
    if (!replace && (!name.toLowerCase().endsWith(".kdbx") || /[/:]/.test(name))) {
      setError("请输入副本文件名，例如 工作-编辑版.kdbx。");
      return;
    }
    if ([values.title, values.username, values.url, values.notes, values.otp, values.secret ?? ""].some((value) => value.length > 2_000)) {
      setError("每个条目字段最多支持 2,000 个字符。");
      return;
    }
    const fields: Changes = {};
    if (values.title !== original?.title) fields.title = title;
    if (values.username !== original?.username) fields.username = values.username;
    if (values.url !== original?.url) fields.url = values.url;
    if (values.group && values.group !== original?.group_id) fields.group = values.group;
    const tags = values.tags ?? "";
    if (tags !== (original?.tags.join("; ") ?? "")) {
      fields.tags = [...new Set(tags.split(/[;；,，\t]/).map((tag) => tag.trim()).filter(Boolean))];
      if (fields.tags.length > 64 || fields.tags.some((tag) => [...tag].length > 128)) {
        setError("每条记录最多 64 个标签，每个标签最多 128 个字符。");
        return;
      }
    }
    const color = values.color === "none" ? "" : (values.color ?? "");
    if (color !== (original?.color ?? "")) fields.color = color;
    if (values.iconFile?.[0]) fields.icon_file = values.iconFile[0];
    else if (values.icon && values.icon !== "keep") fields.icon = values.icon;
    if (values.notes) fields.notes = values.notes;
    if (values.otp.trim()) fields.otp = values.otp.trim();
    if (values.secret) fields.password = values.secret;
    values.secret = "";
    if (!Object.keys(fields).length) {
      setError("修改至少一个字段后再保存副本。");
      return;
    }
    setEdit({ entry: original, draft: { title: values.title, username: values.username, url: values.url, name, group: values.group, tags, color: values.color, icon: values.icon } });
    await writeCopy({ kind: "save_copy", stamp: vault.stamp, name, replace, entry: original?.id, fields });
  }

  async function inspect(entry: Entry, mode: Inspector["mode"], version?: Version) {
    const credentials = credentialsByPath.current.get(activePath);
    if (!credentials || !vault || job.current) return;
    renew();
    setBusy(true);
    setError("");
    let task: { cancel: () => void } | undefined;
    try {
      const pending = runHelper(credentials, { kind: "inspect", stamp: vault.stamp, entry: entry.id, history: version?.index });
      job.current = task = pending;
      const details = await pending.result;
      if (job.current !== task) return;
      setQuery("");
      await clearSearchBar();
      if (job.current === task) setInspector({ entry, mode, details, version });
    } catch (failure) {
      reportReadFailure(failure, task, credentials);
    } finally {
      finishRead(task, credentials);
    }
  }

  async function exportAttachment(values: ExportValues) {
    const credentials = credentialsByPath.current.get(activePath);
    if (!credentials || !vault || !inspector || !exporting || job.current) return;
    const directory = values.directory?.[0];
    const name = values.name?.trim();
    if (!directory || !name || /[/:]/.test(name)) {
      setError("请选择导出目录并输入有效的文件名。");
      return;
    }
    renew();
    setBusy(true);
    setError("");
    let task: { cancel: () => void } | undefined;
    try {
      const pending = runHelper(credentials, {
        kind: "export", stamp: vault.stamp, entry: inspector.entry.id, attachment: exporting.name, history: inspector.version?.index, directory, name,
      });
      job.current = task = pending;
      await pending.result;
      if (job.current !== task) return;
      setExporting(undefined);
      await showToast({ style: Toast.Style.Success, title: "附件已导出" });
    } catch (failure) {
      reportReadFailure(failure, task, credentials);
    } finally {
      finishRead(task, credentials);
    }
  }

  async function previewAttachment(attachment: Attachment) {
    const credentials = credentialsByPath.current.get(activePath);
    if (!credentials || !vault || !inspector || job.current) return;
    renew();
    setBusy(true);
    let task: { cancel: () => void } | undefined;
    try {
      const pending = runHelper(credentials, {
        kind: "preview", stamp: vault.stamp, entry: inspector.entry.id, attachment: attachment.name, history: inspector.version?.index,
      });
      job.current = task = pending;
      const result = await pending.result;
      if (job.current === task) setPreview({ name: attachment.name, url: `data:${result.mime};base64,${result.data}` });
    } catch (failure) {
      reportReadFailure(failure, task, credentials);
    } finally {
      finishRead(task, credentials);
    }
  }

  function reportReadFailure(failure: unknown, task: { cancel: () => void } | undefined, credentials: Credentials) {
    if (credentialsByPath.current.get(credentials.database) !== credentials || job.current !== task) return;
    if (failure instanceof VaultError && ["changed", "database_file", "replace_conflict"].includes(failure.code)) {
      forget(credentials.database, failure.message);
    }
    else {
      const title = failure instanceof VaultError ? failure.message : "无法读取条目。";
      setError(title);
      void showToast({ style: Toast.Style.Failure, title });
    }
  }

  function finishRead(task: { cancel: () => void } | undefined, credentials: Credentials) {
    if (credentialsByPath.current.get(credentials.database) !== credentials || job.current !== task) return;
    job.current = undefined;
    setBusy(false);
  }

  function beginManagement(form: ManageForm) {
    if (!vault?.writable || job.current) return;
    renew();
    setError("");
    setManagement(form);
  }

  async function saveManagement(values: ManageValues, replace = false) {
    if (!vault || !management || job.current) return;
    const name = values.name.trim();
    if (!replace && (!name.toLowerCase().endsWith(".kdbx") || /[/:]/.test(name))) {
      setError("请输入有效的副本文件名。");
      return;
    }
    const { kind, entry, version, attachment, custom } = management;
    let change: Management;
    if (kind === "add_group" || kind === "rename_group") {
      const title = values.title?.trim() ?? "";
      if (!title || [...title].length > 128 || !values.group) {
        setError("请选择分组，并输入 1 到 128 个字符的名称。");
        return;
      }
      change = kind === "add_group" ? { kind, title, parent: values.group } : { kind, title, group: values.group };
    } else if (kind === "move_group") {
      if (!values.group || !values.parent) { setError("请选择分组和目标上级。"); return; }
      change = { kind, group: values.group, parent: values.parent };
    } else if (kind === "trash_group" || kind === "restore_group" || kind === "purge_group") {
      if (!values.group) { setError("请选择分组。"); return; }
      change = { kind, group: values.group };
    } else {
      if (!entry) return;
      if (kind === "add_attachment") {
        const path = values.files?.[0];
        if (!path) { setError("请选择附件文件。"); return; }
        change = { kind, entry: entry.id, path };
      } else if (kind === "remove_attachment") {
        if (!attachment) return;
        change = { kind, entry: entry.id, attachment: attachment.name };
      } else if (kind === "set_custom") {
        const field = custom?.name ?? values.field?.trim();
        const value = values.customValue ?? "";
        if (!field || [...field].length > 128 || [...value].length > 2_000) {
          setError("请输入有效的字段名称，字段值最多 2,000 个字符。");
          return;
        }
        change = { kind, entry: entry.id, field, value, protected: Boolean(values.protected), existing: Boolean(custom) };
        values.customValue = "";
      } else if (kind === "remove_custom") {
        if (!custom) return;
        change = { kind, entry: entry.id, field: custom.name };
      } else if (kind === "restore_history" || kind === "delete_history") {
        if (!version) return;
        change = { kind, entry: entry.id, index: version.index };
      } else {
        change = { kind, entry: entry.id };
      }
    }
    await writeCopy({ kind: "manage_copy", stamp: vault.stamp, name, replace, change });
  }

  async function writeCopy(operation: WriteOperation) {
    const credentials = credentialsByPath.current.get(activePath);
    if (!credentials || job.current) return;
    if (operation.replace) {
      const confirmed = await confirmAlert({
        title: "更新当前密码库？",
        message: "旧版本将作为加密备份留在同一目录。",
        primaryAction: { title: "更新并备份" },
      });
      if (!confirmed || credentialsByPath.current.get(activePath) !== credentials || job.current) return;
    }
    renew();
    setBusy(true);
    setError("");
    let saved: Vault | undefined;
    try {
      const task = runHelper(credentials, operation);
      if (operation.kind === "save_copy") {
        delete operation.fields.password;
        delete operation.fields.notes;
        delete operation.fields.otp;
        setSecret("");
      } else if (operation.change.kind === "set_custom") {
        operation.change.value = "";
      }
      job.current = task;
      const result = await task.result;
      if (job.current !== task || !result.database) return;
      const replaced = credentials.database;
      credentials.database = result.database;
      register(credentials, result, replaced);
      saved = result;
      setEdit(undefined);
      setManagement(undefined);
      setInspector(undefined);
      await resetFilters();
      await showToast({
        style: Toast.Style.Success,
        title: result.backup ? "已更新密码库并保留加密备份" : "已保存并打开加密副本",
        message: result.backup ? basename(result.backup) : undefined,
      });
    } catch (failure) {
      if (!credentialsByPath.current.has(activePath)) return;
      if (failure instanceof VaultError && ["changed", "database_file", "replace_conflict"].includes(failure.code)) {
        forget(credentials.database, failure.message);
      }
      else setError(failure instanceof VaultError ? failure.message : "无法保存密码库副本。");
    } finally {
      if (credentialsByPath.current.get(credentials.database) === credentials) {
        job.current = undefined;
        setBusy(false);
      }
    }
    if (saved) await syncAfterSave(credentials, saved);
  }

  const lockAction = <Action title={sessions.length > 1 ? "锁定所有密码库" : "锁定密码库"} icon={Icon.Lock} onAction={() => lock()} shortcut={commandKey("l")} />;
  const defaultCopy = basename(activePath || "密码库.kdbx").replace(/\.kdbx$/i, "").slice(0, 30) + "-编辑版.kdbx";

  const activeGroups = vault?.groups.filter(({ trashed, recycle_bin }) => !trashed && !recycle_bin) ?? [];
  const archivedGroups = vault?.groups.filter(({ trashed, recycle_bin }) => trashed && !recycle_bin) ?? [];

  if (vault && management) {
    const { kind, entry, version, attachment, custom } = management;
    const groupName = kind === "add_group" || kind === "rename_group";
    const groupMove = kind === "move_group" || kind === "trash_group";
    const archivedGroup = kind === "restore_group" || kind === "purge_group";
    const groupChange = groupName || groupMove || archivedGroup;
    const choices = archivedGroup ? archivedGroups : groupMove ? activeGroups.filter(({ root }) => !root) : activeGroups;
    const title = managementTitles[kind];
    const destructive = kind === "purge_entry" || kind === "purge_group" || kind === "delete_history" || kind === "remove_attachment" || kind === "remove_custom";
    const submitTitle = destructive ? "确认永久删除并保存副本" : "保存为加密副本";
    return (
      <Form key={kind} navigationTitle={title} isLoading={busy} actions={<ActionPanel>
        {!busy && <Action.SubmitForm<ManageValues> title={submitTitle} shortcut={destructive ? undefined : saveCopyKey}
          style={destructive ? Action.Style.Destructive : undefined} onSubmit={saveManagement} />}
        {!busy && <Action.SubmitForm<ManageValues> title="更新当前库并备份" shortcut={saveKey}
          style={destructive ? Action.Style.Destructive : undefined} onSubmit={(values) => saveManagement(values, true)} />}
        {lockAction}
        {!busy && <Action title="取消" shortcut={backKey} onAction={() => { setManagement(undefined); setError(""); }} />}
      </ActionPanel>}>
        {groupChange && <>
          {groupName && <Form.TextField id="title" title="分组名称" autoFocus onChange={renew} />}
          <Form.Dropdown id="group" title={kind === "add_group" ? "上级分组" : kind === "rename_group" ? "要重命名的分组" : "分组"}
            defaultValue={choices.some(({ id }) => id === group) ? group : choices[0]?.id} onChange={renew}>
            {choices.map((item) => <Form.Dropdown.Item key={item.id} value={item.id} title={item.path || "根分组"} />)}
          </Form.Dropdown>
          {kind === "move_group" && <Form.Dropdown id="parent" title="目标上级分组" defaultValue={activeGroups[0]?.id} onChange={renew}>
            {activeGroups.map((item) => <Form.Dropdown.Item key={item.id} value={item.id} title={item.path || "根分组"} />)}
          </Form.Dropdown>}
        </>}
        {entry && <Form.Description title="条目" text={entry.title || "未命名条目"} />}
        {custom && <Form.Description title="字段" text={custom.name} />}
        {kind === "set_custom" && <>
          {!custom && <Form.TextField id="field" title="字段名称" autoFocus onChange={renew} />}
          <Form.PasswordField id="customValue" title="字段值" storeValue={false} defaultValue={custom?.value ?? ""} onChange={renew} />
          <Form.Checkbox id="protected" label="保护字段值" defaultValue={custom?.protected ?? true} onChange={renew} />
        </>}
        {attachment && <Form.Description title="附件" text={attachment.name} />}
        {version && <Form.Description title="历史版本" text={versionTitle(version)} />}
        {kind === "add_attachment" && <Form.FilePicker id="files" title="附件文件" allowMultipleSelection={false} onChange={renew} />}
        {kind === "restore_history" && <Form.Description text="恢复字段、标签、附件和图标，当前版本会保留。条目留在当前分组。" />}
        <Form.TextField id="name" title="副本文件名" defaultValue={defaultCopy} onChange={renew} />
        <Form.Description text={destructive
          ? (kind === "remove_attachment" ? "附件将从当前版本移除，历史版本仍可访问。" : "选中的记录将从新副本中永久删除，原库保留。")
          : "更改保存在同目录的加密副本中。"} />
        {error && <Form.Description title="状态" text={error} />}
      </Form>
    );
  }

  if (vault && preview) {
    return <Detail navigationTitle={preview.name} markdown={`![附件预览](${preview.url})`}
      actions={<ActionPanel>
        <Action title="返回附件" shortcut={backKey} onAction={() => { setPreview(undefined); renew(); }} />
        {lockAction}
      </ActionPanel>} />;
  }

  if (vault && inspector && exporting) {
    return (
      <Form key="export-attachment" navigationTitle="导出附件" isLoading={busy} actions={<ActionPanel>
        {!busy && <Action.SubmitForm<ExportValues> title="导出文件" shortcut={saveCopyKey} onSubmit={exportAttachment} />}
        {lockAction}
        {!busy && <Action title="返回附件" shortcut={backKey} onAction={() => { setExporting(undefined); setError(""); }} />}
      </ActionPanel>}>
        <Form.FilePicker id="directory" title="导出目录" canChooseDirectories canChooseFiles={false}
          allowMultipleSelection={false} onChange={renew} />
        <Form.TextField id="name" title="导出文件名" defaultValue={exporting.name.replace(/[/:]/g, "_")} onChange={renew} />
        <Form.Description text="附件将作为普通文件写入所选目录。" />
        {error && <Form.Description title="状态" text={error} />}
      </Form>
    );
  }

  if (vault && inspector?.mode === "custom") {
    const { entry, details } = inspector;
    const back = <Action title="返回条目" shortcut={backKey} onAction={() => { setInspector(undefined); renew(); }} />;
    const add = vault.writable && <Action title="添加自定义字段" shortcut={commandKey("n")} onAction={() => beginManagement({ kind: "set_custom", entry })} />;
    return <List key="custom-fields" navigationTitle="自定义字段" searchBarPlaceholder="搜索字段名称" isLoading={busy}
      actions={<ActionPanel>{add}{back}{lockAction}</ActionPanel>}>
      <List.EmptyView title="条目没有自定义字段" />
      {details.custom.map((custom) => (<List.Item key={custom.name} title={custom.name}
        subtitle={custom.protected ? "受保护" : custom.value ?? ""}
        actions={<ActionPanel>
          <Action title="复制字段值" shortcut={commandKey("c")} onAction={() => copy(entry, { custom: custom.name })} />
          {vault.writable && <Action title="编辑字段" shortcut={commandKey("e")} onAction={() => beginManagement({ kind: "set_custom", entry, custom })} />}
          {vault.writable && <Action title="删除字段" shortcut={deleteKey} style={Action.Style.Destructive}
            onAction={() => beginManagement({ kind: "remove_custom", entry, custom })} />}
          {add}{back}{lockAction}
        </ActionPanel>} />
      ))}
    </List>;
  }

  if (vault && inspector) {
    const { entry, mode, details, version: archived } = inspector;
    const back = <Action title="返回条目" shortcut={backKey} onAction={() => setInspector(undefined)} />;
    const add = vault.writable && !archived && (
      <Action title="添加附件" shortcut={commandKey("n")} icon={Icon.Plus} onAction={() => beginManagement({ kind: "add_attachment", entry })} />
    );
    return (
      <List key={mode} navigationTitle={mode === "history" ? "条目历史" : archived ? "历史版本附件" : "条目附件"}
        searchBarPlaceholder={mode === "history" ? "搜索历史版本" : "搜索附件"}
        isLoading={busy}
        actions={<ActionPanel>{mode === "attachments" && add}{back}{lockAction}</ActionPanel>}>
        <List.EmptyView title={mode === "history" ? "暂无历史版本" : "条目没有附件"} />
        {mode === "history" ? details.versions.map((version) => (
          <List.Item key={version.index} title={version.title || "未命名历史版本"} subtitle={versionTitle(version)}
            actions={<ActionPanel>
              {version.has_attachments && <Action title="查看历史附件" shortcut={commandKey("j", "shift")} onAction={() => inspect(entry, "attachments", version)} />}
              {vault.writable && <Action title="恢复历史字段" shortcut={restoreKey} onAction={() => beginManagement({ kind: "restore_history", entry, version })} />}
              {vault.writable && <Action title="删除历史版本" shortcut={deleteKey} style={Action.Style.Destructive}
                onAction={() => beginManagement({ kind: "delete_history", entry, version })} />}
              {back}{lockAction}
            </ActionPanel>} />
        )) : details.attachments.map((attachment) => (
          <List.Item key={attachment.name} title={attachment.name} subtitle={formatSize(attachment.size)}
            actions={<ActionPanel>
              {/\.(png|jpe?g)$/i.test(attachment.name) && <Action title="预览图片" shortcut={commandKey("p")} onAction={() => previewAttachment(attachment)} />}
              <Action title="导出附件" shortcut={commandKey("s", "shift")} onAction={() => { setError(""); setExporting(attachment); }} />
              {vault.writable && !archived && <Action title="删除附件" shortcut={deleteKey} style={Action.Style.Destructive}
                onAction={() => beginManagement({ kind: "remove_attachment", entry, attachment })} />}
              {archived && <Action title="返回历史版本" shortcut={backKey} onAction={() => inspect(entry, "history")} />}
              {add}{back}{lockAction}
            </ActionPanel>} />
        ))}
      </List>
    );
  }

  if (vault && edit) {
    const entry = edit.entry;
    const draft = edit.draft;
    const existingColor = entry?.color;
    const options = existingColor && !entryColors.some(({ value }) => value === existingColor)
      ? [...entryColors, { title: existingColor, value: existingColor }]
      : entryColors;
    return (
      <Form
        navigationTitle={entry ? "编辑条目" : "新建条目"}
        isLoading={busy}
        actions={<ActionPanel>
          {!busy && <Action.SubmitForm<EditValues> title="保存为加密副本" shortcut={saveCopyKey} onSubmit={save} />}
          {!busy && <Action.SubmitForm<EditValues> title="更新当前库并备份" shortcut={saveKey} onSubmit={(values) => save(values, true)} />}
          {lockAction}
          {!busy && <Action title={generator ? "生成并填入密码" : "密码生成器"} shortcut={commandKey("g")} onAction={() => {
            if (generator) generate();
            else setGenerator(true);
          }} />}
          {!busy && <Action title="取消编辑" shortcut={backKey} onAction={() => { setEdit(undefined); setSecret(""); setGenerator(false); setError(""); }} />}
        </ActionPanel>}
      >
        {busy ? <Form.Description title="正在保存" text="正在写入加密 KDBX 副本…" /> : <>
          <Form.TextField id="title" title="标题" defaultValue={draft?.title ?? entry?.title ?? ""} onChange={renew} autoFocus />
          <Form.TextField id="username" title="用户名" defaultValue={draft?.username ?? entry?.username ?? ""} onChange={renew} />
          <Form.TextField id="url" title="网址" defaultValue={draft?.url ?? entry?.url ?? ""} onChange={renew} />
          <Form.Dropdown id="group" title="分组" defaultValue={draft?.group || entry?.group_id || group || activeGroups[0]?.id} onChange={renew}>
            {activeGroups.map((item) => <Form.Dropdown.Item key={item.id} value={item.id} title={item.path || "根分组"} />)}
          </Form.Dropdown>
          <Form.TextField id="tags" title="标签" defaultValue={draft?.tags ?? entry?.tags.join("; ") ?? ""} placeholder="工作; 常用" onChange={renew} />
          <Form.Dropdown id="color" title="颜色" defaultValue={draft?.color || existingColor || "none"} onChange={renew}>
            {options.map(({ title, value }) => <Form.Dropdown.Item key={value} title={title} value={value} />)}
          </Form.Dropdown>
          <Form.Dropdown id="icon" title="图标" defaultValue={draft?.icon || "keep"} onChange={renew}>
            <Form.Dropdown.Item value="keep" title="保持当前图标" />
            <Form.Dropdown.Item value="none" title="清除图标" />
            {entryIcons.map(({ title, value, image }) => <Form.Dropdown.Item key={value} title={title} value={value} icon={image} />)}
          </Form.Dropdown>
          <Form.FilePicker id="iconFile" title="自定义图标文件（可选）" allowMultipleSelection={false} onChange={renew} />
          <Form.PasswordField id="secret" title={entry ? "新密码（留空保留原密码）" : "密码"} storeValue={false} value={secret}
            onChange={(value) => { setSecret(value); renew(); }} />
          {generator && <>
            <Form.TextField id="length" title="密码长度" value={length} onChange={setLength} />
            <Form.Checkbox id="upper" label="包含大写字母" value={upper} onChange={setUpper} />
            <Form.Checkbox id="lower" label="包含小写字母" value={lower} onChange={setLower} />
            <Form.Checkbox id="digits" label="包含数字" value={digits} onChange={setDigits} />
            <Form.Checkbox id="symbols" label="包含符号" value={symbols} onChange={setSymbols} />
          </>}
          <Form.PasswordField id="otp" title="TOTP 链接（选填）" placeholder="otpauth://totp/…" storeValue={false} onChange={renew} />
          <Form.TextArea id="notes" title={entry ? "新备注（留空保留原备注）" : "备注"} storeValue={false} onChange={renew} />
          <Form.TextField id="name" title="副本文件名" defaultValue={draft?.name ?? defaultCopy} onChange={renew} />
          <Form.Description text="标签以分号分隔。副本保存在原库所在目录。" />
          {error && <Form.Description title="状态" text={error} />}
        </>}
      </Form>
    );
  }

  if (vault && rekeying) {
    return <Form key="rekey" navigationTitle="更改主密码或密钥" isLoading={busy} actions={<ActionPanel>
      {!busy && <Action.SubmitForm<RekeyValues> title="使用新凭据保存副本" shortcut={saveCopyKey} onSubmit={rekey} />}
      {!busy && <Action title="取消" shortcut={backKey} onAction={() => { setRekeying(false); setError(""); }} />}
      {lockAction}
    </ActionPanel>}>
      {busy ? <Form.Description title="正在加密" text="正在写入新的 KDBX 文件…" /> : <>
        <Form.PasswordField id="master" title="新主密码" autoFocus storeValue={false} onChange={renew} />
        <Form.PasswordField id="confirmation" title="确认新主密码" storeValue={false} onChange={renew} />
        <Form.FilePicker id="keyfile" title="新密钥文件（可选）" allowMultipleSelection={false} onChange={renew} />
        <Form.TextField id="name" title="副本文件名" defaultValue={defaultCopy} onChange={renew} />
        <Form.Description text="新库仅使用本页填写的凭据。原库保留现有凭据。" />
        {error && <Form.Description title="状态" text={error} />}
      </>}
    </Form>;
  }

  if (vault && advancedSearch) {
    return <Form key="advanced-search" navigationTitle="高级搜索" isLoading={busy} actions={<ActionPanel>
      {!busy && <Action.SubmitForm<AdvancedValues> title="搜索" onSubmit={searchAdvanced} />}
      {!busy && <Action title="返回条目" shortcut={backKey} onAction={() => { setAdvancedSearch(false); setError(""); }} />}
      {lockAction}
    </ActionPanel>}>
      {busy ? <Form.Description title="正在搜索" text="正在逐库匹配条目…" /> : <>
        <Form.PasswordField id="pattern" title="搜索内容" autoFocus storeValue={false} onChange={renew} />
        <Form.Checkbox id="regex" label="使用正则表达式" onChange={renew} />
        <Form.Checkbox id="protected" label="匹配密码和其他受保护字段" onChange={renew} />
        <Form.Checkbox id="history" label="匹配历史版本" onChange={renew} />
        {error && <Form.Description title="状态" text={error} />}
      </>}
    </Form>;
  }

  const cloudAction = <Action title="打开云端密码库" shortcut={commandKey("o", "shift")} icon={Icon.Cloud} onAction={() => beginCloud()} />;
  if (openingCloud) {
    return (
      <Form key="oauth-cloud" navigationTitle={savingRemote ? "另存到云端" : "打开云端密码库"} isLoading={busy} actions={<ActionPanel>
        {!busy && provider && (cloudAuthorized
          ? savingRemote
            ? <Action.SubmitForm<CloudValues> title="创建远端密码库" onSubmit={saveToCloud} />
            : <Action.SubmitForm<CloudValues> title="下载并解锁" onSubmit={connectCloud} />
          : <Action.SubmitForm<CloudAppValues> title="在浏览器中授权" onSubmit={submitCloudApp} />)}
        {!busy && cloudAuthorized && <Action title="更改 OAuth 客户端 ID" shortcut={commandKey("i", "shift")} onAction={resetCloudAuthorization} />}
        {!busy && <Action title="取消" shortcut={backKey} onAction={() => { resetCloudAuthorization(); setOpeningCloud(false); }} />}
        {vault && lockAction}
      </ActionPanel>}>
        <Form.Dropdown id="provider" title="服务商" value={provider ?? ""} onChange={selectCloud}>
          <Form.Dropdown.Item value="" title="请选择服务商" />
          {Object.entries(providers).map(([id, settings]) => <Form.Dropdown.Item key={id} value={id} title={settings.title} />)}
        </Form.Dropdown>
        {busy && <Form.Description text={cloudAuthorized
          ? savingRemote ? "正在上传加密密码库…" : "正在下载并解锁密码库…"
          : "请在系统浏览器窗口完成授权。"} />}
        {provider && !cloudAuthorized && !busy && <>
          <Form.TextField key={provider} id="clientId" title="OAuth 客户端 ID" storeValue={false} autoFocus
            value={cloudClientId} onChange={(value) => { setCloudClientId(value); renew(); }} />
          {!cloudClientId && <Form.Description text={provider === "onedrive"
            ? "首次使用 OneDrive，请输入 Microsoft Entra 应用注册中的应用程序（客户端）ID，再选择「在浏览器中授权」。"
            : "首次使用此服务，请输入 OAuth 应用客户端 ID，再选择「在浏览器中授权」。"} />}
          {provider === "google" && <Form.PasswordField id="clientSecret" title="桌面客户端密钥（如需）" storeValue={false} onChange={renew} />}
        </>}
        {cloudAuthorized && <>
          <Form.Description title="云端账号" text={"已授权 " + (provider ? providers[provider].title : "")} />
          <Form.TextField key={provider} id="remote"
            title={provider === "google" ? savingRemote ? "新密码库文件名" : "Google Drive 文件 ID 或链接" : "远端 .kdbx 路径"}
            placeholder={provider === "teams" ? "/团队 ID/密码库.kdbx" : provider === "google" ? undefined : "/Vault.kdbx"}
            defaultValue={savingRemote && provider === "google" ? basename(activePath) : undefined}
            storeValue={false} onChange={renew} />
          {!savingRemote && <>
            <Form.FilePicker id="folder" title="本地保存目录" canChooseDirectories canChooseFiles={false}
              allowMultipleSelection={false} onChange={renew} />
            <Form.PasswordField id="master" title="KDBX 主密码" storeValue={false} onChange={renew} />
            <Form.FilePicker id="keyfile" title="密钥文件（可选）" allowMultipleSelection={false} value={keyfile} onChange={setKeyfile} />
          </>}
        </>}
        {error && <Form.Description title="状态" text={error} />}
      </Form>
    );
  }

  const webDavAction = <Action title="打开 WebDAV 密码库" shortcut={commandKey("o", "opt")} icon={Icon.Globe} onAction={() => beginWebDav()} />;
  if (connecting) {
    return (
      <Form key="webdav" navigationTitle={savingRemote ? "另存到 WebDAV" : "打开 WebDAV 密码库"} isLoading={busy} actions={<ActionPanel>
        {!busy && (savingRemote
          ? <Action.SubmitForm<WebDavValues> title="创建远端密码库" onSubmit={saveToWebDav} />
          : <Action.SubmitForm<WebDavValues> title="下载并解锁" onSubmit={connectWebDav} />)}
        {!busy && <Action title="取消" shortcut={backKey} onAction={() => { setConnecting(false); setError(""); }} />}
        {vault && lockAction}
      </ActionPanel>}>
        {busy ? <Form.Description text={savingRemote ? "正在上传加密密码库…" : "正在下载并解锁加密文件…"} /> : <>
          <Form.TextField id="url" title="HTTPS 文件地址" storeValue={false} onChange={renew} autoFocus />
          <Form.TextField id="account" title="WebDAV 用户名" storeValue={false} onChange={renew} />
          <Form.PasswordField id="serverSecret" title="WebDAV 密码" storeValue={false} onChange={renew} />
          {!savingRemote && <>
            <Form.FilePicker id="folder" title="本地保存目录" canChooseDirectories canChooseFiles={false}
              allowMultipleSelection={false} onChange={renew} />
            <Form.PasswordField id="master" title="KDBX 主密码" storeValue={false} onChange={renew} />
            <Form.FilePicker id="keyfile" title="密钥文件（可选）" allowMultipleSelection={false} value={keyfile} onChange={setKeyfile} />
          </>}
          {error && <Form.Description title="状态" text={error} />}
        </>}
      </Form>
    );
  }

  if (creating) {
    return (
      <Form key="create" navigationTitle="新建 KDBX 密码库" isLoading={busy} actions={busy ? undefined : (
        <ActionPanel>
          <Action.SubmitForm<CreateValues> title="创建加密密码库" icon={Icon.Plus} onSubmit={create} />
          <Action title="返回打开密码库" shortcut={backKey} onAction={() => { setCreating(false); setKeyfile([]); setError(""); }} />
        </ActionPanel>
      )}>
        {busy ? <Form.Description title="正在创建" text="正在加密 KDBX 文件…" /> : <>
          <Form.FilePicker id="directory" title="保存目录" canChooseDirectories canChooseFiles={false}
            allowMultipleSelection={false} value={directory} onChange={setDirectory} />
          <Form.TextField id="name" title="文件名" defaultValue="密码库.kdbx" />
          <Form.PasswordField id="master" title="主密码" storeValue={false} />
          <Form.PasswordField id="confirmation" title="确认主密码" storeValue={false} />
          <Form.FilePicker id="keyfile" title="密钥文件（可选）" allowMultipleSelection={false} value={keyfile} onChange={setKeyfile} />
          {error && <Form.Description title="状态" text={error} />}
        </>}
      </Form>
    );
  }

  if (!vault || adding) {
    if (loadingRecents) return <Detail navigationTitle="打开 KDBX 密码库" markdown="" isLoading />;
    const rememberedPath = recentVaults.find(({ path }) => path === database[0])?.path;
    return (
      <Form
        key={adding ? "unlock-another" : "unlock"}
        navigationTitle={adding ? "打开另一密码库" : "打开 KDBX 密码库"}
        isLoading={busy}
        actions={<ActionPanel>
          {!busy && <Action.SubmitForm<UnlockValues> title="解锁" icon={Icon.LockUnlocked} onSubmit={unlock} />}
          {!busy && !adding && <>{cloudAction}{webDavAction}</>}
          {!busy && rememberedPath && <Action title="从最近打开移除" shortcut={moveToTrashKey} onAction={() => {
            updateRecents(recentVaultsRef.current.filter(({ path }) => path !== rememberedPath));
            chooseDatabase([]);
          }} />}
          {adding ? <>
            {!busy && <Action title="返回密码库" shortcut={backKey} onAction={() => { setAdding(false); setError(""); }} />}
            {lockAction}
          </> : !busy && <Action title="新建密码库" shortcut={commandKey("n")} icon={Icon.Plus} onAction={() => { setCreating(true); setKeyfile([]); setError(""); }} />}
        </ActionPanel>}
      >
        {busy ? <Form.Description title="正在解锁" text="正在读取本地 KDBX 文件…" /> : <>
          {recentVaults.length > 0 && <Form.Dropdown id="recentVault" title="最近打开" value={rememberedPath ?? ""} onChange={(path) => {
            chooseDatabase(path ? [path] : []);
          }}>
            <Form.Dropdown.Item value="" title="选择其他文件" />
            {recentVaults.map(({ path }) => <Form.Dropdown.Item key={path} value={path}
              title={recentVaults.some((other) => other.path !== path && basename(other.path) === basename(path))
                ? `${basename(path)} · ${dirname(path)}` : basename(path)} />)}
          </Form.Dropdown>}
          <Form.FilePicker id="database" title="密码库" allowMultipleSelection={false} value={database} onChange={chooseDatabase} />
          <Form.FilePicker id="keyfile" title="密钥文件（可选）" allowMultipleSelection={false} value={keyfile} onChange={setKeyfile} />
          <Form.PasswordField key={database[0]} id="master" title="主密码" storeValue={false} autoFocus={Boolean(database[0])}
            onChange={adding ? renew : undefined} />
          {error && <Form.Description title="状态" text={error} />}
        </>}
      </Form>
    );
  }

  const anotherVaultAction = <Action title="打开另一密码库" icon={Icon.Folder} shortcut={commandKey("o")} onAction={beginAdding} />;
  if (browsingVaults) {
    const back = <Action title="返回条目" shortcut={backKey} onAction={async () => {
      if (job.current) return;
      renew();
      await resetFilters();
      setBrowsingVaults(false);
    }} />;
    return (
      <List key="vaults" navigationTitle="已解锁的密码库" searchBarPlaceholder="搜索密码库" isLoading={busy}
        actions={<ActionPanel>{anotherVaultAction}{back}{lockAction}</ActionPanel>}>
        {sessions.length > 1 && <List.Item title="所有密码库" accessories={[{ text: String(sessions.length) }]}
          actions={<ActionPanel><Action title="统一搜索" shortcut={commandKey("a", "shift")} onAction={showAll} />{anotherVaultAction}{back}{lockAction}</ActionPanel>} />}
        {sessions.map((session) => {
          const { path } = session;
          const status = syncStatus(session);
          return <List.Item key={path} title={basename(path)} subtitle={dirname(path)}
            accessories={[...(status ? [status] : []), ...(path === activePath && !unified ? [{ text: "当前" }] : [])]}
            actions={<ActionPanel>
              <Action title="查看此密码库" shortcut={commandKey("v", "shift")} onAction={() => openSession(path)} />
              {syncAction(session)}
              <Action title="锁定此密码库" shortcut={commandKey("l", "opt")} icon={Icon.Lock} onAction={() => { if (!job.current) forget(path); }} />
              {anotherVaultAction}{back}{lockAction}
            </ActionPanel>} />;
        })}
      </List>
    );
  }

  function toggleTrash() {
    setTrash(!trash);
    setAdvancedMatches(undefined);
    setGroup(allGroups);
    setQuery("");
    renew();
    void clearSearchBar();
  }
  const newAction = vault.writable && !trash && !unified && <Action title="新建条目" icon={Icon.Plus} shortcut={commandKey("n")} onAction={() => beginEdit()} />;
  const groups = activeGroups;
  const binding = unified ? undefined : remoteBinding(activePath);
  const remote = binding && ("cloud" in binding ? binding.cloud : binding.webDav);
  const status = currentSession && !unified ? syncStatus(currentSession) : undefined;
  const statusSuffix = status ? " · " + status.text : "";
  const vaultActions = <>
    {newAction}
    {vault.writable && !trash && !unified && <Action title="更改主密码或密钥" shortcut={commandKey("p", "shift")} icon={Icon.Key} onAction={() => {
      if (job.current) return;
      renew();
      setError("");
      setRekeying(true);
    }} />}
    {vault.writable && !trash && !unified && <Action title="新建分组" shortcut={commandKey("n", "shift")} icon={Icon.Folder} onAction={() => beginManagement({ kind: "add_group" })} />}
    {vault.writable && !trash && !unified && <Action title="重命名分组" shortcut={commandKey("e", "shift")} icon={Icon.Pencil} onAction={() => beginManagement({ kind: "rename_group" })} />}
    {vault.writable && !trash && !unified && groups.length > 1 && <>
      <Action title="移动分组" shortcut={commandKey("m", "shift")} onAction={() => beginManagement({ kind: "move_group" })} />
      <Action title="将分组移入回收站" shortcut={commandKey("backspace", "opt")} onAction={() => beginManagement({ kind: "trash_group" })} />
    </>}
    {vault.writable && trash && archivedGroups.length > 0 && <>
      <Action title="恢复分组" shortcut={commandKey("r", "opt")} onAction={() => beginManagement({ kind: "restore_group" })} />
      <Action title="永久删除分组" shortcut={commandKey("backspace", "opt", "shift")} style={Action.Style.Destructive} onAction={() => beginManagement({ kind: "purge_group" })} />
    </>}
    {!unified && <Action title={trash ? "返回密码库" : "打开回收站"} shortcut={commandKey("t", "shift")} icon={Icon.Trash} onAction={toggleTrash} />}
    <Action title="高级搜索" shortcut={commandKey("f", "shift")} icon={Icon.MagnifyingGlass} onAction={() => {
      if (job.current) return;
      setError("");
      setAdvancedSearch(true);
      renew();
    }} />
    {advancedMatches && <Action title="清除高级筛选" shortcut={commandKey("f", "opt")} onAction={() => setAdvancedMatches(undefined)} />}
    <Action title="查看表格" shortcut={commandKey("t", "opt")} onAction={() => { if (!job.current) { renew(); setTableView(true); } }} />
    {anotherVaultAction}{cloudAction}{webDavAction}
    {!unified && <>
      <Action title="另存到云端" shortcut={commandKey("s", "opt", "shift")} onAction={() => beginCloud(true)} />
      <Action title="另存到 WebDAV" shortcut={commandKey("s", "opt")} onAction={() => beginWebDav(true)} />
    </>}
    {binding && remote && <>
      {currentSession && syncAction(currentSession)}
      <Action title={remote.autoSync ? "关闭保存后自动同步" : "开启保存后自动同步"} onAction={() => {
        if (job.current) return;
        remote.autoSync = !remote.autoSync;
        setSessions((open) => [...open]);
        renew();
      }} shortcut={commandKey("y", "shift")} />
    </>}
    {sessions.length > 1 && !unified && <Action title="搜索所有密码库" shortcut={commandKey("a", "shift")} icon={Icon.MagnifyingGlass} onAction={showAll} />}
    {sessions.length > 1 && <Action title="已解锁的密码库" shortcut={commandKey("l", "shift")} icon={Icon.List} onAction={async () => {
      if (job.current) return;
      renew();
      await resetFilters();
      setBrowsingVaults(true);
    }} />}
    {lockAction}
  </>;
  const terms = searchTerms(query);
  const entries = (unified ? sessions : sessions.filter(({ path }) => path === activePath)).flatMap((session) =>
    session.vault.entries.filter((entry) => {
      if (trash !== entry.trashed || (group && group !== entry.group_id)) return false;
      if (advancedMatches && !advancedMatches.has(session.path + ":" + entry.id)) return false;
      if (!terms.length) return true;
      return matchesSearch({
        title: entry.title, user: entry.username, url: entry.url, group: entry.group,
        tag: entry.tags.join("\n"), vault: basename(session.path),
        color: entry.color ? `${entry.color} ${entryColors.find(({ value }) => value === entry.color)?.title ?? ""}` : "",
      }, terms);
    }).map((entry) => ({ entry, session })),
  ).sort((a, b) => a.entry.title.localeCompare(b.entry.title) || a.session.path.localeCompare(b.session.path));

  if (tableView) {
    const rows = entries.slice(0, 150).map(({ entry, session }) => {
      const columns = [entry.title || "未命名条目", entry.username, entry.group];
      if (unified) columns.push(basename(session.path));
      return "| " + columns.map(tableText).join(" | ") + " |";
    });
    const table = [
      unified ? "| 标题 | 用户名 | 分组 | 密码库 |" : "| 标题 | 用户名 | 分组 |",
      unified ? "| --- | --- | --- | --- |" : "| --- | --- | --- |",
      ...rows,
      ...(entries.length > rows.length ? ["", `显示前 ${rows.length} 条，共 ${entries.length} 条匹配。`] : []),
    ].join("\n");
    return <Detail key="vault-table" navigationTitle={"条目表格" + statusSuffix} isLoading={busy}
      markdown={rows.length ? table : "没有匹配的条目。"}
      actions={<ActionPanel>
        <Action title="返回列表" shortcut={backKey} onAction={() => { renew(); setTableView(false); }} />
        {!unified && currentSession && syncAction(currentSession)}
        {lockAction}
      </ActionPanel>} />;
  }

  return (
    <List
      key={unified ? "unified" : activePath}
      navigationTitle={(advancedMatches ? "高级搜索结果" : unified ? "所有密码库" : trash ? "回收站" : basename(activePath)) + statusSuffix}
      selectedItemId={selectedEntry}
      searchBarPlaceholder={unified ? "跨库搜索标题、用户名、网址、标签或库名称" : "搜索标题、用户名、网址、标签或分组"}
      searchText={query}
      filtering={false}
      searchBarAccessory={!unified && !trash && groups.length > 1 ? (
        <List.Dropdown tooltip="按分组筛选" value={group} onChange={(value) => { setGroup(value); renew(); }}>
          <List.Dropdown.Item title="全部分组" value={allGroups} />
          {groups.map((item) => <List.Dropdown.Item key={item.id} title={item.path || "根分组"} value={item.id} />)}
        </List.Dropdown>
      ) : undefined}
      onSearchTextChange={(text) => { setQuery(text); renew(); }}
      isLoading={busy}
      isShowingDetail={entries.length > 0}
      actions={<ActionPanel>{vaultActions}</ActionPanel>}
    >
      <List.EmptyView title={terms.length || group || advancedMatches ? "没有匹配的条目" : trash ? "回收站为空" : "密码库中没有可显示的条目"} />
      {entries.slice(0, 150).map(({ entry, session }) => {
        const ownerStatus = unified ? syncStatus(session) : undefined;
        return (
          <List.Item
            key={session.path + ":" + entry.id}
            id={session.path + ":" + entry.id}
            icon={entryImage(entry, session)}
            title={entry.title.trim() || "未命名条目"}
            subtitle={unified ? basename(session.path) : entry.username || entry.group}
            accessories={[
              ...(unified ? [{ text: basename(session.path) }] : []),
              ...(ownerStatus ? [ownerStatus] : []),
              ...(entry.color ? [{ tag: { color: entry.color, value: entryColors.find(({ value }) => value === entry.color)?.title ?? entry.color } }] : []),
            ]}
            detail={<List.Item.Detail metadata={<List.Item.Detail.Metadata>
              {unified && <List.Item.Detail.Metadata.Label title="密码库" text={session.path} />}
              <List.Item.Detail.Metadata.Label title="用户名" text={entry.username || "—"} />
              <List.Item.Detail.Metadata.Label title="网址" text={entry.url || "—"} />
              {entry.tags.length > 0 && <List.Item.Detail.Metadata.Label title="标签" text={entry.tags.join(" · ")} />}
              <List.Item.Detail.Metadata.Label title="分组" text={entry.group || "—"} />
            </List.Item.Detail.Metadata>} />}
            actions={<ActionPanel>
              {trash ? <>
                {vault.writable && <Action title="恢复条目" shortcut={restoreKey} onAction={() => beginManagement({ kind: "restore_entry", entry })} />}
                {vault.writable && <Action title="永久删除条目" shortcut={deleteKey} style={Action.Style.Destructive} onAction={() => beginManagement({ kind: "purge_entry", entry })} />}
              </> : <>
                {entry.has_secret && <Action title="复制密码" shortcut={commandKey("c")} icon={Icon.Clipboard} onAction={() => copy(entry, "password", session)} />}
                {entry.username && <Action title="复制用户名" shortcut={commandKey("b")} icon={Icon.Clipboard} onAction={() => copy(entry, "username", session)} />}
                {entry.url && <Action title="复制网址" shortcut={commandKey("u")} icon={Icon.Clipboard} onAction={() => copy(entry, "url", session)} />}
                {entry.has_totp && <Action title="复制 TOTP 验证码" shortcut={{ modifiers: ["opt"], key: "2" }} icon={Icon.Clipboard} onAction={() => copy(entry, "totp", session)} />}
                {entry.has_notes && <Action title="复制备注" shortcut={commandKey("c", "shift")} icon={Icon.Clipboard} onAction={() => copy(entry, "notes", session)} />}
                {unified && <Action title="在所属密码库中查看" shortcut={commandKey("v", "shift")} onAction={() => openSession(session.path, entry)} />}
                {!unified && <Action title="自定义字段" shortcut={commandKey("d", "shift")} onAction={() => inspect(entry, "custom")} />}
                {!unified && entry.has_history && <Action title="查看条目历史" shortcut={commandKey("h", "shift")} onAction={() => inspect(entry, "history")} />}
                {!unified && (vault.writable || entry.has_attachments) && <Action title="管理附件" shortcut={commandKey("j", "shift")} onAction={() => inspect(entry, "attachments")} />}
                {session.vault.writable && <Action title="编辑条目" icon={Icon.Pencil} shortcut={commandKey("e")} onAction={() => beginEdit(entry, session)} />}
                {!unified && vault.writable && <Action title="移入回收站" shortcut={moveToTrashKey} icon={Icon.Trash} onAction={() => beginManagement({ kind: "trash_entry", entry })} />}
              </>}
              {unified && syncAction(session)}
              {vaultActions}
            </ActionPanel>}
          />
        );
      })}
      {entries.length > 150 && <List.Item title={"显示前 150 条 · 共 " + entries.length + " 条匹配"} subtitle="缩小搜索范围可定位其他条目" actions={<ActionPanel>{vaultActions}</ActionPanel>} />}
    </List>
  );
}
