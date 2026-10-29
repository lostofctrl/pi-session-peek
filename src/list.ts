import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { msg } from "./i18n.ts";
import { anyMatch, highlight, snippet, type RoleTerms, type Snippet } from "./query.ts";
import { sessionStamp, type PeekSession, type SortMode } from "./sessions.ts";
import { fmtAgoCell, padEndVisible } from "./text.ts";
import type { PeekTheme } from "./theme.ts";

// 左栏：每个会话两行，全是纯函数。滚动偏移由组件持有，这里只算"选中项要留在视口里时偏移该是多少"

// pi 不会一直占着会话文件（不锁、不保持 fd），没法直接问"哪个会话正开着"。
// 退一步看"刚刚还在动"：这么久之内写过文件，可能是另一个 pi 正在用的会话。
// 注意这是提示不是事实：mtime 是打开选择器时读到的，之后不会重新 stat
export const ACTIVE_MS = 10 * 60e3;

export const isActive = (s: PeekSession, now: number): boolean => now - s.mtime < ACTIVE_MS;

// 主体 height 行能放下几个会话（每个两行）
export const visibleItems = (height: number): number => Math.max(1, Math.floor(height / 2));

// 选中项跑出视口时把偏移挪过去，其余情况不动
export function followSelection(selected: number, offset: number, visible: number): number {
  if (selected < offset) return selected;
  if (selected >= offset + visible) return selected - visible + 1;
  return offset;
}

// Per-picker, one query/width revision per session; selection styling stays uncached.
export type ListCache = WeakMap<PeekSession, { rt: RoleTerms; width: number; hits: number; snip: Snippet | undefined }>;

// 一个会话的两行：图标 + 相对时间 + 目录（有正文关键词时加命中数），首条消息或命中片段
// 图标（ 宽两格）：📌 置顶（还在跑）· ✅ 置顶且已答完 · 📎 置顶但中断 / 报错；
// 没置顶就看收尾状态 —— ✓ 已答完（settled），⏹ 中断 / 报错。都没有就留空格占位，后边的列不会歪
export function statusCell(s: PeekSession, t: PeekTheme): string {
  if (s.pinned) return padEndVisible(s.status === "done" ? "✅" : s.status === "aborted" ? "📎" : "📌", 2);
  if (!s.status) return "  ";
  return padEndVisible(s.status === "done" ? t.fg("success", "✓") : t.fg("warning", "⏹"), 2);
}

export function listRows(
  s: PeekSession,
  sel: boolean,
  lw: number,
  rt: RoleTerms,
  hasBody: boolean,
  t: PeekTheme,
  cache?: ListCache,
  sort: SortMode = "prompt",
  now: number = Date.now(),
): [string, string] {
  const age = fmtAgoCell(sessionStamp(s, sort), now);
  const cwdTail = s.cwd.replace(/\\/g, "/").split("/").slice(-2).join("/");
  let analysis = hasBody ? cache?.get(s) : undefined;
  if (hasBody && (!analysis || analysis.rt !== rt || analysis.width !== lw)) {
    analysis = {
      rt, width: lw,
      hits: s.msgs.reduce((n, m) => n + (anyMatch(m.text, rt[m.role]) ? 1 : 0), 0),
      snip: snippet(s.msgs, rt, lw),
    };
    cache?.set(s, analysis);
  }
  const hitBadge = hasBody ? ` ·${analysis!.hits}` : "";
  // 刚写过（多半正开在别的 pi 里）：目录后面点个绿点。选中那一行是 accent 色，绿点单独上色，
  // 别让它的收尾码把后面的命中数也洗掉
  const activeBadge = isActive(s, now) ? t.fg("success", " ●") : "";
  const head = `${sel ? "›" : " "} `;
  const rest = `${age} ${cwdTail}`;
  let l1 = sel
    ? t.fg("accent", head) + statusCell(s, t) + t.fg("accent", rest) + activeBadge + t.fg("accent", hitBadge)
    : head + statusCell(s, t) + rest + activeBadge + hitBadge;
  if (s.name) {
    const available = lw - visibleWidth(l1) - 1;
    if (available > 0) {
      const name = truncateToWidth(`[${s.name}]`, available);
      l1 += " " + (sel ? t.fg("accent", name) : name);
    }
  }
  const snip = hasBody ? analysis!.snip : undefined;
  const l2 = s.pending
    ? `  ${msg("loadingSession")}`
    : snip !== undefined
      ? `  ${highlight(snip.text, rt[snip.role], t)}`
      : `  ${s.first}`;
  if (sel) {
    return [
      t.bg("selectedBg", padEndVisible(truncateToWidth(l1, lw), lw)),
      t.bg("selectedBg", padEndVisible(truncateToWidth(l2, lw), lw)),
    ];
  }
  return [padEndVisible(l1, lw), padEndVisible(t.fg("dim", truncateToWidth(l2, lw)), lw)];
}

// 从 offset 起画满 height 行，每个会话两行，没会话的位置留空
export function buildList(
  filtered: PeekSession[],
  selected: number,
  offset: number,
  height: number,
  lw: number,
  rt: RoleTerms,
  hasBody: boolean,
  t: PeekTheme,
  cache?: ListCache,
  sort: SortMode = "prompt",
  now: number = Date.now(),
): string[] {
  const rows: string[] = [];
  for (let i = 0, n = visibleItems(height); i < n; i++) {
    const idx = offset + i;
    const s = filtered[idx];
    if (!s) {
      rows.push(" ".repeat(lw), " ".repeat(lw));
      continue;
    }
    rows.push(...listRows(s, idx === selected, lw, rt, hasBody, t, cache, sort, now));
  }
  // 每项两行，height 是奇数时会少一行，补空行，否则最后一行右栏会顶到左边
  while (rows.length < height) rows.push(" ".repeat(lw));
  return rows.slice(0, height);
}
