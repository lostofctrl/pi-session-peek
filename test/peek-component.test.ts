import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setLang } from "../src/i18n.ts";
import { visibleItems } from "../src/list.ts";
import { PeekComponent } from "../src/peek-component.ts";
import type { PeekSession } from "../src/sessions.ts";
import { mdTheme, strip, theme } from "./helpers.ts";

setLang("zh");

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const ALT = (ch: string) => "\x1b" + ch;
const KEY = { enter: "\r", tab: "\t", up: "\x1b[A", down: "\x1b[B", bs: "\x7f", esc: "\x1b", cc: "\x03", cd: "\x04", cf: "\x06", co: "\x0f", cr: "\x12", ct: "\x14", cu: "\x15", ap: "\x1bp" };

function mk(cwd: string, texts: string[], ageDays: number, name = ""): PeekSession {
  const mtime = Date.now() - ageDays * 86400e3;
  return {
    path: `${cwd}/${texts[0].slice(0, 8)}.jsonl`,
    cwd,
    time: new Date(mtime).toISOString(),
    name,
    first: texts[0],
    msgs: texts.map((text, i) => ({ role: i % 2 ? "assistant" : "user", text })),
    mtime,
    size: 0,
  };
}

function fixture() {
  return [
    mk("D:/proj", ["alpha beta", "reply one"], 1),
    mk("D:/proj/packages/web", ["alpha only"], 2),
    mk("D:/projX", ["some long preamble text and then gamma appears"], 20, "named-x"),
    mk("D:/other", ["beta alpha"], 40, "other-name"),
  ];
}

function make(all = fixture(), cwd = "d:/PROJ", initial = "") {
  const c: any = new PeekComponent(all, cwd, theme, mdTheme, 40, initial);
  c.requestRender = () => {};
  return c;
}

function type(c: any, s: string) {
  for (const ch of s) c.handleInput(ch);
}

test("默认范围：当前目录树下有会话就选当前目录，含子目录，大小写和斜杠不敏感", () => {
  const c = make();
  assert.equal(c.scope, "current");
  assert.deepEqual(c.filtered.map((s: PeekSession) => s.cwd), ["D:/proj", "D:/proj/packages/web"]);
});

test("默认范围：当前目录下没有会话就选全局", () => {
  const c = make(fixture(), "D:/nowhere");
  assert.equal(c.scope, "all");
  assert.equal(c.filtered.length, 4);
});

test("Tab 切换范围", () => {
  const c = make();
  c.handleInput(KEY.tab);
  assert.equal(c.scope, "all");
  assert.equal(c.filtered.length, 4);
  c.handleInput(KEY.tab);
  assert.equal(c.filtered.length, 2);
});

test("多关键词 AND", () => {
  const c = make(fixture(), "D:/nowhere");
  type(c, "alpha");
  assert.equal(c.filtered.length, 3);
  type(c, " beta");
  assert.equal(c.filtered.length, 2);
  type(c, " gamma");
  assert.equal(c.filtered.length, 0);
});

test("关键词命中会话名", () => {
  const c = make(fixture(), "D:/nowhere");
  type(c, "named-x");
  assert.equal(c.filtered.length, 1);
  assert.equal(c.filtered[0].cwd, "D:/projX");
});

test("@10d 时间过滤，头部显示时间标签", () => {
  const c = make(fixture(), "D:/nowhere");
  type(c, "alpha beta @10d");
  assert.equal(c.filtered.length, 1);
  assert.equal(c.filtered[0].cwd, "D:/proj");
  assert.ok(strip(c.render(120)[0]).includes("近10天"));
});

test("头部显示匹配数", () => {
  const c = make(fixture(), "D:/nowhere");
  type(c, "beta");
  assert.ok(strip(c.render(120)[0]).includes("匹配 2/4"));
});

test("有关键词时列表第二行显示命中片段", () => {
  const c = make(fixture(), "D:/nowhere");
  type(c, "gamma");
  const row2 = strip(c.render(120)[4]);
  assert.ok(row2.includes("…"));
  assert.ok(row2.includes("gamma"));
});

test("没有关键词时列表第二行显示首条消息和会话名", () => {
  const c = make(fixture(), "D:/nowhere");
  const rows = c.render(120).map(strip);
  assert.ok(rows[4].includes("alpha beta"));
  const named = rows.find((r: string) => r.includes("beta alpha  [other-name]"));
  assert.ok(named);
});

test("只移动光标不重置选中项", () => {
  const c = make(fixture(), "D:/nowhere");
  c.handleInput(KEY.down);
  assert.equal(c.selected, 1);
  c.handleInput("\x1b[H");
  assert.equal(c.selected, 1);
  type(c, "a");
  assert.equal(c.selected, 0);
});

test("Enter 进入，Ctrl+O 分叉，Esc / Ctrl+C 关闭", () => {
  const c = make();
  const got: string[] = [];
  c.onResume = (s: PeekSession) => got.push("resume:" + s.cwd);
  c.onFork = (s: PeekSession) => got.push("fork:" + s.cwd);
  c.onCancel = () => got.push("cancel");
  c.handleInput(KEY.enter);
  c.handleInput(KEY.co);
  c.handleInput(KEY.esc);
  c.handleInput(KEY.cc);
  assert.deepEqual(got, ["resume:D:/proj", "fork:D:/proj", "cancel", "cancel"]);
});

test("Ctrl+D 需要确认：y / Enter 执行，其他键取消", async () => {
  const c = make();
  let deleted = 0;
  c.onDelete = async () => (deleted++, true);
  c.handleInput(KEY.cd);
  assert.equal(c.mode, "confirmDelete");
  assert.ok(strip(c.render(120).at(-1)).includes("删除会话"));
  c.handleInput("n");
  assert.equal(c.mode, "search");
  assert.equal(deleted, 0);

  c.handleInput(KEY.cd);
  c.handleInput(KEY.enter);
  await tick();
  assert.equal(deleted, 1);
  assert.equal(c.filtered.length, 1);
  assert.equal(c.all.length, 3);

  c.handleInput(KEY.cd);
  c.handleInput("y");
  await tick();
  assert.equal(deleted, 2);
  assert.equal(c.filtered.length, 0);
});

test("删除确认中按 Ctrl+C 只取消确认，不关闭", () => {
  const c = make();
  let cancelled = 0;
  c.onCancel = () => cancelled++;
  c.onDelete = async () => true;
  c.handleInput(KEY.cd);
  c.handleInput(KEY.cc);
  assert.equal(c.mode, "search");
  assert.equal(cancelled, 0);
});

test("删除失败时列表不变", async () => {
  const c = make();
  c.onDelete = async () => false;
  c.handleInput(KEY.cd);
  c.handleInput("y");
  await tick();
  assert.equal(c.filtered.length, 2);
});

test("删除在途时不能再删、改名、进入、分叉；回来后恢复", async () => {
  const c = make();
  let resolve!: (ok: boolean) => void;
  let calls = 0;
  c.onDelete = () => (calls++, new Promise<boolean>((r) => (resolve = r)));
  const opened: string[] = [];
  c.onResume = () => opened.push("resume");
  c.onFork = () => opened.push("fork");
  c.onRename = async () => true;
  c.handleInput(KEY.cd);
  c.handleInput("y");
  assert.equal(calls, 1);
  // 回调没回来之前
  c.handleInput(KEY.cd);
  assert.equal(c.mode, "search");
  c.handleInput(KEY.cr);
  assert.equal(c.mode, "search");
  c.handleInput(KEY.enter);
  c.handleInput(KEY.co);
  c.render(120);
  c.handleMouse({ type: "press", button: "left", x: 2, y: 3 });
  c.handleMouse({ type: "click", button: "left", x: 2, y: 3, clickCount: 2 });
  assert.deepEqual(opened, []);
  resolve(true);
  await tick();
  assert.equal(c.filtered.length, 1);
  c.handleInput(KEY.enter);
  assert.deepEqual(opened, ["resume"]);
});

test("删除 / 重命名回调抛错也会解锁，不会永久锁住", async () => {
  const c = make();
  c.onDelete = async () => { throw new Error("boom"); };
  c.onRename = async () => { throw new Error("boom"); };
  c.handleInput(KEY.cd);
  c.handleInput("y");
  assert.equal(c.busy, true);
  await tick();
  assert.equal(c.busy, false);
  assert.equal(c.filtered.length, 2, "nothing removed on error");
  c.handleInput(KEY.cr);
  c.renameInput.setValue("x");
  c.handleInput(KEY.enter);
  assert.equal(c.busy, true);
  await tick();
  assert.equal(c.busy, false);
});

test("Ctrl+R 重命名：Enter 提交，名字参与搜索", async () => {
  const c = make(fixture(), "D:/nowhere");
  const calls: string[] = [];
  c.onRename = async (_s: PeekSession, name: string) => (calls.push(name), true);
  c.handleInput(KEY.cr);
  assert.equal(c.mode, "rename");
  assert.ok(strip(c.render(120).at(-1)).includes("重命名"));
  c.renameInput.setValue("fresh-name");
  c.handleInput(KEY.enter);
  await tick();
  assert.deepEqual(calls, ["fresh-name"]);
  assert.equal(c.filtered[0].name, "fresh-name");
  // 新名字立刻参与搜索，且不区分大小写
  c.input.setValue("FRESH-name");
  c.refilter();
  assert.deepEqual(c.filtered.map((s: PeekSession) => s.name), ["fresh-name"]);
});

test("重命名后不再匹配关键词的会话从列表移除，仍匹配的保持选中", async () => {
  const all = fixture();
  const c = make(all, "D:/nowhere");
  c.onRename = async () => true;
  type(c, "named-x");
  assert.equal(c.filtered.length, 1);
  c.handleInput(KEY.cr);
  c.renameInput.setValue("other");
  c.handleInput(KEY.enter);
  await tick();
  assert.equal(c.filtered.length, 0);

  const c2 = make(fixture(), "D:/nowhere");
  c2.onRename = async () => true;
  type(c2, "alpha");
  c2.handleInput(KEY.down);
  const target = c2.filtered[1];
  c2.handleInput(KEY.cr);
  c2.renameInput.setValue("still alpha");
  c2.handleInput(KEY.enter);
  await tick();
  assert.equal(c2.filtered[c2.selected], target);
});

test("重命名中 Esc / Ctrl+C 只取消重命名", () => {
  const c = make();
  let cancelled = 0;
  c.onCancel = () => cancelled++;
  c.onRename = async () => true;
  c.handleInput(KEY.cr);
  c.handleInput(KEY.esc);
  assert.equal(c.mode, "search");
  c.handleInput(KEY.cr);
  c.handleInput(KEY.cc);
  assert.equal(c.mode, "search");
  assert.equal(cancelled, 0);
});

test("焦点跟着活跃的输入框走", () => {
  const c = make();
  c.onRename = async () => true;
  c.focused = true;
  assert.equal(c.input.focused, true);
  assert.equal(c.renameInput.focused, false);
  c.handleInput(KEY.cr);
  assert.equal(c.input.focused, false);
  assert.equal(c.renameInput.focused, true);
  c.handleInput(KEY.esc);
  assert.equal(c.input.focused, true);
});

test("预览滚动：Ctrl+U / Ctrl+F，PgUp / PgDn，到边界夹住", () => {
  const long = mk("D:/proj", Array.from({ length: 60 }, (_, i) => `message number ${i} ${"x".repeat(80)}`), 999); // 最老，排序后落在最后
  const c = make([long], "D:/proj");
  c.render(120);
  const bottom = c.previewOffset;
  assert.ok(bottom > 0);
  c.handleInput(KEY.cu);
  const up = c.previewOffset;
  assert.ok(up < bottom);
  c.handleInput(KEY.cf);
  assert.equal(c.previewOffset, bottom);
  c.handleInput(KEY.cf);
  c.render(120);
  assert.equal(c.previewOffset, bottom);
  c.handleInput("\x1b[5~");
  assert.ok(c.previewOffset < bottom);
});

test("有关键词时预览定位到第一个命中，Ctrl+N / Ctrl+P 在命中间跳转并回绕", () => {
  const texts = Array.from({ length: 40 }, (_, i) => (i === 5 || i === 25 ? `hit ${i}` : `filler ${i}`));
  const c = make([mk("D:/proj", texts, 1)], "D:/proj", "hit");
  c.render(120);
  assert.equal(c.matchLines.length, 2);
  assert.equal(c.previewOffset, Math.max(0, c.matchLines[0] - 2));
  c.handleInput("\x0e");
  assert.equal(c.previewOffset, c.matchLines[1] - 2);
  c.handleInput("\x0e");
  assert.equal(c.previewOffset, Math.max(0, c.matchLines[0] - 2));
  c.handleInput("\x10");
  assert.equal(c.previewOffset, c.matchLines[1] - 2);
});

test("同一条消息里多处命中，每一行都是跳转点", () => {
  const body = Array.from({ length: 60 }, (_, i) => (i % 20 === 0 ? `hit line ${i}` : `filler ${i}`)).join("\n\n");
  const c = make([mk("D:/proj", ["question", body], 1)], "D:/proj", "hit");
  c.render(120);
  const lines: string[] = c.previewLines.map(strip);
  assert.deepEqual(
    c.matchLines,
    lines.map((l, i) => (l.includes("hit") ? i : -1)).filter((i) => i >= 0),
  );
  assert.equal(c.matchLines.length, 3);
  c.handleInput("\x0e");
  assert.equal(c.previewOffset, c.matchLines[1] - 2);
  c.handleInput("\x0e");
  assert.equal(c.previewOffset, c.matchLines[2] - 2);
});

test("Ctrl+N 跳过当前视口里的命中，Ctrl+P 同理", () => {
  // 第 0、1、2 行连着命中，再隔很远一个
  const body = ["hit a", "hit b", "hit c", ...Array.from({ length: 50 }, (_, i) => `filler ${i}`), "hit far"].join("\n\n");
  const c = make([mk("D:/proj", ["question", body], 1)], "D:/proj", "hit");
  c.render(120);
  const H = c.bodyHeight();
  assert.equal(c.matchLines.length, 4);
  assert.ok(c.matchLines[2] < c.previewOffset + H, "first three hits share the viewport");
  c.handleInput("\x0e");
  c.render(120);
  const maxOff = Math.max(0, c.previewLines.length - H);
  assert.equal(c.previewOffset, Math.min(c.matchLines[3] - 2, maxOff), "one Ctrl+N goes straight to the far hit");
  assert.ok(c.matchLines[3] >= c.previewOffset && c.matchLines[3] < c.previewOffset + H, "far hit is on screen");
  c.handleInput("\x10");
  c.render(120);
  assert.equal(c.previewOffset, c.matchLines[2] - 2, "Ctrl+P lands on the nearest hit above the viewport");
});

test("右上角显示命中序号，随跳转变化", () => {
  const body = ["hit a", ...Array.from({ length: 50 }, (_, i) => `filler ${i}`), "hit far"].join("\n\n");
  const c = make([mk("D:/proj", ["question", body], 1)], "D:/proj", "hit");
  let top = strip(c.render(120)[3]);
  assert.ok(top.includes("命中 1/2"), top);
  c.handleInput("\x0e");
  top = strip(c.render(120)[3]);
  assert.ok(top.includes("命中 2/2"), top);
});

test("关键词只命中会话名时预览给出提示", () => {
  const c = make(fixture(), "D:/nowhere", "named-x");
  const lines = c.render(120).map(strip).join("\n");
  assert.ok(lines.includes("对话正文无匹配"));
});

test("没有匹配时右栏提示", () => {
  const c = make(fixture(), "D:/nowhere", "zzzzzz");
  assert.equal(c.filtered.length, 0);
  assert.ok(c.render(120).map(strip).join("\n").includes("没有匹配的会话"));
});

test("每行宽度不超过给定宽度", () => {
  const c = make(fixture(), "D:/nowhere", "alpha");
  for (const w of [80, 100, 140]) {
    for (const line of c.render(w)) assert.ok(strip(line).length <= w, `width ${w}: ${strip(line).length}`);
  }
});

const MD_REPLY = [
  "问题在 **getHttpValue**，见 [文档](https://example.com/doc)。",
  "",
  "```ts",
  "const token = getHttpValue(res.headers);",
  "```",
  "",
  "| 文件 | 改动 |",
  "| --- | --- |",
  "| src/utils/http.ts | 读取移到 response 事件之后，并加了失败重试 |",
  "| src/views/login.vue | 换成同一个封装 |",
  "",
  "- 第一点",
  "- 第二点",
].join("\n");

function mdFixture() {
  return [mk("D:/proj", ["帮我看下 token 为什么是 undefined", MD_REPLY], 1)];
}

test("预览用 Markdown 渲染：表格画出边框且不超宽，代码块和列表保持结构", () => {
  const c = make(mdFixture(), "D:/proj");
  c.handleInput(KEY.cu);
  c.handleInput(KEY.cu);
  const width = 110;
  const lines = c.render(width).map(strip);
  const body = lines.slice(3, 3 + c.bodyHeight());
  assert.ok(body.every((l: string) => visibleWidth(l) === width), "every body row is full width");
  const right = c.previewLines.map(strip);
  assert.ok(right.some((l: string) => l.startsWith(" ┌") && l.includes("┬")), "table top border");
  assert.ok(right.some((l: string) => /^ │ 文件\s+│ 改动\s+│/.test(l)), "table header row");
  assert.ok(right.some((l: string) => l.includes("src/utils/http.ts") && l.includes("│")), "table cell");
  assert.ok(right.some((l: string) => l.trim() === "```ts"), "code fence");
  assert.ok(right.some((l: string) => l.trim() === "- 第一点"), "list item");
  assert.ok(!right.some((l: string) => l.includes("**")), "bold markers are consumed");
  assert.ok(!right.some((l: string) => l.includes("](")), "link syntax is consumed");
});

test("预览的关键词高亮在渲染之后叠加，不破坏表格和链接", () => {
  const c = make(mdFixture(), "D:/proj", "http");
  c.render(110);
  const raw: string[] = c.previewLines;
  const cell = raw.find((l) => strip(l).includes("src/utils/http.ts"))!;
  assert.ok(cell.includes("\x1b[1m\x1b[4m"), "keyword inside a table cell is highlighted");
  assert.ok(strip(cell).includes("│"), "cell borders survive");
  const link = raw.find((l) => strip(l).includes("文档"))!;
  assert.ok(link.includes("\x1b]8;;https://example.com/doc"), "hyperlink survives");
  assert.ok(!strip(link).includes("]("), "link syntax is consumed");
  // 命中按行记：正好是去掉样式后含关键词的那些行
  const expect = raw.map((l, i) => (strip(l).toLowerCase().includes("http") ? i : -1)).filter((i) => i >= 0);
  assert.ok(expect.length > 1);
  assert.deepEqual(c.matchLines, expect);
});

test("同一宽度下每条消息只渲染一次，换关键词也不重来", () => {
  const all = mdFixture();
  const c = make(all, "D:/proj");
  c.render(110);
  const first = c.rendered.get(all[0].msgs[1]).lines;
  type(c, "http");
  c.render(110);
  assert.equal(c.rendered.get(all[0].msgs[1]).lines, first);
  c.render(120);
  assert.notEqual(c.rendered.get(all[0].msgs[1]).lines, first);
});

test("主体高度为奇数时，最后一行的分隔线仍在同一列（右栏不会顶到左边）", () => {
  const long = mk("D:/proj", Array.from({ length: 80 }, (_, i) => `line ${i} ${"x".repeat(60)}`), 1);
  const saved = process.stdout.rows;
  Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true, writable: true });
  try {
    for (const termRows of [35, 36]) {
      const c: any = new PeekComponent([long], "D:/proj", theme, mdTheme, termRows, "");
      c.requestRender = () => {};
      const H = c.bodyHeight();
      assert.equal(H, termRows - 12);
      const width = 120;
      c.render(width);
      c.handleInput(KEY.cu);
      c.handleInput(KEY.cu);
      const lines = c.render(width).map(strip);
      const body = lines.slice(3, 3 + H);
      assert.equal(body.length, H);
      const cols = new Set(body.map((l: string) => l.indexOf("│")));
      assert.equal(cols.size, 1, `separator columns: ${[...cols].join(",")} (H=${H})`);
      assert.ok(body.every((l: string) => visibleWidth(l) === width), "every body row is full width");
    }
  } finally {
    Object.defineProperty(process.stdout, "rows", { value: saved, configurable: true, writable: true });
  }
});

// 搜索语法在组件里的整体效果：过滤、命中数、片段、高亮都按同一套规则
function cwds(q: string, all = fixture()): string[] {
  const c = make(all, "D:/nowhere");
  type(c, q);
  return c.filtered.map((s: PeekSession) => s.cwd);
}

test("搜索语法：短语、OR、排除、字段前缀、正则都能过滤", () => {
  assert.deepEqual(cwds('"alpha beta"'), ["D:/proj"]); // "beta alpha" 顺序不对，不算
  assert.deepEqual(cwds("alpha -beta"), ["D:/proj/packages/web"]);
  assert.deepEqual(cwds("gamma|only"), ["D:/proj/packages/web", "D:/projX"]);
  assert.deepEqual(cwds("name:other"), ["D:/other"]);
  assert.deepEqual(cwds("dir:projx"), ["D:/projX"]);
  assert.deepEqual(cwds("ai:reply"), ["D:/proj"]);
  assert.deepEqual(cwds("user:reply"), []);
  assert.deepEqual(cwds("/alph[a]\\s+(beta|only)/"), ["D:/proj", "D:/proj/packages/web"]);
  assert.deepEqual(cwds("-ai:reply -gamma @30d"), ["D:/proj/packages/web"]);
});

test("只有排除词或 name: / dir: 时列表不显示命中数和片段，预览不高亮也不提示", () => {
  const c = make(fixture(), "D:/nowhere");
  type(c, "-gamma name:other");
  assert.deepEqual(c.filtered.map((s: PeekSession) => s.cwd), ["D:/other"]);
  const rows = c.render(120).map(strip);
  assert.ok(!/·\d/.test(rows[3]), rows[3]);
  assert.ok(rows[4].includes("beta alpha  [other-name]"), rows[4]);
  assert.equal(c.matchLines.length, 0);
  assert.ok(!rows.join("\n").includes("对话正文无匹配"));
});

test("ai: 的词只在 AI 回复里计数、截片段和高亮，user: 同理", () => {
  const all = [mk("D:/proj", ["alpha asks", "alpha answers", "alpha again"], 1)];
  const c = make(all, "D:/proj");
  type(c, "ai:alpha");
  let rows = c.render(120);
  assert.ok(strip(rows[3]).includes("·1"), strip(rows[3]));
  assert.ok(strip(rows[4]).includes("alpha answers"), strip(rows[4]));
  assert.ok(rows[4].includes("\x1b[1m\x1b[4m"), "snippet is highlighted");
  const hit = c.previewLines.filter((l: string) => l.includes("\x1b[1m\x1b[4m")).map((l: string) => strip(l).trim());
  assert.deepEqual(hit, ["alpha answers"]);
  assert.equal(c.matchLines.length, 1);

  c.input.setValue("user:alpha");
  c.refilter();
  c.invalidate();
  rows = c.render(120);
  assert.ok(strip(rows[3]).includes("·2"), strip(rows[3]));
  assert.deepEqual(
    c.previewLines.filter((l: string) => l.includes("\x1b[1m\x1b[4m")).map((l: string) => strip(l).trim()),
    ["alpha asks", "alpha again"],
  );
});

test("短语和正则在预览里整段高亮，排除词不高亮", () => {
  const all = [mk("D:/proj", ["find the get http value", "getHttpValue is here, draft"], 1)];
  const c = make(all, "D:/proj");
  type(c, '"get http" /gethttp\\w+/ -zzz');
  c.render(120);
  const hit = c.previewLines.filter((l: string) => l.includes("\x1b[1m\x1b[4m"));
  assert.equal(hit.length, 2);
  assert.ok(hit[0].includes(`\x1b[1m\x1b[4mget http\x1b[24m`), hit[0]);
  assert.ok(hit[1].includes(`\x1b[1m\x1b[4mgetHttpValue\x1b[24m`), hit[1]);
});

// 预览右栏去掉样式后的文字行
function rightCol(c: any, width = 100): string[] {
  c.render(width);
  return c.previewLines.map(strip);
}

function toolFixture(): PeekSession[] {
  const s = mk("D:/proj", ["fix the bug", "let me look", "done, fixed"], 1);
  s.msgs[1].tools = [{ name: "read", summary: "src/a.ts" }];
  // 只有工具调用、没写字的 AI 轮次，紧接在上一条 AI 文字后面
  s.msgs.splice(2, 0, { role: "assistant", text: "", tools: [{ name: "bash", summary: "npm test" }, { name: "edit", summary: "" }] });
  s.msgs[3].role = "assistant";
  return [s];
}

test("工具调用默认不显示，只有工具调用的 AI 轮次整条跳过", () => {
  const c = make(toolFixture(), "D:/proj");
  const lines = rightCol(c);
  assert.ok(!lines.some((l) => l.includes("⚙")));
  assert.equal(lines.filter((l) => l.startsWith("🤖 AI")).length, 2);
  assert.ok(lines.some((l) => l.includes("let me look")));
  assert.ok(lines.some((l) => l.includes("done, fixed")));
});

test("Ctrl+T 显示工具调用摘要，纯工具轮次接在上一条 AI 正文下面不重复标签，再按一次关掉", () => {
  const c = make(toolFixture(), "D:/proj");
  c.handleInput(KEY.ct);
  const lines = rightCol(c);
  const tools = lines.filter((l) => l.includes("⚙")).map((l) => l.trim());
  assert.deepEqual(tools, ["⚙ read  src/a.ts", "⚙ bash  npm test", "⚙ edit"]);
  assert.equal(lines.filter((l) => l.startsWith("🤖 AI")).length, 2);
  // 顺序：AI 标签 → 正文 → read → bash → edit → 空行 → AI 标签 → done
  const look = lines.findIndex((l) => l.includes("let me look"));
  const edit = lines.findIndex((l) => l.includes("⚙ edit"));
  const done = lines.findIndex((l) => l.includes("done, fixed"));
  assert.ok(look < edit && edit < done);
  assert.equal(lines[edit + 1], "");
  assert.ok(lines[edit + 2].startsWith("🤖 AI"));
  c.handleInput(KEY.ct);
  assert.ok(!rightCol(c).some((l) => l.includes("⚙")));
});

test("工具摘要不参与搜索和高亮", () => {
  const c = make(toolFixture(), "D:/proj");
  c.handleInput(KEY.ct);
  type(c, "npm");
  assert.equal(c.filtered.length, 0);
  type(c, KEY.bs + KEY.bs + KEY.bs);
  type(c, "fixed");
  assert.equal(c.filtered.length, 1);
  rightCol(c);
  assert.equal(c.matchLines.length, 1);
});

// 鼠标：坐标以组件左上角为原点，第 0 行标题、第 1 行搜索框、第 2 行分隔线，第 3 行起是双栏
const MOUSE = (type: "press" | "click" | "wheel" | "release" | "drag", x: number, y: number, extra: Record<string, unknown> = {}) => ({
  type,
  button: type === "wheel" ? "none" : "left",
  x,
  y,
  screenX: x,
  screenY: y,
  width: 120,
  height: 40,
  shift: false,
  alt: false,
  ctrl: false,
  ...extra,
});

test("鼠标：没画过之前不处理；左栏按下选中，同一项再按不重画，双击进入，单击不进入", () => {
  const c = make(fixture(), "D:/nowhere");
  assert.equal(c.handleMouse(MOUSE("press", 2, 5)), undefined);
  c.render(120);
  const lw = c.layout.lw;
  assert.equal(lw, 48);
  const got: string[] = [];
  c.onResume = (s: PeekSession) => got.push(s.cwd);
  // 第 3 项占主体第 4、5 行，即组件第 7、8 行
  assert.deepEqual(c.handleMouse(MOUSE("press", 2, 8)), { handled: true, capture: true, render: true });
  assert.equal(c.selected, 2);
  assert.deepEqual(c.handleMouse(MOUSE("press", lw - 1, 7)), { handled: true, capture: true, render: false });
  assert.equal(c.selected, 2);
  c.handleMouse(MOUSE("click", 2, 8, { clickCount: 1 }));
  assert.deepEqual(got, []);
  c.handleMouse(MOUSE("click", 2, 8, { clickCount: 2 }));
  assert.deepEqual(got, ["D:/projX"]);
  // 列表下面的空白行和右栏按下也接管（可能是拖选的起点），但不改选中项
  assert.deepEqual(c.handleMouse(MOUSE("press", 2, 3 + 8)), { handled: true, capture: true, render: false });
  assert.deepEqual(c.handleMouse(MOUSE("release", 2, 3 + 8)), { handled: true, render: false });
  assert.deepEqual(c.handleMouse(MOUSE("press", lw + 5, 5)), { handled: true, capture: true, render: false });
  c.handleMouse(MOUSE("release", lw + 5, 5));
  assert.equal(c.handleMouse(MOUSE("release", 2, 8)), undefined); // 没按下就松开，不管
  assert.equal(c.selected, 2);
});

test("鼠标：左栏滚轮只滚视图，选中项不动并到边界夹住；↑↓ 把选中项带回视野；右栏滚轮滚预览三行一格", () => {
  const long = mk("D:/proj", Array.from({ length: 60 }, (_, i) => `message number ${i} ${"x".repeat(80)}`), 999); // 最老，排序后落在最后
  const probe = make([long], "D:/nowhere");
  const visible = visibleItems(probe.bodyHeight()); // 可见项数按当前终端高度现算
  const many = Array.from({ length: visible + 6 }, (_, i) => mk(`D:/dir${i}`, [`item ${i}`], i + 1));
  const c = make([...many, long], "D:/nowhere");
  c.render(120);
  const lw = c.layout.lw;
  assert.equal(c.listOffset, 0);
  assert.deepEqual(c.handleMouse(MOUSE("wheel", 2, 5, { wheelDelta: 1 })), { handled: true, render: true });
  assert.equal(c.listOffset, 1);
  assert.equal(c.selected, 0, "selection stays");
  c.render(120);
  assert.equal(c.listOffset, 1, "render does not snap back to the selection");
  assert.ok(!c.render(120).slice(3, 3 + c.layout.H).some((l: string) => strip(l).startsWith("›")), "selected item scrolled out of view");
  c.handleMouse(MOUSE("wheel", 2, 5, { wheelDelta: 99 }));
  assert.equal(c.listOffset, 7, "clamped so the last item is visible");
  c.handleMouse(MOUSE("wheel", 2, 5, { wheelDelta: -999 }));
  assert.equal(c.listOffset, 0);
  assert.deepEqual(c.handleMouse(MOUSE("wheel", 2, 5, { wheelDelta: -1 })), { handled: true, render: false });
  c.handleMouse(MOUSE("wheel", 2, 5, { wheelDelta: 99 }));
  c.handleInput(KEY.down);
  c.render(120);
  assert.equal(c.selected, 1);
  assert.equal(c.listOffset, 1, "arrow key brings the selection back into view");

  // 右栏：先把视图滚到底，最后一项（long）在主体第 2*(visible-1) 行，点它
  c.handleMouse(MOUSE("wheel", 2, 5, { wheelDelta: 99 }));
  assert.equal(c.listOffset, 7);
  c.handleMouse(MOUSE("press", 2, 3 + 2 * (visible - 1)));
  c.render(120);
  assert.equal(c.selected, visible + 6);
  assert.equal(c.listOffset, 7, "click inside the view does not scroll");
  const bottom = c.previewOffset;
  assert.ok(bottom > 6);
  assert.deepEqual(c.handleMouse(MOUSE("wheel", lw + 10, 5, { wheelDelta: -1 })), { handled: true, render: true });
  assert.equal(c.previewOffset, bottom - 3);
  c.handleMouse(MOUSE("wheel", lw + 10, 5, { wheelDelta: 5 }));
  c.render(120);
  assert.equal(c.previewOffset, bottom, "clamped at the end");
  c.handleMouse(MOUSE("wheel", lw + 10, 5, { wheelDelta: -999 }));
  assert.equal(c.previewOffset, 0);
  assert.equal(c.selected, visible + 6, "preview wheel leaves the selection alone");
});

test("鼠标：点头部的范围字样切换范围，点别处不管；点搜索框移动光标", () => {
  const c = make();
  c.render(120);
  assert.equal(c.scope, "current");
  const scope = c.headHits.find((h: any) => h.act === "scope");
  assert.ok(scope.from > 0 && scope.to > scope.from);
  assert.deepEqual(c.handleMouse(MOUSE("press", scope.from, 0)), { handled: true, render: true });
  assert.equal(c.scope, "all");
  c.handleMouse(MOUSE("press", scope.to - 1, 0));
  assert.equal(c.scope, "current");
  assert.equal(c.handleMouse(MOUSE("press", scope.from - 1, 0)), undefined); // 标题上点不动
  assert.equal(c.scope, "current");

  type(c, "abc");
  assert.equal(c.input.cursor, 3);
  assert.deepEqual(c.handleMouse(MOUSE("press", 3, 1)), { handled: true, render: true });
  assert.equal(c.input.cursor, 1);
  assert.equal(c.selected, 0);
});

test("鼠标：删除确认中按一下就取消；改名中滚轮只滚列表不换会话，点改名行移动光标", () => {
  const c = make();
  c.onDelete = async () => true;
  c.onRename = async () => true;
  c.render(120);
  c.handleInput(KEY.cd);
  assert.equal(c.mode, "confirmDelete");
  assert.deepEqual(c.handleMouse(MOUSE("press", c.layout.lw + 5, 5)), { handled: true, capture: true, render: true });
  assert.equal(c.mode, "search");

  c.handleInput(KEY.cr);
  c.renameInput.setValue("hello");
  c.handleMouse(MOUSE("wheel", 2, 5, { wheelDelta: 1 }));
  assert.equal(c.selected, 0);
  c.handleMouse(MOUSE("click", 2, 3, { clickCount: 2 }));
  assert.equal(c.mode, "rename");
  const lastRow = 3 + c.layout.H + 1;
  const prefixW = visibleWidth("✏ 重命名: ");
  assert.deepEqual(c.handleMouse(MOUSE("press", prefixW + 2 + 2, lastRow)), { handled: true, render: true });
  assert.equal(c.renameInput.cursor, 2);
});

test("cursorRow：没焦点时不知道，搜索框在第 1 行，改名时在最后一行；render 每次都通知 afterRender", () => {
  const c = make();
  c.onRename = async () => true;
  let notified = 0;
  c.afterRender = () => notified++;
  assert.equal(c.cursorRow(), undefined);
  c.render(120);
  assert.equal(notified, 1);
  c.render(120); // 缓存命中也要通知：组件在屏幕上的位置可能变了
  assert.equal(notified, 2);
  assert.equal(c.cursorRow(), undefined);
  c.focused = true;
  assert.equal(c.cursorRow(), 1);
  c.handleInput(KEY.cr);
  assert.equal(c.cursorRow(), 3 + c.layout.H + 1);
  c.handleInput(KEY.esc);
  assert.equal(c.cursorRow(), 1);
});

// 拖选：按下 → 拖动 → 松开，只高亮不复制；Ctrl+C 复制
const drag = (c: any, x0: number, y0: number, x1: number, y1: number) => {
  c.handleMouse(MOUSE("press", x0, y0));
  c.handleMouse({ ...MOUSE("press", x1, y1), type: "drag" });
  c.handleMouse(MOUSE("release", x1, y1));
};
const INV = "\x1b[7m";
// 主体里带反显的行号（搜索框的光标也是反显，不算）
const hlRows = (c: any, width = 120): number[] =>
  c.render(width).map((l: string, i: number) => (i >= 3 && i < 3 + c.layout.H && l.includes(INV) ? i : -1)).filter((i: number) => i >= 0);

function longFixture() {
  const texts = Array.from({ length: 30 }, (_, i) => `line ${String(i).padStart(2, "0")} ${"abcdefghij".repeat(6)}`);
  return [mk("D:/proj", texts, 1), mk("D:/other", ["other one", "reply"], 2)];
}

test("拖选：右栏拖出的选区只在右栏，首行从起点起、中间整行、末行到终点；松开不复制，Ctrl+C 才复制并清掉高亮", async () => {
  const c = make(longFixture(), "D:/nowhere");
  const copied: string[] = [];
  c.onCopy = async (t: string) => (copied.push(t), true);
  let cancelled = 0;
  c.onCancel = () => cancelled++;
  c.render(120);
  const { lw, rw, H } = c.layout;
  const x0 = lw + 3;
  c.handleInput(KEY.cu);
  c.handleInput(KEY.cu);
  c.render(120);
  const top = c.previewOffset;
  const raw: string[] = c.previewLines.map(strip);
  // 从第 2 行第 4 列拖到第 4 行第 8 列（都是主体行号）
  const r = c.handleMouse(MOUSE("press", x0 + 4, 3 + 2));
  assert.deepEqual(r, { handled: true, capture: true, render: false });
  assert.deepEqual(hlRows(c), [], "no highlight before dragging");
  c.handleMouse({ ...MOUSE("press", x0 + 8, 3 + 4), type: "drag" });
  assert.deepEqual(c.handleMouse(MOUSE("release", x0 + 8, 3 + 4)), { handled: true, render: false });
  assert.equal(copied.length, 0, "release does not copy");
  const lines = c.render(120);
  const hl = hlRows(c);
  assert.deepEqual(hl, [3 + 2, 3 + 3, 3 + 4]);
  // 高亮只在右栏：分隔线左边没有反显
  for (const i of hl) {
    const line = lines[i];
    assert.ok(line.indexOf(INV) > line.indexOf("│"), "highlight starts after the separator");
  }
  assert.ok(strip(lines.at(-1)).includes("已选 3 行"), strip(lines.at(-1)));
  c.handleInput(KEY.cc);
  await tick();
  assert.equal(cancelled, 0, "Ctrl+C with a selection copies instead of closing");
  assert.deepEqual(copied, [[raw[top + 2].slice(4).trimEnd(), raw[top + 3].trimEnd(), raw[top + 4].slice(0, 9).trimEnd()].join("\n")]);
  assert.deepEqual(hlRows(c), [], "highlight cleared after copy");
  assert.ok(strip(c.render(120).at(-1)).includes("已复制 3 行"));
  c.handleInput(KEY.cc);
  assert.equal(cancelled, 1, "Ctrl+C without a selection closes");
  assert.ok(rw > 20 && H > 0);
});

test("拖选：左栏的选区不会跨到右栏，拖到右栏也只选左栏的字；文字来自列表行", async () => {
  const c = make(longFixture(), "D:/nowhere");
  const copied: string[] = [];
  c.onCopy = async (t: string) => (copied.push(t), true);
  const lines0 = c.render(120);
  const { lw } = c.layout;
  drag(c, 2, 3, lw + 20, 4 + 3); // 从第 1 项第一行拖到右栏
  const lines = c.render(120);
  for (const i of [3, 4, 5, 6, 7]) {
    const line = lines[i];
    assert.ok(line.includes(INV), `row ${i} highlighted`);
    assert.ok(line.indexOf("\x1b[27m") < line.indexOf("│"), `row ${i}: highlight ends before the separator`);
  }
  assert.ok(!lines[8].includes(INV));
  c.handleInput(KEY.cc);
  await tick();
  const left = lines0.slice(3, 8).map((l: string) => strip(l).slice(0, lw));
  const want = [left[0].slice(2).trimEnd(), ...left.slice(1, 4).map((l: string) => l.trimEnd()), left[4].slice(0, lw).trimEnd()].join("\n");
  assert.deepEqual(copied, [want]);
  assert.ok(copied[0].includes("proj"));
  assert.ok(!copied[0].includes("│"));
});

test("拖选：往上拖也行；单击不留选区；再按一下清掉选区；换会话、打字、Ctrl+T 都清掉", () => {
  const c = make(longFixture(), "D:/nowhere");
  c.render(120);
  const x0 = c.layout.lw + 3;
  drag(c, x0 + 5, 3 + 5, x0 + 1, 3 + 2);
  assert.equal(hlRows(c).length, 4);
  assert.deepEqual(c.handleMouse(MOUSE("press", x0 + 1, 3 + 1)), { handled: true, capture: true, render: true });
  c.handleMouse(MOUSE("release", x0 + 1, 3 + 1));
  assert.equal(hlRows(c).length, 0);
  assert.equal(c.drag.sel, undefined);

  drag(c, x0 + 5, 3 + 5, x0 + 1, 3 + 2);
  c.handleInput(KEY.down);
  assert.equal(hlRows(c).length, 0);
  drag(c, x0 + 5, 3 + 5, x0 + 1, 3 + 2);
  type(c, "x");
  assert.equal(c.drag.sel, undefined);
  c.handleInput(KEY.bs);
  drag(c, x0 + 5, 3 + 5, x0 + 1, 3 + 2);
  c.handleInput(KEY.ct);
  assert.equal(c.drag.sel, undefined);
  // 预览滚动不清选区，高亮跟着内容走
  c.render(120); // 按键之后先画一帧，鼠标坐标才对得上当前的预览位置
  drag(c, x0 + 5, 3 + 5, x0 + 1, 3 + 2);
  const before = hlRows(c)[0];
  assert.equal(before, 3 + 2);
  c.handleInput("\x1b[1;2A"); // Shift+↑ 滚三行
  const after = hlRows(c)[0];
  assert.equal(after, before + 3);
});

test("拖选：右栏拖出下边自动滚动，焦点跟到最后一行；松开停下", async () => {
  const c = make(longFixture(), "D:/nowhere");
  c.render(120);
  const { lw, H } = c.layout;
  const x0 = lw + 3;
  c.handleInput(KEY.cu);
  c.handleInput(KEY.cu);
  c.handleInput(KEY.cu);
  c.render(120);
  const top = c.previewOffset;
  assert.ok(top + H < c.previewLines.length - 5, "room to scroll");
  c.handleMouse(MOUSE("press", x0 + 2, 3 + 2));
  c.handleMouse({ ...MOUSE("press", x0 + 2, 3 + H + 1), type: "drag" }); // 拖到主体下面
  assert.equal(c.drag.autoScrollDir, 1);
  await tick(130);
  assert.ok(c.previewOffset > top, "scrolled down");
  assert.equal(c.drag.sel.focus.row, c.previewOffset + H - 1, "focus follows the bottom row");
  c.handleMouse(MOUSE("release", x0 + 2, 3 + H + 1));
  const stopped = c.previewOffset;
  await tick(130);
  assert.equal(c.previewOffset, stopped, "stops on release");
  assert.equal(c.drag.autoScrollTimer, undefined);
  c.dispose();
});

test("dispose 停掉计时器并调 onDispose", () => {
  const c = make();
  let disposed = 0;
  c.onDispose = () => disposed++;
  c.render(120);
  c.dispose();
  assert.equal(disposed, 1);
});


test("unchanged-query repaint, preview scroll and selection reuse list body analysis", () => {
  const all = [mk("D:/proj", ["alpha beta", "reply"], 1), mk("D:/proj", ["other alpha"], 2)];
  let reads = 0;
  Object.defineProperty(all[0].msgs[0], "text", { get: () => { reads++; return "alpha beta"; } });
  const c = make(all, "D:/proj", "alpha");
  c.render(120);
  const firstReads = reads;
  c.invalidate();
  c.render(120);
  c.handleInput(KEY.cf);
  c.render(120);
  c.handleInput(KEY.down);
  c.render(120);
  assert.equal(reads, firstReads, "non-query redraws must not reread the first session body");
  c.handleInput("\x05"); // Ctrl+E: initial setValue leaves the cursor at the beginning.
  type(c, " beta");
  const rows = c.render(120).map(strip);
  assert.ok(reads > firstReads, "editing the query must refresh match analysis");
  assert.equal(c.filtered.length, 1);
  assert.ok(rows.some((r: string) => r.includes("alpha beta")));
  c.dispose();
});

// 懒加载：/peek 先用占位项画出列表，后台解析完一批就用 mergeLoaded 原地填充
function pending(path: string, mtime: number): PeekSession {
  return { path, cwd: "", time: new Date(mtime).toISOString(), name: "", first: "", msgs: [], mtime, size: 0, pending: true };
}

function parsed(path: string, cwd: string, texts: string[], mtime: number): PeekSession {
  return {
    path,
    cwd,
    time: new Date(mtime).toISOString(),
    name: "",
    first: texts[0],
    msgs: texts.map((text, i) => ({ role: i % 2 ? "assistant" : "user", text })),
    mtime,
    size: 0,
  };
}

test("懒加载：占位项先列出，分批填充时保留选中项，选中项载入后才重建预览", () => {
  const t0 = Date.now();
  const a = pending("/a.jsonl", t0);
  const b = pending("/b.jsonl", t0 - 1000);
  const c = make([a, b], "D:/nowhere");
  const rows = c.render(120).map(strip);
  assert.ok(rows[0].includes("载入中 2"));
  assert.ok(rows[3].includes("正在载入会话"));

  c.handleInput(KEY.down);
  assert.equal(c.selected, 1);
  c.render(120);
  const key = c.previewKey;
  assert.ok(key.includes("/b.jsonl"));

  // 先载入没选中的那条：列表保持选中 /b，预览不能被打回重建
  c.mergeLoaded([parsed("/a.jsonl", "D:/other", ["alpha"], t0)]);
  assert.equal(c.selected, 1);
  assert.equal(c.filtered[1], b);
  assert.equal(a.pending, undefined);
  assert.equal(b.pending, true);
  assert.equal(c.previewKey, key);
  assert.ok(c.render(120).map(strip)[0].includes("载入中 1"));

  // 选中的载入：预览重建，显示解析出来的内容
  c.mergeLoaded([parsed("/b.jsonl", "D:/other", ["beta"], t0 - 1000)]);
  assert.equal(c.selected, 1);
  assert.notEqual(c.previewKey, key);
  const out = c.render(120).map(strip);
  assert.ok(out.some((l: string) => l.includes("beta")));
  assert.ok(!out[0].includes("载入中"));
});

test("懒加载：有关键词时占位项先不列，命中随批次补进来", () => {
  const t0 = Date.now();
  const a = pending("/a.jsonl", t0);
  const b = pending("/b.jsonl", t0 - 1000);
  const c = make([a, b], "D:/nowhere", "alpha");
  assert.equal(c.filtered.length, 0);
  let rows = c.render(120).map(strip);
  assert.ok(rows[0].includes("匹配 0/2"));
  assert.ok(rows[0].includes("载入中 2"));

  c.mergeLoaded([parsed("/a.jsonl", "D:/other", ["beta"], t0)]);
  assert.equal(c.filtered.length, 0, "没有命中的已载入项不能混进来");
  c.mergeLoaded([parsed("/b.jsonl", "D:/other", ["alpha"], t0 - 1000)]);
  assert.equal(c.filtered.length, 1);
  assert.equal(c.filtered[0].path, "/b.jsonl");
  rows = c.render(120).map(strip);
  assert.ok(rows[0].includes("匹配 1/2"));
  assert.ok(rows[0].includes("载入中 0") === false);
});

test("懒加载：第一批当前目录树会话到了自动切范围，Tab 之后不再自动切", () => {
  const t0 = Date.now();
  const c = make([pending("/a.jsonl", t0), pending("/b.jsonl", t0 - 1000)], "D:/proj");
  assert.equal(c.scope, "all", "占位项还不知道 cwd，先按全局画");
  c.mergeLoaded([parsed("/a.jsonl", "D:/proj/sub", ["x"], t0)]);
  assert.equal(c.scope, "current");
  assert.equal(c.filtered.length, 1);

  const d = make([pending("/a.jsonl", t0), pending("/b.jsonl", t0 - 1000)], "D:/proj");
  d.handleInput(KEY.tab);
  d.handleInput(KEY.tab); // 用户自己切回全局
  assert.equal(d.scope, "all");
  d.mergeLoaded([parsed("/a.jsonl", "D:/proj/sub", ["x"], t0)]);
  assert.equal(d.scope, "all", "用户手动选过的范围不能被自动切换覆盖");
  assert.equal(d.filtered.length, 2);
});

test("懒加载：删除占位项后，晚到的解析结果不会把它加回来", async () => {
  const c = make([pending("/gone.jsonl", Date.now())], "D:/nowhere");
  c.onDelete = async () => true;
  c.handleInput(KEY.cd);
  c.handleInput("y");
  await tick();
  assert.equal(c.all.length, 0);
  assert.equal(c.filtered.length, 0);
  c.mergeLoaded([parsed("/gone.jsonl", "D:/other", ["late"], Date.now())]);
  assert.equal(c.all.length, 0);
  assert.equal(c.filtered.length, 0);
});

test("懒加载：占位项不能改名，但 Enter / Ctrl+O 可以直接用路径", () => {
  const c = make([pending("/a.jsonl", Date.now())], "D:/nowhere");
  c.onRename = () => {
    throw new Error("placeholder must not be renamed");
  };
  c.handleInput(KEY.cr);
  assert.equal(c.mode, "search");

  const got: string[] = [];
  c.onResume = (s: PeekSession) => got.push("resume:" + s.path);
  c.onFork = (s: PeekSession) => got.push("fork:" + s.path);
  c.handleInput(KEY.enter);
  c.handleInput(KEY.co);
  assert.deepEqual(got, ["resume:/a.jsonl", "fork:/a.jsonl"]);
});

test("懒加载：没有正文的文件用 dropSession 从列表移除", () => {
  const t0 = Date.now();
  const a = pending("/a.jsonl", t0);
  const b = pending("/b.jsonl", t0 - 1000);
  const c = make([a, b], "D:/nowhere");
  c.dropSession(a.path);
  assert.equal(c.all.length, 1);
  assert.equal(c.all[0], b);
  assert.equal(c.filtered.length, 1);
  c.handleInput(KEY.down); // 已经只剩一项，不能再往下
  assert.equal(c.selected, 0);
  c.dropSession("/not-there.jsonl"); // 不存在也不能出问题
  assert.equal(c.all.length, 1);
});

test("懒加载：只有 pin 过滤时也不列占位项，解析后只补置顶的", () => {
  const t0 = Date.now();
  const a = pending("/a.jsonl", t0);
  const b = pending("/b.jsonl", t0 - 1000);
  const c = make([a, b], "D:/nowhere", "pinned:true");
  assert.equal(c.filtered.length, 0);

  c.mergeLoaded([parsed("/a.jsonl", "D:/other", ["alpha"], t0)]);
  assert.equal(c.filtered.length, 0, "未置顶的会话不能混进来");
  c.mergeLoaded([{ ...parsed("/b.jsonl", "D:/other", ["beta"], t0 - 1000), pinned: true }]);
  assert.equal(c.filtered.length, 1);
  assert.equal(c.filtered[0].path, "/b.jsonl");
});

test("Alt+S：最近提问 / 创建时间切换，头部字样和列表顺序跟着变，点头部也能切", () => {
  const a = mk("D:/other", ["asked lately"], 10); // 10 天前建，1 天前提问
  a.lastPrompt = Date.now() - 86400e3;
  const b = mk("D:/other", ["created lately"], 2); // 2 天前建，没提问记录 → 退回 mtime
  const c = make([a, b], "D:/nowhere");
  const order = () => c.filtered.map((s: PeekSession) => s.first);
  assert.equal(c.sort, "prompt");
  assert.deepEqual(order(), ["asked lately", "created lately"]);
  assert.ok(c.render(120).map(strip)[0].includes("排序: 提问"));

  c.handleInput(ALT("s"));
  assert.equal(c.sort, "created");
  assert.deepEqual(order(), ["created lately", "asked lately"]);
  assert.ok(c.render(120).map(strip)[0].includes("排序: 创建"));

  const chip = c.headHits.find((h: any) => h.act === "sort");
  assert.deepEqual(c.handleMouse(MOUSE("press", chip.from, 0)), { handled: true, render: true });
  assert.equal(c.sort, "prompt");
});

test("Alt+D / draft:true：只看草稿，和输入框里的条件、置顶开关都是 AND，点头部也能切", () => {
  const draft = { ...mk("D:/other", ["parked idea"], 1), draft: true };
  const normal = mk("D:/other", ["finished"], 2);
  const c = make([draft, normal], "D:/nowhere");
  assert.equal(c.filtered.length, 2);

  c.handleInput(ALT("d"));
  assert.deepEqual(c.filtered.map((s: PeekSession) => s.first), ["parked idea"]);
  assert.ok(c.render(120).map(strip)[0].includes("草稿: 仅草稿"));

  c.handleInput(ALT("d"));
  assert.equal(c.filtered.length, 2);
  assert.ok(c.render(120).map(strip)[0].includes("草稿: 全部"));

  // 输入框里写 draft:false 和 Alt+D 同时生效 → 没有会话
  const d = make([draft, normal], "D:/nowhere", "draft:false");
  assert.deepEqual(d.filtered.map((s: PeekSession) => s.first), ["finished"]);
  d.handleInput(ALT("d"));
  assert.equal(d.filtered.length, 0);

  const e = make([draft, normal], "D:/nowhere");
  assert.deepEqual(e.headHits, [], "还没 render 就没有可点区域");
  e.render(120);
  const eChip = e.headHits.find((h: any) => h.act === "draft");
  assert.deepEqual(e.handleMouse(MOUSE("press", eChip.from, 0)), { handled: true, render: true });
  assert.equal(e.filtered.length, 1);
});

test("Alt+P：只看置顶，再按一次取消，和输入框里的 pin: 条件是 AND", () => {
  const t0 = Date.now();
  const pinned = { ...parsed("/a.jsonl", "D:/other", ["alpha"], t0), pinned: true };
  const plain = parsed("/b.jsonl", "D:/other", ["beta"], t0 - 1000);
  const c = make([pinned, plain], "D:/nowhere");
  assert.equal(c.filtered.length, 2);

  c.handleInput(KEY.ap);
  assert.equal(c.filtered.length, 1);
  assert.equal(c.filtered[0].path, "/a.jsonl");
  assert.ok(c.render(120).map(strip)[0].includes("置顶: 仅置顶"));

  c.handleInput(KEY.ap);
  assert.equal(c.filtered.length, 2);
  assert.ok(c.render(120).map(strip)[0].includes("置顶: 全部"));

  // 输入框里的 pin:false 和 Alt+P 同时生效 → 没有会话
  const d = make([pinned, plain], "D:/nowhere", "pin:false");
  assert.equal(d.filtered.length, 1);
  d.handleInput(KEY.ap);
  assert.equal(d.filtered.length, 0);
});

// ---- 右键菜单：点会话弹菜单，菜单里能进入 / 分叉 / 改名 / 置顶 / 拷路径 / 删除 ----

const RMOUSE = (type: "press" | "release" | "drag" | "click", x: number, y: number) => ({ ...MOUSE(type, x, y), button: "right" });

test("右键：原地按下松开弹菜单，选中被点的会话；拖开再松不弹；点空白也不弹", () => {
  const c = make(fixture(), "D:/nowhere");
  c.render(120);
  const lw = c.layout.lw;
  // 第 3 项在主体第 4、5 行 → 组件第 7、8 行
  assert.deepEqual(c.handleMouse(RMOUSE("press", 2, 8)), { handled: true, render: false });
  assert.equal(c.menu, undefined, "press alone does not open the menu");
  assert.deepEqual(c.handleMouse(RMOUSE("release", 2, 8)), { handled: true, render: true });
  assert.equal(c.menu?.session.cwd, "D:/projX");
  assert.equal(c.selected, 2, "right click also moves the selection");
  // 左键点在菜单盒子里面：按那一项执行（第一项是进入对话），菜单关掉
  const opened: string[] = [];
  c.onResume = (sess: PeekSession) => opened.push(sess.cwd);
  c.render(120);
  const box = c.menuBox!;
  const firstItemY = 3 + box.top + 1; // 第一行是上边框
  c.handleMouse(MOUSE("press", box.left + 2, firstItemY));
  c.handleMouse(MOUSE("release", box.left + 2, firstItemY));
  assert.equal(c.menu, undefined);
  assert.deepEqual(opened, ["D:/projX"], "first item opens the session");

  c.handleMouse(RMOUSE("press", 2, 8));
  c.handleMouse(RMOUSE("drag", 2, 13)); // 走开超过 3 行才算拖动
  c.handleMouse(RMOUSE("release", 2, 13));
  assert.equal(c.menu, undefined, "dragging does not open the menu");

  c.handleMouse(RMOUSE("press", 2, 3 + 8)); // 列表下面的空白
  c.handleMouse(RMOUSE("release", 2, 3 + 8));
  assert.equal(c.menu, undefined);
  assert.deepEqual(c.handleMouse(RMOUSE("press", lw + 5, 5)), { handled: true, render: false });
  assert.deepEqual(c.handleMouse(RMOUSE("release", lw + 5, 5)), { handled: true, render: false });
  assert.equal(c.menu, undefined, "right click in the preview does nothing");
});

test("右键菜单：画在左栏里，↑↓ 换项，Enter 执行进入；Esc 和任何别的键都关闭", () => {
  const c = make(fixture(), "D:/nowhere");
  const opened: string[] = [];
  c.onResume = (s: PeekSession) => opened.push("open:" + s.cwd);
  c.onFork = (s: PeekSession) => opened.push("fork:" + s.cwd);
  c.render(120);
  c.handleMouse(RMOUSE("press", 2, 8));
  c.handleMouse(RMOUSE("release", 2, 8));
  const rows = c.render(120).map(strip);
  // 菜单盒子的顶边盖住了那一项的第一行，底部提示换成菜单的按键说明
  // 菜单盒子盖在第 3 项两行的位置，左边留一列内边距；选中行前面还有 ›
  assert.ok(rows.some((r: string) => r.includes("┌")), "menu box drawn");
  assert.ok(rows.some((r: string) => r.includes("└")));
  assert.ok(rows.some((r: string) => r.includes("进入对话")));
  assert.ok(rows.some((r: string) => r.includes("删除")));
  assert.ok(rows.at(-1).includes("Enter 确认"));

  // ↓↓ 到「重命名」，↑ 回到「分叉」，Enter 就分叉
  c.handleInput(KEY.down);
  c.handleInput(KEY.down);
  assert.equal(c.menu.index, 2);
  c.handleInput(KEY.up);
  assert.equal(c.menu.index, 1);
  c.handleInput(KEY.enter);
  assert.equal(c.menu, undefined);
  assert.deepEqual(opened, ["fork:D:/projX"], "Enter on 分叉 forks the session");

  // Esc 关；一个普通字符也关，且不会被打进搜索框
  c.handleMouse(RMOUSE("press", 2, 8));
  c.handleMouse(RMOUSE("release", 2, 8));
  c.handleInput(KEY.esc);
  assert.equal(c.menu, undefined);
  c.handleMouse(RMOUSE("press", 2, 8));
  c.handleMouse(RMOUSE("release", 2, 8));
  const before = c.input.value;
  c.handleInput("x");
  assert.equal(c.menu, undefined);
  assert.equal(c.input.value, before, "menu swallows the character");
});

test("右键菜单：点菜单项就执行那一项，点盒子外面只关闭", () => {
  const c = make(fixture(), "D:/nowhere");
  const forked: string[] = [];
  c.onFork = (s: PeekSession) => forked.push(s.cwd);
  c.render(120);
  c.handleMouse(RMOUSE("press", 2, 8));
  c.handleMouse(RMOUSE("release", 2, 8));
  c.render(120); // 盒子的位置在重画时算出来
  const box = c.menuBox;
  assert.ok(box);
  // 第二项「分叉」在主体 top+2 行，靠左栏
  const y = 3 + box.top + 2;
  assert.deepEqual(c.handleMouse(MOUSE("press", box.left + 2, y)), { handled: true, render: false });
  assert.deepEqual(c.handleMouse(MOUSE("release", box.left + 2, y)), { handled: true, render: true });
  assert.deepEqual(forked, ["D:/projX"]);
  assert.equal(c.menu, undefined);

  // 点外面关闭，不执行任何东西
  c.handleMouse(RMOUSE("press", 2, 8));
  c.handleMouse(RMOUSE("release", 2, 8));
  c.handleMouse(MOUSE("press", 2, 1));
  c.handleMouse(MOUSE("release", 2, 1));
  assert.equal(c.menu, undefined);
  assert.deepEqual(forked, ["D:/projX"]);
});

test("右键菜单：删除项要再确认一次，改名项直接进改名", async () => {
  const c = make(fixture(), "D:/nowhere");
  let deleted = 0;
  c.onDelete = async () => (deleted++, true);
  c.render(120);
  const pick = (label: string) => {
    c.handleMouse(RMOUSE("press", 2, 8));
    c.handleMouse(RMOUSE("release", 2, 8));
    const i = c.menu.items.findIndex((it: any) => it.label === label);
    assert.ok(i >= 0, label);
    c.runMenu(i);
  };
  pick("删除");
  assert.equal(c.mode, "confirmDelete", "still asks before deleting");
  assert.equal(deleted, 0);
  c.handleInput("y");
  await tick();
  assert.equal(deleted, 1);

  c.onRename = async () => true;
  c.render(120);
  pick("重命名");
  assert.equal(c.mode, "rename");
});

test("右键菜单：置顶项按当前状态给文案，点完写回调并刷新图标", async () => {
  const all = fixture();
  const c = make(all, "D:/nowhere");
  const written: boolean[] = [];
  c.onPin = async (_s: PeekSession, pinned: boolean) => (written.push(pinned), true);
  c.render(120);
  c.handleMouse(RMOUSE("press", 2, 8));
  c.handleMouse(RMOUSE("release", 2, 8));
  const pinAt = c.menu.items.findIndex((it: any) => it.action === "pin");
  assert.equal(c.menu.items[pinAt].label, "置顶");
  c.runMenu(pinAt);
  await tick();
  assert.deepEqual(written, [true]);
  assert.equal(all[2].pinned, true);
  assert.ok(strip(c.render(120)[3 + 4]).includes("📌"), "the list shows the pin icon");

  // 再开一次，文案变成「取消置顶」
  c.render(120);
  c.handleMouse(RMOUSE("press", 2, 8));
  c.handleMouse(RMOUSE("release", 2, 8));
  assert.equal(c.menu.items[pinAt].label, "取消置顶");
  c.runMenu(pinAt);
  await tick();
  assert.deepEqual(written, [true, false]);
  assert.ok(!all[2].pinned);
});

test("右键菜单：Ctrl+W 直接置顶，写文件失败会提示且不改图标；占位会话不能置顶", async () => {
  const all = fixture();
  const c = make(all, "D:/nowhere");
  let ok = false;
  c.onPin = async () => ok;
  c.render(120);
  c.handleInput("\x17"); // Ctrl+W
  await tick();
  assert.equal(all[0].pinned, undefined, "failed write leaves the session alone");
  assert.ok(strip(c.render(120).at(-1)).includes("失败"));
  ok = true;
  c.handleInput("\x17");
  await tick();
  assert.equal(all[0].pinned, true);
  assert.ok(strip(c.render(120).at(-1)).includes("已置顶"));

  // 还没解析的占位会话：置顶会被后台解析覆盖，先提示
  const pending = { ...fixture()[0], pending: true };
  const d = make([pending], "D:/nowhere");
  d.onPin = async () => true;
  d.handleInput("\x17");
  await tick();
  assert.equal(pending.pinned, undefined);
  assert.ok(strip(d.render(120).at(-1)).includes("载入"));
});

test("右键菜单：Ctrl+Y 复制完整会话路径", async () => {
  const c = make(fixture(), "D:/nowhere");
  const copied: string[] = [];
  c.onCopy = async (text: string) => (copied.push(text), true);
  c.render(120);
  c.handleInput("\x19");
  await tick();
  assert.deepEqual(copied, [c.filtered[0].path]);
  assert.ok(strip(c.render(120).at(-1)).includes("已复制"));
  c.onCopy = async () => false;
  c.handleInput("\x19");
  await tick();
  assert.ok(strip(c.render(120).at(-1)).includes("复制路径失败"));
});

test("Ctrl+Enter 给没有鼠标的人开菜单，锚在选中项上", () => {
  const c = make(fixture(), "D:/nowhere");
  c.render(120);
  c.handleInput(KEY.down);
  c.handleInput("\x1b[13;5u"); // Kitty 的 Ctrl+Enter
  assert.equal(c.menu?.session.cwd, "D:/proj/packages/web");
  assert.equal(c.menu?.anchorRow, 2, "anchor is the selected item's first row");
  assert.equal(c.menu?.anchorCol, 2);
  assert.ok(strip(c.render(120)[3 + 2]).includes("┌"));
});

test("右键菜单：弹在鼠标处，贴着点击的行和列，右栏边缘会往左翻", () => {
  const c = make(fixture(), "D:/nowhere");
  c.render(120);
  // 点在左栏中间（主体第 3 行 → 组件第 6 行）：右边放得下，左上角就是鼠标那一格
  c.handleMouse(RMOUSE("press", 20, 6));
  c.handleMouse(RMOUSE("release", 20, 6));
  c.render(120);
  const box = c.menuBox!;
  assert.equal(box.top, 3, "菜单顶边就在鼠标的行上");
  assert.equal(box.left, 20, "菜单左上角就在鼠标的列上，不是固定贴左边");
  assert.ok(box.left + box.width <= c.layout.lw);

  // 靠右下角：下面放不下往上翻，右边放不下往左翻，位置都是算出来的精确值
  const many = Array.from({ length: 14 }, (_, i) => mk(`D:/p${i}`, [`q${i}`, "a"], i + 1));
  const d = make(many, "D:/nowhere");
  d.render(120);
  d.handleMouse(RMOUSE("press", 47, 30)); // 主体第 27 行，靠近底边；列也贴着左栏右边
  d.handleMouse(RMOUSE("release", 47, 30));
  d.render(120);
  const flipped = d.menuBox!;
  const boxH = d.menu!.items.length + 2;
  assert.equal(flipped.top, 27 - boxH, "翻到鼠标正上方");
  assert.equal(flipped.left, Math.min(47 - flipped.width, d.layout.lw - flipped.width - 2), "翻到鼠标左侧，再夹进左栏");
  assert.ok(flipped.left >= 2);
  assert.ok(flipped.left + flipped.width <= d.layout.lw, "菜单不出左栏");
});

test("右键菜单：只有 click 事件（不带 release）也能点；开菜单时的右键 click 不会误点第一项", () => {
  const c = make(fixture(), "D:/nowhere");
  const opened: string[] = [];
  c.onResume = (s: PeekSession) => opened.push("open:" + s.cwd);
  c.onFork = (s: PeekSession) => opened.push("fork:" + s.cwd);
  c.render(120);
  c.handleMouse(RMOUSE("press", 3, 6));
  c.handleMouse(RMOUSE("release", 3, 6));
  // 常规模式的桥接在松开后还会补一个 right click：不能把它当成点菜单
  c.handleMouse(RMOUSE("click", 3, 6));
  c.render(120);
  assert.deepEqual(opened, [], "opening the menu must not trigger an item");
  assert.ok(c.menu, "menu still open");

  // 只发 click：点在第二项「分叉」上
  const box = c.menuBox!;
  const target = c.menu!.session.cwd;
  c.handleMouse(MOUSE("click", box.left + 2, 3 + box.top + 2));
  assert.deepEqual(opened, ["fork:" + target]);
  assert.equal(c.menu, undefined);
});

test("右键菜单：按住松开点菜单项只执行一次，随后补的 click 不会落到下面的列表上", () => {
  const c = make(fixture(), "D:/nowhere");
  const forked: string[] = [];
  const resumed: string[] = [];
  c.onFork = (s: PeekSession) => forked.push(s.cwd);
  c.onResume = (s: PeekSession) => resumed.push(s.cwd);
  c.render(120);
  // 在第二项上开菜单，选中的也是它
  c.handleMouse(RMOUSE("press", 2, 5));
  c.handleMouse(RMOUSE("release", 2, 5));
  assert.equal(c.selected, 1);
  c.render(120);
  const box = c.menuBox!;
  const target = c.menu!.session.cwd;
  // 「分叉」是第二项：菜单里 screen y = BODY_TOP + top + 2
  const x = box.left + 2;
  const y = 3 + box.top + 2;
  const selectedBefore = c.selected;
  assert.deepEqual(c.handleMouse(MOUSE("press", x, y)), { handled: true, render: false });
  c.handleMouse(MOUSE("release", x, y));
  assert.deepEqual(forked, [target], "松开就执行");
  assert.equal(c.menu, undefined);
  // 同一格还会补一个 click：如果穿透，会选中菜单下面那一行的会话（或双击进入）
  assert.deepEqual(c.handleMouse(MOUSE("click", x, y)), { handled: true, render: false });
  assert.deepEqual(forked, [target], "只执行一次");
  assert.deepEqual(resumed, []);
  assert.equal(c.selected, selectedBefore, "点击没有穿透到列表");
});

test("右键菜单：点菜单外关闭，随后补的 click 也不会选中下面的会话", () => {
  const c = make(fixture(), "D:/nowhere");
  const resumed: string[] = [];
  c.onResume = (s: PeekSession) => resumed.push(s.cwd);
  c.render(120);
  c.handleMouse(RMOUSE("press", 30, 4));
  c.handleMouse(RMOUSE("release", 30, 4));
  assert.equal(c.selected, 0);
  c.render(120);
  const box = c.menuBox!;
  // 点在菜单左边、列表另一项的行上（第 3 项第一行 → 组件第 7 行）
  const x = Math.max(0, box.left - 2);
  const y = 7;
  const hitsItem = x > box.left && x < box.left + box.width - 1 && y >= 3 + box.top + 1;
  assert.ok(!hitsItem, "确认点在菜单外");
  c.handleMouse(MOUSE("press", x, y));
  c.handleMouse(MOUSE("release", x, y));
  assert.equal(c.menu, undefined, "点外面就关");
  const selectedBefore = c.selected;
  // 双击次数也要试一下：穿透的话 clickCount=2 会直接进入会话
  c.handleMouse(MOUSE("click", x, y, { clickCount: 2 }));
  assert.deepEqual(resumed, [], "关闭菜单的 click 不能进入会话");
  assert.equal(c.selected, selectedBefore, "也没有改选中项");
});
