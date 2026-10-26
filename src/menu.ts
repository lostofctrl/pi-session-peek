import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { padEndVisible } from "./text.ts";
import type { PeekTheme } from "./theme.ts";

// 会话右键菜单：纯函数，负责菜单项宽度、贴着点击处的摆放位置和盒子的画法。
// 组件只持有菜单状态和命中区，交互在 peek-component.ts

export type MenuAction = "open" | "fork" | "rename" | "pin" | "copyPath" | "delete";

export interface MenuItem {
  action: MenuAction;
  label: string;
  danger?: boolean;
}

const SIDE = 4; // 左右边框各一列，加上文字两边各一列空格
const GAP = 2; // 菜单和终端左右边至少留一列

/** 菜单盒子的宽度：最长一项的显示宽度 + 边框和左右空格 */
export function menuWidth(items: readonly MenuItem[]): number {
  let max = 0;
  for (const it of items) max = Math.max(max, visibleWidth(it.label));
  return max + SIDE;
}

/** 菜单贴着鼠标摆放：优先向下、向右展开，空间不够就翻到上方、左侧，最后夹在左栏里 */
export function menuLayout(
  anchorRow: number,
  anchorCol: number,
  count: number,
  height: number,
  lw: number,
  width: number,
): { top: number; left: number; width: number } {
  const boxH = count + 2;
  const w = Math.max(4, Math.min(width, lw - GAP * 2));
  const top = anchorRow + boxH <= height ? anchorRow : Math.max(0, anchorRow - boxH);
  const left = anchorCol + w <= lw - GAP ? anchorCol : Math.max(GAP, anchorCol - w);
  return {
    top: Math.max(0, Math.min(top, height - boxH)),
    left: Math.max(GAP, Math.min(left, lw - w - GAP)),
    width: w,
  };
}

/** 画菜单盒子。每一项一行，选中项反显；删除项用错误色 */
export function menuLines(items: readonly MenuItem[], index: number, width: number, t: PeekTheme): string[] {
  const inner = Math.max(0, width - 2);
  const top = t.fg("borderMuted", "┌" + "─".repeat(inner) + "┐");
  const bottom = t.fg("borderMuted", "└" + "─".repeat(inner) + "┘");
  const rows = [top];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const text = padEndVisible(truncateToWidth(it.label, Math.max(0, inner - 2)), Math.max(0, inner - 2));
    const body = ` ${text} `;
    const styled = it.danger ? t.fg("error", body) : body;
    rows.push(t.fg("borderMuted", "│") + (i === index ? t.bg("selectedBg", styled) : styled) + t.fg("borderMuted", "│"));
  }
  rows.push(bottom);
  return rows;
}
