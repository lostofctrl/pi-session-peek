import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { sanitizeText } from "../src/ansi.ts";
import { matchesSession, parseQuery } from "../src/query.ts";
import {
  deleteSession,
  listSessionFiles,
  loadSession,
  pendingSession,
  pinSession,
  lastEntryId,
  userPrompts,
  renameSession,
  scanRoot,
  scanSessions,
  sessionStamp,
  sortSessions,
  sessionsDir,
  toolSummary,
  trashCommands,
  type PeekSession,
} from "../src/sessions.ts";

let agentDir: string;
let dir: string;

function line(o: unknown) {
  return JSON.stringify(o) + "\n";
}

function session(file: string, opts: { cwd: string; time: string; name?: string; msgs: [string, string][]; tool?: boolean }) {
  let out = line({ type: "session", version: 3, id: file, timestamp: opts.time, cwd: opts.cwd });
  let prev: string | null = null;
  let n = 0;
  for (const [role, text] of opts.msgs) {
    const id = `${file}-${n++}`;
    out += line({ type: "message", id, parentId: prev, timestamp: opts.time, message: { role, content: [{ type: "text", text }] } });
    prev = id;
  }
  if (opts.tool) {
    out += line({ type: "message", id: "t1", parentId: prev, timestamp: opts.time, message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "grep SECRET_TOOL_ARG" } }] } });
    out += line({ type: "message", id: "t2", parentId: "t1", timestamp: opts.time, message: { role: "toolResult", content: [{ type: "text", text: "SECRET_TOOL_OUTPUT" }] } });
    prev = "t2";
  }
  if (opts.name !== undefined) {
    out += line({ type: "session_info", id: "info", parentId: prev, timestamp: opts.time, name: opts.name });
  }
  const p = join(dir, `${file}.jsonl`);
  writeFileSync(p, out);
  return p;
}

// 以前的 searchText 现在由 matchesSession 现算；引号包起来当一个短语搜
function hits(s: PeekSession, kw: string): boolean {
  return matchesSession(s, parseQuery(`"${kw}"`).terms);
}

before(() => {
  agentDir = mkdtempSync(join(tmpdir(), "peek-agent-"));
  dir = join(agentDir, "sessions", "--D--proj--");
  mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(agentDir, { recursive: true, force: true });
});

test("scanSessions: 解析 header、消息、名字，工具输入输出不进索引", async () => {
  const a = session("a", {
    cwd: "D:\\proj",
    time: "2026-09-01T00:00:00.000Z",
    name: "my name",
    msgs: [["user", "  first   question\nsecond line "], ["assistant", "an answer"]],
    tool: true,
  });
  utimesSync(a, new Date("2026-09-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"));
  const b = session("b", { cwd: "D:\\proj", time: "2026-09-02T00:00:00.000Z", msgs: [["user", "later one"]] });
  utimesSync(b, new Date("2026-09-02T00:00:00Z"), new Date("2026-09-02T00:00:00Z"));
  session("empty", { cwd: "D:\\proj", time: "2026-09-03T00:00:00.000Z", msgs: [] });
  writeFileSync(join(dir, "broken.jsonl"), "not json\n{\n");

  const all = await scanSessions();
  assert.deepEqual(all.map((s) => s.path), [b, a]);

  const sa = all[1];
  assert.equal(sa.cwd, "D:\\proj");
  assert.equal(sa.time, "2026-09-01T00:00:00.000Z");
  assert.equal(sa.name, "my name");
  assert.deepEqual(sa.msgs, [
    { role: "user", text: "first   question\nsecond line" },
    { role: "assistant", text: "an answer" },
    // 只有工具调用的 AI 轮次也保留，预览开 Ctrl+T 时显示；工具结果不存
    { role: "assistant", text: "", tools: [{ name: "bash", summary: "grep SECRET_TOOL_ARG" }] },
  ]);
  assert.equal(sa.first, "first question second line");
  assert.ok(!("searchText" in sa)); // 不再额外存一份小写全文
  assert.ok(hits(sa, "FIRST   question"));
  assert.ok(hits(sa, "my name"));
  assert.ok(!hits(sa, "d:\\proj")); // 工作目录不参与普通匹配
  assert.ok(matchesSession(sa, parseQuery("dir:proj").terms));
  assert.ok(!hits(sa, "secret_tool_arg"));
  assert.ok(!hits(sa, "secret_tool_output"));
});

test("scanSessions: 最后一条 session_info 生效，空名字清掉", async () => {
  const p = session("c", { cwd: "D:\\proj", time: "2026-09-04T00:00:00.000Z", name: "old", msgs: [["user", "x"]] });
  writeFileSync(p, readFileSync(p, "utf8") + line({ type: "session_info", id: "info2", parentId: "info", timestamp: "2026-09-04T00:00:01.000Z", name: "" }) + line({ type: "session_info", id: "info3", parentId: "info2", timestamp: "2026-09-04T00:00:02.000Z", name: "newest" }));
  const s = (await scanSessions()).find((s) => s.path === p)!;
  assert.equal(s.name, "newest");
});

test("scanSessions: mtime 不变复用缓存，变了重新解析，文件删了就消失", async () => {
  const p = session("d", { cwd: "D:\\proj", time: "2026-09-05T00:00:00.000Z", msgs: [["user", "v1"]] });
  const t1 = new Date("2026-09-05T00:00:00Z");
  utimesSync(p, t1, t1);
  const first = (await scanSessions()).find((s) => s.path === p)!;
  const again = (await scanSessions()).find((s) => s.path === p)!;
  assert.equal(again, first);

  writeFileSync(p, readFileSync(p, "utf8") + line({ type: "message", id: "m9", parentId: "d-0", timestamp: "x", message: { role: "assistant", content: [{ type: "text", text: "v2" }] } }));
  const t2 = new Date("2026-09-05T01:00:00Z");
  utimesSync(p, t2, t2);
  const updated = (await scanSessions()).find((s) => s.path === p)!;
  assert.notEqual(updated, first);
  assert.equal(updated.msgs.length, 2);

  rmSync(p);
  assert.equal((await scanSessions()).some((s) => s.path === p), false);
});

test("renameSession: 追加 session_info，parentId 是最后一条记录，能跳过写了一半的末行", async () => {
  const p = session("e", { cwd: "D:\\proj", time: "2026-09-06T00:00:00.000Z", msgs: [["user", "hi"], ["assistant", "yo"]] });
  writeFileSync(p, readFileSync(p, "utf8") + '{"type":"message","id":"half"');
  renameSession(p, "renamed");
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  const last = JSON.parse(lines.at(-1)!);
  assert.equal(last.type, "session_info");
  assert.equal(last.name, "renamed");
  assert.equal(last.parentId, "e-1");
  assert.equal(typeof last.id, "string");
  assert.equal((await scanSessions()).find((s) => s.path === p)!.name, "renamed");
});

test("deleteSession: 回收站命令成功且文件消失才算进回收站，否则依次再试，最后直接删", async () => {
  const p = session("f", { cwd: "D:\proj", time: "2026-09-07T00:00:00.000Z", msgs: [["user", "bye"]] });
  const calls: string[][] = [];
  // 模拟 trash 真的把文件移走了
  const r1 = await deleteSession(p, async (cmd, args) => (calls.push([cmd, ...args]), rmSync(p), { code: 0 }), "linux");
  assert.equal(r1, "trash");
  assert.deepEqual(calls, [["trash", p]]);

  // 退出码 0 但文件还在（比如同名的别的程序）：不算成功，继续试后面的
  const q = session("g", { cwd: "D:\proj", time: "2026-09-07T00:00:00.000Z", msgs: [["user", "bye"]] });
  calls.length = 0;
  const r2 = await deleteSession(q, async (cmd) => (calls.push([cmd]), { code: 0 }), "linux");
  assert.equal(r2, "rm");
  assert.deepEqual(calls.map((c) => c[0]), ["trash", "gio", "trash-put"]);
  assert.equal(existsSync(q), false);

  // 全部抛错（命令不存在）也直接删
  const h = session("h", { cwd: "D:\proj", time: "2026-09-07T00:00:00.000Z", msgs: [["user", "bye"]] });
  assert.equal(await deleteSession(h, async () => { throw new Error("no trash"); }, "darwin"), "rm");
  assert.equal(existsSync(h), false);

  // 文件本来就不存在：回收站命令不可能成功，rmSync force 也不报错
  assert.equal(await deleteSession(join(dir, "nope.jsonl"), async () => ({ code: 1 }), "win32"), "rm");
});

test("trashCommands: 各平台的候选命令，路径里的引号要转义", () => {
  assert.deepEqual(trashCommands("/a/b.jsonl", "linux"), [
    ["trash", ["/a/b.jsonl"]],
    ["gio", ["trash", "/a/b.jsonl"]],
    ["trash-put", ["/a/b.jsonl"]],
  ]);

  const mac = trashCommands('/a/it"s.jsonl', "darwin");
  assert.equal(mac[0][0], "trash");
  assert.equal(mac[1][0], "osascript");
  assert.equal(mac[1][1][1], 'tell application "Finder" to delete POSIX file "/a/it\\"s.jsonl"');

  const win = trashCommands("C:\\x\\it's.jsonl", "win32");
  assert.deepEqual(win.map((c) => c[0]), ["trash", "powershell", "pwsh"]);
  const script = win[1][1].at(-1)!;
  assert.ok(win[1][1].includes("-NonInteractive"));
  assert.ok(script.includes("DeleteFile('C:\\x\\it''s.jsonl', 'OnlyErrorDialogs', 'SendToRecycleBin')"), script);
  assert.deepEqual(win[2][1], win[1][1]);
});

test("toolSummary: 常见主参数优先，其次第一个字符串参数，压成一行并截断", () => {
  assert.equal(toolSummary({ command: "  git   status\n" }), "git status");
  assert.equal(toolSummary({ limit: 10, path: "src/a.ts" }), "src/a.ts");
  assert.equal(toolSummary({ edits: [], path: "src/b.ts" }), "src/b.ts");
  assert.equal(toolSummary({ max_results: 5, query: "pi tui" }), "pi tui");
  assert.equal(toolSummary({ foo: 1, bar: "first string" }), "first string");
  assert.equal(toolSummary({ n: 1 }), "");
  assert.equal(toolSummary(undefined), "");
  assert.equal(toolSummary("x"), "");
  assert.equal(toolSummary({ command: "x".repeat(200) }).length, 120);
});

test("sessionsDir: 默认 ~/.pi/agent/sessions，认 PI_CODING_AGENT_DIR 并展开 ~", () => {
  const home = homedir();
  assert.equal(sessionsDir({}), join(home, ".pi", "agent", "sessions"));
  assert.equal(sessionsDir({ PI_CODING_AGENT_DIR: "/x/agent" }), join("/x/agent", "sessions"));
  assert.equal(sessionsDir({ PI_CODING_AGENT_DIR: "~/a" }), join(home, "/a", "sessions"));
});

test("scanRoot: pi 的会话目录是默认布局的子目录时扫上一级（所有项目），自定义目录时扫它本身", () => {
  const env = { PI_CODING_AGENT_DIR: "/x/agent" };
  const root = join("/x/agent", "sessions");
  assert.equal(scanRoot(undefined, env), root);
  assert.equal(scanRoot(join(root, "--D--proj--"), env), root);
  assert.equal(scanRoot(join(root, "--D--proj--") + "/", env), root);
  assert.equal(scanRoot("/custom/sessions", env), "/custom/sessions");
  assert.equal(scanRoot(join(root, "nested", "--D--proj--"), env), join(root, "nested", "--D--proj--"));
});

test("sanitizeText: 去掉终端转义序列和控制字符，保留换行和制表符，CRLF 归一", () => {
  assert.equal(sanitizeText("a\x1b[31mred\x1b[0m b"), "ared b");
  assert.equal(sanitizeText("x\x1b]8;;http://u\x07link\x1b]8;;\x07y"), "xlinky");
  assert.equal(sanitizeText("x\x1b]52;c;aGk=\x1b\\y"), "xy"); // ST（ESC \）终止的 OSC
  assert.equal(sanitizeText("x\x1bPq\x1b\\y\x1b_z\x07w"), "xyw"); // DCS 用 ST，APC 用 BEL
  assert.equal(sanitizeText("a\x1b\\b"), "ab"); // 孤立的 ST 本身也去掉
  assert.equal(sanitizeText("a\x07b\x00c\x7fd"), "abcd");
  assert.equal(sanitizeText("l1\r\nl2\rl3\tt"), "l1\nl2\nl3\tt");
  assert.equal(sanitizeText("plain 中文 ✓"), "plain 中文 ✓");
});

test("scanSessions: 正文和会话名里的转义序列被清掉，字符串型 content 也能解析", async () => {
  const p = join(dir, "esc.jsonl");
  writeFileSync(
    p,
    line({ type: "session", version: 3, id: "esc", timestamp: "2026-09-08T00:00:00.000Z", cwd: "D:\proj" }) +
      line({ type: "message", id: "e1", parentId: null, timestamp: "t", message: { role: "user", content: "plain \x1b[2Jstring" } }) +
      line({ type: "message", id: "e2", parentId: "e1", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "\x1b[31mred\x1b[0m" }, { type: "toolCall", name: "bash", arguments: { command: "echo \x1b]0;t\x07hi" } }] } }) +
      line({ type: "session_info", id: "e3", parentId: "e2", timestamp: "t", name: "n\x1b[1mame\n2" }),
  );
  const s = (await scanSessions()).find((s) => s.path === p)!;
  assert.deepEqual(s.msgs, [
    { role: "user", text: "plain string" },
    { role: "assistant", text: "red", tools: [{ name: "bash", summary: "echo hi" }] },
  ]);
  assert.equal(s.name, "name\n2");
});

test("scanSessions: mtime 相同但大小变了也重新解析", async () => {
  const p = session("sz", { cwd: "D:\proj", time: "2026-09-09T00:00:00.000Z", msgs: [["user", "one"]] });
  const t = new Date("2026-09-09T00:00:00Z");
  utimesSync(p, t, t);
  const first = (await scanSessions()).find((s) => s.path === p)!;
  writeFileSync(p, readFileSync(p, "utf8") + line({ type: "message", id: "sz-9", parentId: "sz-0", timestamp: "x", message: { role: "assistant", content: [{ type: "text", text: "two" }] } }));
  utimesSync(p, t, t);
  const again = (await scanSessions()).find((s) => s.path === p)!;
  assert.notEqual(again, first);
  assert.equal(again.msgs.length, 2);
});

test("renameSession: 名字里的换行和转义序列被清掉", async () => {
  const p = session("rn", { cwd: "D:\proj", time: "2026-09-10T00:00:00.000Z", msgs: [["user", "hi"]] });
  renameSession(p, "  a\r\nb\x1b[31m c  ");
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 3, "still one record per line");
  assert.equal(JSON.parse(lines.at(-1)!).name, "a b c");
});

test("deleteSession: 回收站命令超时抛错但文件已经没了，算进回收站而不是永久删除", async () => {
  const p = session("to", { cwd: "D:\proj", time: "2026-09-11T00:00:00.000Z", msgs: [["user", "bye"]] });
  const r = await deleteSession(p, async () => { rmSync(p); throw new Error("timeout"); }, "win32");
  assert.equal(r, "trash");
});


test("scanSessions: cache empty parses, retry changed files at the same mtime", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peek-null-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = join(root, "empty.jsonl");
  const empty = JSON.stringify({ type: "message", message: { role: "user", content: "" } });
  writeFileSync(p, empty);
  const stamp = new Date("2026-09-01T00:00:00Z");
  utimesSync(p, stamp, stamp);
  let parses = 0;
  const original = JSON.parse;
  t.mock.method(JSON, "parse", (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (text === empty) parses++;
    return original(text, reviver);
  });
  assert.deepEqual(await scanSessions(root), []);
  assert.equal(parses, 1);
  assert.deepEqual(await scanSessions(root), []);
  assert.equal(parses, 1, "unchanged empty sessions must not be reparsed");
  writeFileSync(p, empty + "\n" + JSON.stringify({ type: "message", message: { role: "user", content: "now searchable" } }));
  utimesSync(p, stamp, stamp);
  const updated = await scanSessions(root);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].first, "now searchable");
  rmSync(p);
  assert.deepEqual(await scanSessions(root), []);
});

test("listSessionFiles: 只列文件和 mtime/size，按时间倒序，空会话也算（给懒加载先画列表）", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "peek-lazy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = session2(root, "old", "2026-01-01T00:00:00.000Z", "old first");
  const recent = session2(root, "recent", "2026-06-01T00:00:00.000Z", "recent first");
  // 一条正文都没有的会话：scanSessions 会丢掉，但列表仍要先显示它，解析后再移除
  const empty = join(root, "empty.jsonl");
  writeFileSync(empty, JSON.stringify({ type: "message", message: { role: "user", content: "" } }));
  const emptyStamp = new Date("2026-03-01T00:00:00.000Z");
  utimesSync(empty, emptyStamp, emptyStamp);

  const files = await listSessionFiles(root);
  assert.deepEqual(files.map((f) => f.path), [recent, empty, old]);
  assert.ok(files[0].mtime > files[1].mtime);
  assert.ok(files.every((f) => f.size >= 0));

  const placeholder = pendingSession(files[0]);
  assert.equal(placeholder.path, recent);
  assert.equal(placeholder.pending, true);
  assert.deepEqual(placeholder.msgs, []);
  assert.equal(placeholder.mtime, files[0].mtime);
  assert.equal(placeholder.time, new Date(files[0].mtime).toISOString());
  assert.ok(!Number.isNaN(new Date(placeholder.time).getTime()));

  // 占位项本身不读文件；显式 loadSession 才解析出内容
  const parsed = await loadSession(recent);
  assert.equal(parsed?.first, "recent first");
});

function session2(root: string, name: string, time: string, text: string): string {
  const p = join(root, `${name}.jsonl`);
  writeFileSync(
    p,
    line({ type: "session", version: 3, id: name, timestamp: time, cwd: "D:\\lazy" }) +
      line({ type: "message", id: `${name}-m`, parentId: null, timestamp: time, message: { role: "user", content: [{ type: "text", text }] } }),
  );
  const stamp = new Date(time);
  utimesSync(p, stamp, stamp);
  return p;
}

test("scanSessions: pi-web 的 /pin 状态取最后一条记录，没写过 /pin 就不带 pinned", async () => {
  const p = session("pinned", { cwd: "D:\\proj", time: "2026-09-05T00:00:00.000Z", msgs: [["user", "x"]] });
  const find = async () => (await scanSessions()).find((s) => s.path === p)!;
  assert.equal((await find()).pinned, undefined);

  writeFileSync(p, readFileSync(p, "utf8") + line({ type: "custom", id: "pin1", parentId: "pinned-0", timestamp: "2026-09-05T00:00:01.000Z", customType: "pi-web:pin", data: { version: 1, pinned: true } }));
  assert.equal((await find()).pinned, true);

  // 坏数据按未置顶处理，和 pi-web 的读法一致
  writeFileSync(p, readFileSync(p, "utf8") + line({ type: "custom", id: "pin2", parentId: "pin1", timestamp: "2026-09-05T00:00:02.000Z", customType: "pi-web:pin", data: { version: 1, pinned: "yes" } }));
  assert.equal((await find()).pinned, false);

  writeFileSync(p, readFileSync(p, "utf8") + line({ type: "custom", id: "pin3", parentId: "pin2", timestamp: "2026-09-05T00:00:03.000Z", customType: "pi-web:pin", data: { version: 1, pinned: true } }));
  assert.equal((await find()).pinned, true, "取消置顶后再置顶，最后一条说了算");

  // 别把正文里提到 pi-web:pin 的消息当成标记
  const q = session("mention", { cwd: "D:\\proj", time: "2026-09-05T00:00:00.000Z", msgs: [["user", 'we use "pi-web:pin" here']] });
  const m = (await scanSessions()).find((s) => s.path === q)!;
  assert.equal(m.pinned, undefined);
  assert.ok(matchesSession(m, parseQuery("pi-web:pin").terms));
});

function writeRaw(name: string, entries: unknown[]): string {
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, entries.map(line).join(""));
  return p;
}

const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

// 消息记录：message.timestamp 是毫秒，记录上的 timestamp 是 ISO；stopReason 只有 AI 轮次有
function msg(role: string, text: string, at: number, stopReason?: string) {
  return {
    type: "message", id: `${role}${at}`, parentId: null, timestamp: iso(at),
    message: { role, content: [{ type: "text", text }], timestamp: at, ...(stopReason ? { stopReason } : {}) },
  };
}

const header = (name: string) => ({ type: "session", version: 3, id: name, timestamp: iso(T0), cwd: "D:/proj" });

test("解析: lastPrompt 取最后一条用户消息的时间", async () => {
  const p = writeRaw("prompt-time", [
    header("prompt-time"),
    msg("user", "q1", T0),
    msg("assistant", "a1", T0 + 1000, "stop"),
    msg("user", "q2", T0 + 2000),
    msg("assistant", "a2", T0 + 3000, "stop"),
  ]);
  assert.equal((await loadSession(p))!.lastPrompt, T0 + 2000);

  // 消息上没有毫秒时间戳（老记录）时退回记录上的 ISO 时间
  const q = writeRaw("prompt-fallback", [
    header("prompt-fallback"),
    { type: "message", id: "u", parentId: null, timestamp: iso(T0 + 5000), message: { role: "user", content: [{ type: "text", text: "x" }] } },
  ]);
  assert.equal((await loadSession(q))!.lastPrompt, T0 + 5000);

  // 完全没有用户消息就没有这个键（排序时退回 mtime）
  const r = writeRaw("prompt-none", [header("prompt-none"), msg("assistant", "only ai", T0, "stop")]);
  assert.equal((await loadSession(r))!.lastPrompt, undefined);
});

test("解析: status 看末轮有没有答完，done = AI 答完（settled），aborted = 中断 / 报错", async () => {
  const load = async (name: string, msgs: unknown[]) => (await loadSession(writeRaw(name, [header(name), ...msgs])))!;

  const done = await load("st-done", [msg("user", "q", T0), msg("assistant", "a", T0 + 1000, "stop")]);
  assert.equal(done.status, "done");
  // 只有工具调用的 AI 轮次也算答完
  const toolsOnly = await load("st-tools", [msg("user", "q", T0), msg("assistant", "", T0 + 1000, "stop")]);
  assert.equal(toolsOnly.status, "done");

  assert.equal((await load("st-abort", [msg("user", "q", T0), msg("assistant", "a", T0 + 1000, "aborted")])).status, "aborted");
  assert.equal((await load("st-error", [msg("user", "q", T0), msg("assistant", "a", T0 + 1000, "error")])).status, "aborted");

  // 末条是工具调用 / 用户 / 工具结果：这轮还没答完，不给状态
  assert.equal((await load("st-running", [msg("user", "q", T0), msg("assistant", "", T0 + 1000, "toolUse")])).status, undefined);
  assert.equal((await load("st-waiting", [msg("user", "q", T0), msg("assistant", "a", T0 + 1000, "stop"), msg("user", "again", T0 + 2000)])).status, undefined);
  const withTool = [
    header("st-tool-tail"),
    msg("user", "q", T0),
    msg("assistant", "", T0 + 1000, "toolUse"),
    { type: "message", id: "r1", parentId: null, timestamp: iso(T0 + 2000), message: { role: "toolResult", content: [{ type: "text", text: "output" }] } },
  ];
  assert.equal((await loadSession(writeRaw("st-tool-tail", withTool)))!.status, undefined);
});

test("解析: draft 是 pi-web 停在那儿的草稿，AI 回答过就不是了", async () => {
  const marker = { type: "custom", id: "d1", parentId: null, timestamp: iso(T0), customType: "draft-session", data: { version: 1, text: "parked" } };
  const load = async (name: string, entries: unknown[]) => (await loadSession(writeRaw(name, [header(name), ...entries])))!;

  assert.equal((await load("draft-parked", [marker, msg("user", "parked", T0)])).draft, true);
  assert.equal((await load("draft-answered", [marker, msg("user", "parked", T0), msg("assistant", "hello", T0 + 1000, "stop")])).draft, undefined);
  // 没有草稿记录的普通会话
  assert.equal((await load("draft-none", [msg("user", "hi", T0)])).draft, undefined);

  // 老式的 "Draft: " 名字，AI 从没开口过才算草稿
  const named = (name: string) => ({ type: "session_info", id: "i1", parentId: null, timestamp: iso(T0), name });
  assert.equal((await load("draft-legacy", [named("Draft: parked"), msg("user", "parked", T0)])).draft, true);
  assert.equal((await load("draft-legacy-answered", [named("Draft: parked"), msg("user", "parked", T0), msg("assistant", "hi", T0 + 1000, "stop")])).draft, undefined);
});

test("sortSessions / sessionStamp: 按提问或创建时间倒序，没提问记录时用 mtime 兜底", () => {
  const base = { cwd: "D:/proj", name: "", first: "", msgs: [], size: 0 };
  const a: PeekSession = { ...base, path: "a", time: iso(T0), mtime: 5, lastPrompt: T0 + 3000 };
  const b: PeekSession = { ...base, path: "b", time: iso(T0 + 1000), mtime: 3 };
  const c: PeekSession = { ...base, path: "c", time: iso(T0 + 2000), mtime: 4, lastPrompt: T0 + 1000 };
  const all = [a, b, c];

  assert.deepEqual(sortSessions(all, "prompt").map((s) => s.path), ["a", "c", "b"]);
  assert.deepEqual(sortSessions(all, "created").map((s) => s.path), ["c", "b", "a"]);
  assert.deepEqual(all.map((s) => s.path), ["a", "b", "c"], "不改入参顺序");

  assert.equal(sessionStamp(a, "prompt"), T0 + 3000);
  assert.equal(sessionStamp(b, "prompt"), 3); // 没提问记录
  assert.equal(sessionStamp(b, "created"), T0 + 1000);
  // 时间一样时按 mtime 倒序，顺序稳定
  const t = { ...base, time: iso(T0), lastPrompt: T0 };
  assert.deepEqual(
    sortSessions([{ ...t, path: "old", mtime: 1 }, { ...t, path: "new", mtime: 2 }], "prompt").map((s) => s.path),
    ["new", "old"],
  );
});

test("userPrompts: 首条和最近一条用户提问，空白压成单空格并截断；没有用户消息就是空", () => {
  const s = (msgs: { role: "user" | "assistant"; text: string }[]) => ({ path: "p", cwd: "D:/proj", time: "", name: "", first: "", msgs, mtime: 0, size: 0 }) as PeekSession;

  assert.deepEqual(userPrompts(s([
    { role: "user", text: "  first \n  line " },
    { role: "assistant", text: "answer" },
    { role: "user", text: "latest   one" },
    { role: "assistant", text: "answer again" },
  ])), { first: "first line", last: "latest one" });

  // 只有一条提问：首尾是同一条
  assert.deepEqual(userPrompts(s([{ role: "user", text: "only" }, { role: "assistant", text: "a" }])), { first: "only", last: "only" });
  // AI 回复不算提问
  assert.deepEqual(userPrompts(s([{ role: "assistant", text: "a" }])), {});
  // 全是空白的用户消息跳过
  assert.deepEqual(userPrompts(s([{ role: "user", text: "  \n " }, { role: "user", text: "real" }])), { first: "real", last: "real" });
  // 截断长度
  assert.equal(userPrompts(s([{ role: "user", text: "x".repeat(50) }]), 10).first, "x".repeat(10));
});

test("pinSession: 追加 pi-web:pin 记录，parentId 是最后一条记录，能跳过写了一半的末行", async () => {
  const p = session("pin", { cwd: "D:\\proj", time: "2026-09-06T00:00:00.000Z", msgs: [["user", "hi"], ["assistant", "yo"]] });
  writeFileSync(p, readFileSync(p, "utf8") + '{"type":"message","id":"half"');
  pinSession(p, true);
  let lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  let last = JSON.parse(lines.at(-1)!);
  assert.equal(last.type, "custom");
  assert.equal(last.customType, "pi-web:pin");
  assert.deepEqual(last.data, { version: 1, pinned: true });
  assert.equal(last.parentId, "pin-1");
  assert.equal(typeof last.id, "string");

  // 列表里读到置顶状态
  let t = Date.now();
  utimesSync(p, new Date(t), new Date(t));
  assert.equal((await scanSessions()).find((s) => s.path === p)!.pinned, true);

  // 再写一条取消置顶，最后一条生效；新记录挂在上一条置顶记录下面
  const prevId = JSON.parse(readFileSync(p, "utf8").split("\n").filter(Boolean).at(-1)!).id;
  pinSession(p, false);
  lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  last = JSON.parse(lines.at(-1)!);
  assert.equal(last.parentId, prevId);
  assert.deepEqual(last.data, { version: 1, pinned: false });
  assert.equal(lastEntryId(p), last.id);
  t += 1000;
  utimesSync(p, new Date(t), new Date(t));
  assert.equal((await scanSessions()).find((s) => s.path === p)!.pinned, false);
});
