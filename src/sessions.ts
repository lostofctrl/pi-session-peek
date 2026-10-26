import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sanitizeText } from "./ansi.ts";
import { normPath } from "./text.ts";

// 读 ~/.pi/agent/sessions 下的会话 JSONL，按 mtime 缓存；重命名和删除也在这里。
// 搜索不预存小写全文：会话正文只在 msgs 里放一份，匹配时用不区分大小写的正则直接扫（见 query.ts 的 matchesSession）

export interface PeekTool {
  name: string;
  summary: string; // 主参数（命令 / 路径 / URL…）压成一行，预览里显示用
}

export interface PeekMsg {
  role: "user" | "assistant";
  text: string; // 只发了工具调用、没写字的 AI 轮次为空串
  tools?: PeekTool[]; // 这条消息里的工具调用，没有就不带这个键。不进搜索索引
}

/** 会话收尾状态：done = 最后一轮 AI 已经答完（settled），aborted = 被中断或报错。
 * 还在跑（末条 assistant 的 stopReason 是 toolUse）或最后一句是用户 / 工具结果的，都不给状态 */
export type PeekStatus = "done" | "aborted";

export interface PeekSession {
  path: string;
  cwd: string;
  time: string;
  name: string; // 最后一条 session_info 里的名字，没有则为空
  first: string; // 首条消息，列表里显示用
  msgs: PeekMsg[];
  mtime: number;
  size: number; // 和 mtime 一起当缓存键：mtime 粒度粗的文件系统上连续两次写入可能同一个 mtime
  pending?: boolean; // 懒加载占位：文件已列出但还没解析，除了 path / mtime / size 都还是空
  pinned?: boolean; // pi-web 的 /pin 状态（最后一条 pi-web:pin 记录）；没写过就是 undefined
  lastPrompt?: number; // 最后一条 user 消息的时间（毫秒），排序用；没有用户消息就没有这个键
  status?: PeekStatus; // 末轮收尾状态，见 PeekStatus
  draft?: boolean; // pi-web 的草稿：有 draft-session 记录且之后 AI 没答过（或老式的 "Draft: " 名字且从没答过）
}

/** 只 stat 过的会话文件，按 mtime 倒序。不读内容，/peek 先用它把列表画出来 */
export interface SessionFile {
  path: string;
  mtime: number;
  size: number;
}

/** 列表项占位：立刻能排序、能画，解析完由 PeekComponent.mergeLoaded 原地填上 */
export function pendingSession(f: SessionFile): PeekSession {
  return {
    path: f.path,
    cwd: "",
    time: new Date(f.mtime).toISOString(),
    name: "",
    first: "",
    msgs: [],
    mtime: f.mtime,
    size: f.size,
    pending: true,
  };
}

const sessionCache = new Map<string, { mtime: number; size: number; session: PeekSession | null }>();
const READ_CONCURRENCY = 16; // 同时读的文件数，太高会把 libuv 线程池排满

const expandTilde = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

// 默认布局下所有项目的会话根目录：和 pi 一样认 PI_CODING_AGENT_DIR，下面每个 cwd 一个子目录
export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const agent = env.PI_CODING_AGENT_DIR ? expandTilde(env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
  return join(agent, "sessions");
}

/** 要扫描的根目录。pi 的 getSessionDir() 是参数、环境变量、settings.json 合并后的结果：
 * 默认布局时它是 <root>/sessions/<按 cwd 编码的子目录>，取上一级才能看到所有项目；
 * 用户自定义了目录（--session-dir 等）时就是那个目录本身，直接扫它 */
export function scanRoot(currentSessionDir: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const root = sessionsDir(env);
  if (!currentSessionDir) return root;
  return normPath(dirname(currentSessionDir)) === normPath(root) ? root : currentSessionDir;
}

async function walkJsonl(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkJsonl(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return sanitizeText(content);
  if (!Array.isArray(content)) return "";
  return sanitizeText(
    content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n"),
  );
}

// 工具调用的主参数：按常见键名找第一个字符串，都没有就取第一个字符串参数。不存结果，bash 输出动辄几十 KB
const TOOL_ARG_KEYS = ["command", "path", "url", "query", "pattern", "file_path"];
const TOOL_SUMMARY_MAX = 120;

export function toolSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const o = args as Record<string, unknown>;
  let v = TOOL_ARG_KEYS.map((k) => o[k]).find((x) => typeof x === "string" && x.trim());
  if (typeof v !== "string") v = Object.values(o).find((x) => typeof x === "string" && (x as string).trim());
  if (typeof v !== "string") return "";
  return sanitizeText(v).replace(/\s+/g, " ").trim().slice(0, TOOL_SUMMARY_MAX);
}

function extractTools(content: unknown): PeekTool[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c: any) => c?.type === "toolCall" && typeof c.name === "string")
    .map((c: any) => ({ name: c.name, summary: toolSummary(c.arguments) }));
}

/** 列表排序方式：最近提问（末条用户消息）或创建时间（会话头） */
export type SortMode = "prompt" | "created";

/** 排序 / 列表里显示的“时间”（毫秒）：创建时间看会话头，最近提问看末条用户消息，都没有就退到最后修改 */
export function sessionStamp(s: PeekSession, mode: SortMode): number {
  if (mode === "created") {
    const t = Date.parse(s.time);
    return Number.isNaN(t) ? s.mtime : t;
  }
  return s.lastPrompt ?? s.mtime;
}

/** 按时间倒序排，同一时刻再按 mtime 倒序，保证顺序稳定 */
export function sortSessions(list: readonly PeekSession[], mode: SortMode): PeekSession[] {
  const stamps = new Map<PeekSession, number>();
  for (const s of list) stamps.set(s, sessionStamp(s, mode));
  return [...list].sort((a, b) => stamps.get(b)! - stamps.get(a)! || b.mtime - a.mtime);
}

function parseSession(path: string, raw: string, mtime: number, size: number): PeekSession | null {
  let cwd = "";
  let time = "";
  let name = "";
  let pinned: boolean | undefined;
  const msgs: PeekMsg[] = [];
  let lastPrompt: number | undefined;
  let draftMarker = false;
  let assistantAfterDraft = false;
  let anyAssistant = false;
  // 末条消息的角色和它后面是否又来了新消息：状态只看最后一轮有没有答完
  let tailRole: "user" | "assistant" | "toolResult" | undefined;
  let tailStop: string | undefined;

  // Avoid allocating an array of every JSONL line, including large ignored tool results.
  let start = 0;
  while (start < raw.length) {
    const end = raw.indexOf("\n", start);
    const line = raw.slice(start, end === -1 ? raw.length : end);
    start = end === -1 ? raw.length : end + 1;
    if (!line) continue;
    try {
      if (line.includes('"type":"session"')) {
        const o = JSON.parse(line);
        cwd = o.cwd ?? cwd;
        time = o.timestamp ?? time;
        continue;
      }
      if (line.includes('"type":"session_info"')) {
        const o = JSON.parse(line);
        if (typeof o.name === "string") name = sanitizeText(o.name).trim(); // 空名字是显式清掉
        continue;
      }
      // 工具结果行只用来判断“最后一轮还在跑”，内容不读也不解析
      if (line.includes('"type":"message"') && line.includes('"role":"toolResult"')) {
        tailRole = "toolResult";
        tailStop = undefined;
        continue;
      }
      // 先用子串粗筛，省掉大部分行的 JSON.parse
      if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) {
        // pi-web 的置顶 / 草稿标记是 custom 记录，不在正文里；置顶最后一条生效，和 pi-web 的读法一致
        if (line.includes("pi-web:pin") || line.includes('"draft-session"')) {
          const o = JSON.parse(line);
          if (o.type === "custom" && o.customType === "pi-web:pin") pinned = o.data?.pinned === true;
          // 草稿记录之后 AI 一开口就不是草稿了（pi-web 的 isParkedDraft；它还会忽略 clarify 那一轮，这里不管）
          else if (o.type === "custom" && o.customType === "draft-session") draftMarker = true;
        }
        continue;
      }
      const o = JSON.parse(line);
      if (o.type !== "message") continue;
      const role = o.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      // 消息自己的 timestamp 是毫秒，记录上的 timestamp 是 ISO，两种都见得到
      const ts = typeof o.message?.timestamp === "number" ? o.message.timestamp : Date.parse(o.timestamp);
      if (role === "user" && !Number.isNaN(ts)) lastPrompt = ts;
      if (role === "assistant") {
        anyAssistant = true;
        if (draftMarker) assistantAfterDraft = true;
      }
      tailRole = role;
      tailStop = role === "assistant" ? o.message?.stopReason : undefined;
      const text = extractText(o.message?.content).trim();
      const tools = role === "assistant" ? extractTools(o.message.content) : [];
      // 只有工具调用的 AI 轮次也留着，否则预览里"我来看看"直接跳到结论，中间做了什么全没了
      if (tools.length) msgs.push({ role, text, tools });
      else if (text) msgs.push({ role, text });
    } catch {
    }
  }

  // 一条文字消息都没有的会话不列出来；列表里的首条也只看有文字的
  const firstText = msgs.find((m) => m.text);
  if (!firstText) return null;

  // 末轮是 AI 才算收尾：toolUse 说明还要接着跑，user / toolResult 说明这轮还没答
  let status: PeekStatus | undefined;
  if (tailRole === "assistant" && tailStop !== "toolUse") {
    status = tailStop === "aborted" || tailStop === "error" ? "aborted" : "done";
  }
  const draft = draftMarker ? !assistantAfterDraft : /^Draft:\s/.test(name) && !anyAssistant;

  return {
    path,
    cwd,
    time,
    name,
    msgs,
    mtime,
    size,
    first: firstText.text.replace(/\s+/g, " ").slice(0, 80),
    ...(pinned === undefined ? {} : { pinned }),
    ...(lastPrompt === undefined ? {} : { lastPrompt }),
    ...(status === undefined ? {} : { status }),
    ...(draft ? { draft: true } : {}),
  };
}

/** 会话里的首条和最近一条用户提问：空白压成单空格、截到 max 字。没有用户消息就是 undefined */
export function userPrompts(s: PeekSession, max = 120): { first?: string; last?: string } {
  let first: string | undefined;
  let last: string | undefined;
  for (const m of s.msgs) {
    if (m.role !== "user" || !m.text) continue;
    const text = m.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (first === undefined) first = text.slice(0, max);
    last = text.slice(0, max);
  }
  return { ...(first === undefined ? {} : { first }), ...(last === undefined ? {} : { last }) };
}

// 单个文件：mtime 没变直接用缓存，否则重新读和解析
export async function loadSession(file: string): Promise<PeekSession | null> {
  let mtime: number;
  let size: number;
  try {
    const st = await stat(file);
    mtime = st.mtimeMs;
    size = st.size;
  } catch {
    return null;
  }
  const hit = sessionCache.get(file);
  if (hit && hit.mtime === mtime && hit.size === size) return hit.session;
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const parsed = parseSession(file, raw, mtime, size);
  sessionCache.set(file, { mtime, size, session: parsed });
  return parsed;
}

/** 全部会话，按最后修改时间倒序；文件没变的直接用缓存。
 * 目录遍历和文件读取都走异步 I/O，几百个会话也不会把 TUI 卡住 */
export async function scanSessions(root: string = sessionsDir()): Promise<PeekSession[]> {
  const files = await listSessionFiles(root);

  const out: PeekSession[] = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const s = await loadSession(files[next++].path);
      if (s) out.push(s);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker));

  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 只走目录并 stat，不读 JSONL：冷启动时几千个会话也能在几百毫秒内画出列表。
 * 按 mtime 倒序，后台解析按这个顺序从新到旧填内容 */
export async function listSessionFiles(root: string = sessionsDir()): Promise<SessionFile[]> {
  const paths: string[] = [];
  await walkJsonl(root, paths);

  const out: SessionFile[] = [];
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const path = paths[next++];
      try {
        const st = await stat(path);
        out.push({ path, mtime: st.mtimeMs, size: st.size });
      } catch {
        // 列目录到 stat 之间被删了：跳过
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker));

  // 文件已经不在了的，从缓存里去掉
  const seen = new Set(paths);
  for (const key of [...sessionCache.keys()]) {
    if (!seen.has(key)) sessionCache.delete(key);
  }

  return out.sort((a, b) => b.mtime - a.mtime);
}

// 和 pi 自带的 /name 写同一种 session_info 记录，parentId 用文件里最后一条记录的 id
export function renameSession(path: string, name: string): void {
  name = sanitizeText(name).replace(/\n+/g, " ").trim(); // 和 pi 的 appendSessionInfo 一样，换行不能进 JSONL 的一行
  appendEntry(path, {
    type: "session_info",
    id: randomBytes(4).toString("hex"),
    parentId: lastEntryId(path),
    timestamp: new Date().toISOString(),
    name,
  });
}

/** 文件里最后一条记录的 id：新记录挂在它下面，和 pi 自己追加记录的做法一样。末行可能只写了一半，跳过 */
export function lastEntryId(path: string): string | null {
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    try {
      const o = JSON.parse(lines[i]);
      if (typeof o.id === "string") return o.id;
    } catch {
      // 末行可能只写了一半
    }
  }
  return null;
}

/** 追加一条记录。末行没换行（写了一半）时先补一个，别和新记录粘在一起 */
export function appendEntry(path: string, entry: Record<string, unknown>): void {
  const raw = readFileSync(path, "utf8");
  const sep = raw === "" || raw.endsWith("\n") ? "" : "\n";
  appendFileSync(path, sep + JSON.stringify(entry) + "\n", "utf8");
}

/** Pi Web 的置顶开关：和 pi-web 写同一种 pi-web:pin 记录，最后一条生效 */
export function pinSession(path: string, pinned: boolean): void {
  appendEntry(path, {
    type: "custom",
    customType: "pi-web:pin",
    data: { version: 1, pinned },
    id: randomBytes(4).toString("hex"),
    parentId: lastEntryId(path),
    timestamp: new Date().toISOString(),
  });
}

export type DeleteResult = "trash" | "rm" | false;

// 各平台把文件送进回收站的命令，按顺序试。trash（trash-cli / brew trash）放最前面，装了就说明用户想用它；
// 后面是系统自带的途径：Windows 走 PowerShell 的 VisualBasic FileSystem，macOS 走 Finder，Linux 走 gio / trash-put
export function trashCommands(path: string, platform: NodeJS.Platform = process.platform): [string, string[]][] {
  const cmds: [string, string[]][] = [["trash", [path]]];
  if (platform === "win32") {
    const script =
      "Add-Type -AssemblyName Microsoft.VisualBasic; " +
      `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${path.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    const args = ["-NoProfile", "-NonInteractive", "-Command", script];
    cmds.push(["powershell", args], ["pwsh", args]);
  } else if (platform === "darwin") {
    cmds.push(["osascript", ["-e", `tell application "Finder" to delete POSIX file "${path.replace(/[\\"]/g, "\\$&")}"`]]);
  } else {
    cmds.push(["gio", ["trash", path]], ["trash-put", [path]]);
  }
  return cmds;
}

// 优先进回收站（能恢复），每个途径都不行再直接删。exec 由调用方传入，方便测试；
// 命令退出码为 0 但文件还在也当失败，继续试下一个。命令超时被杀但其实已经把文件移走了的，
// 事后再看一眼文件，别把"已进回收站"报成"永久删除"
export async function deleteSession(
  path: string,
  exec: (cmd: string, args: string[]) => Promise<{ code: number }>,
  platform: NodeJS.Platform = process.platform,
): Promise<DeleteResult> {
  const wasThere = existsSync(path);
  for (const [cmd, args] of trashCommands(path, platform)) {
    try {
      const r = await exec(cmd, args);
      if (r.code === 0 && !existsSync(path)) return "trash";
    } catch {
    }
    if (wasThere && !existsSync(path)) return "trash";
  }
  try {
    rmSync(path, { force: true });
    return "rm";
  } catch {
    return false;
  }
}
