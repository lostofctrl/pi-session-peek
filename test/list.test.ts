import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyRows, paneWidths } from "../src/layout.ts";
import { buildList, followSelection, listRows, visibleItems, type ListCache } from "../src/list.ts";
import { roleTerms, parseQuery } from "../src/query.ts";
import type { PeekSession } from "../src/sessions.ts";
import { strip, theme } from "./helpers.ts";

// 几何和左栏的纯函数。组件层面的效果（选中高亮、命中片段、宽度）在 peek-component.test.ts 里

const NO_TERMS = { rt: roleTerms([]), hasBody: false };

const TIME = new Date(2020, 0, 2, 3, 4);
const NOW = new Date(2020, 0, 4, 3, 4).getTime(); // 比 TIME 晚两天，相对时间正好是 2d

function sess(cwd: string, first: string, name = ""): PeekSession {
  return {
    path: `${cwd}/x.jsonl`, cwd, time: TIME.toISOString(), name, first,
    msgs: [{ role: "user", text: first }], mtime: TIME.getTime(), size: 0, lastPrompt: TIME.getTime(),
  };
}

test("paneWidths：左栏 40% 夹在 26..56，右栏拿剩下的至少 20", () => {
  assert.deepEqual(paneWidths(120), { lw: 48, rw: 69 });
  assert.deepEqual(paneWidths(50), { lw: 26, rw: 21 });
  assert.deepEqual(paneWidths(40), { lw: 26, rw: 20 }); // 右栏到底线，总宽不够时允许超出
  assert.deepEqual(paneWidths(200), { lw: 56, rw: 141 });
});

test("bodyRows：读 process.stdout.rows，读不到用给定值，夹在 8..30", () => {
  const saved = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(bodyRows(40), 28);
    assert.equal(bodyRows(15), 8);
    assert.equal(bodyRows(100), 30);
    assert.equal(bodyRows(0), 12); // 24 - 12
    Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true, writable: true });
    assert.equal(bodyRows(100), 18);
  } finally {
    if (saved) Object.defineProperty(process.stdout, "rows", saved);
  }
});

test("visibleItems / followSelection：每项两行；选中项跑出视口才挪偏移", () => {
  assert.equal(visibleItems(28), 14);
  assert.equal(visibleItems(1), 1);
  assert.equal(followSelection(3, 0, 5), 0); // 在视口里，不动
  assert.equal(followSelection(5, 0, 5), 1); // 刚好出下边，挪到刚好看见
  assert.equal(followSelection(12, 0, 5), 8);
  assert.equal(followSelection(2, 4, 5), 2); // 出上边，偏移就是选中项
});

test("listRows：选中行带 › 和背景，时间显示成相对时间，第二行是首条消息 + [名字]", () => {
  const s = sess("D:/proj/packages/web", "hello there", "nm");
  const [a, b] = listRows(s, true, 40, NO_TERMS.rt, NO_TERMS.hasBody, theme, undefined, "prompt", NOW);
  assert.match(strip(a), /^› +2d packages\/web/);
  assert.equal(strip(a).length, 40);
  assert.equal(strip(b), "  hello there  [nm]".padEnd(40));
  const [c] = listRows(s, false, 40, NO_TERMS.rt, NO_TERMS.hasBody, theme, undefined, "prompt", NOW);
  assert.match(strip(c), /^ {6}2d packages\/web/); // 没状态时状态列留空，时间列仍然对齐
});

test("listRows：状态图标 ✓ 已答完 / ⏹ 中断，没有状态就没有图标", () => {
  const done = { ...sess("D:/proj", "ok"), status: "done" as const };
  const aborted = { ...sess("D:/proj", "stopped"), status: "aborted" as const };
  const running = sess("D:/proj", "still going"); // 末轮还是 toolUse / 用户消息：不给状态
  const row = (s: PeekSession) => strip(listRows(s, false, 40, NO_TERMS.rt, NO_TERMS.hasBody, theme, undefined, "prompt", NOW)[0]);
  assert.match(row(done), /^ {2}✓ +2d /);
  assert.match(row(aborted), /^ {2}⏹ +2d /);
  assert.doesNotMatch(row(running), /[✓⏹]/);
});

test("listRows：Alt+S 换排序时，时间列跟着显示创建时间 / 最近提问", () => {
  const s = sess("D:/proj", "hi");
  s.lastPrompt = new Date(2020, 0, 4, 3, 4).getTime(); // 提问比创建晚两天
  const row = (sort: "prompt" | "created") => strip(listRows(s, false, 40, NO_TERMS.rt, NO_TERMS.hasBody, theme, undefined, sort, NOW)[0]);
  assert.match(row("prompt"), /^ +now D:\/proj/);
  assert.match(row("created"), /^ +2d D:\/proj/);
});

test("listRows：有正文关键词时第一行带命中数，第二行是高亮片段", () => {
  const s = sess("D:/proj", "alpha beta alpha");
  const rt = roleTerms(parseQuery("alpha").terms);
  const [a, b] = listRows(s, false, 40, rt, true, theme);
  assert.ok(strip(a).includes(" ·1"), strip(a));
  assert.ok(b.includes("\x1b[1m\x1b[4m"), "snippet highlighted");
});

test("buildList：从 offset 起画满 height 行，空位补空，奇数高度补一行", () => {
  const all = [sess("D:/a", "one"), sess("D:/b", "two"), sess("D:/c", "three")];
  const rows = buildList(all, 1, 1, 5, 30, NO_TERMS.rt, NO_TERMS.hasBody, theme);
  assert.equal(rows.length, 5);
  assert.ok(strip(rows[0]).includes("D:/b"));
  assert.ok(strip(rows[1]).includes("two"));
  assert.ok(strip(rows[2]).includes("D:/c"));
  assert.equal(rows[4], " ".repeat(30));
  for (const r of rows) assert.equal(strip(r).length, 30);
});


test("listRows: reuse body analysis for selection/repaints; refresh on query and width", () => {
  const s = sess("D:/proj", "alpha beta");
  let reads = 0;
  Object.defineProperty(s.msgs[0], "text", { get: () => { reads++; return "alpha beta"; } });
  const rt = roleTerms(parseQuery("alpha").terms);
  const cache: ListCache = new WeakMap();
  const first = listRows(s, false, 40, rt, true, theme, cache);
  const initialReads = reads;
  assert.ok(initialReads > 0);
  listRows(s, true, 40, rt, true, theme, cache);
  assert.deepEqual(listRows(s, false, 40, rt, true, theme, cache), first);
  assert.equal(reads, initialReads, "repaints and selection changes must not rescan body");
  listRows(s, false, 50, rt, true, theme, cache);
  assert.ok(reads > initialReads, "resize refreshes the snippet");
  const resizedReads = reads;
  const beta = roleTerms(parseQuery("beta").terms);
  assert.deepEqual(listRows(s, false, 50, beta, true, theme, cache), listRows(s, false, 50, beta, true, theme));
  assert.ok(reads > resizedReads, "new query refreshes matches");
  s.name = "renamed";
  assert.ok(strip(listRows(s, false, 50, roleTerms([]), false, theme, cache)[1]).includes("[renamed]"));
});
