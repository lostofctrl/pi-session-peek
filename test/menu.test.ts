import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { menuLayout, menuLines, menuWidth, type MenuItem } from "../src/menu.ts";
import { strip, theme } from "./helpers.ts";

// 右键菜单的纯函数：盒子宽度、摆放位置、画法。交互在 peek-component.test.ts 里

const ITEMS: MenuItem[] = [
  { action: "open", label: "Open" },
  { action: "fork", label: "Fork" },
  { action: "rename", label: "Rename" },
  { action: "pin", label: "Unpin" },
  { action: "copyPath", label: "Copy path" },
  { action: "delete", label: "Delete", danger: true },
];

test("menuWidth：最长一项 + 边框两列 + 文字两边各一列", () => {
  assert.equal(menuWidth(ITEMS), "Copy path".length + 4);
  assert.equal(menuWidth([{ action: "open", label: "Open" }]), 8);
  assert.equal(menuWidth([{ action: "open", label: "进入对话" }]), 8 + 4); // 中文按显示宽度算
  assert.equal(menuWidth([]), 4);
});

test("menuLayout：贴着鼠标，下面放不下往上翻，右边放不下往左翻，夹在左栏里", () => {
  // 六项 + 上下边框 = 8 行；主体 16 行，鼠标在第 4 行第 6 列：放得下，左上角对齐鼠标
  assert.deepEqual(menuLayout(4, 6, 6, 16, 48, 20), { top: 4, left: 6, width: 20 });
  // 鼠标太靠下：翻到上方，底边贴着鼠标
  assert.deepEqual(menuLayout(14, 6, 6, 16, 48, 20), { top: 6, left: 6, width: 20 });
  // 鼠标太靠右：翻到左边
  assert.deepEqual(menuLayout(4, 40, 6, 16, 48, 20), { top: 4, left: 20, width: 20 });
  // 两边都放不下（左栏窄）：夹回左栏，至少留 GAP
  assert.deepEqual(menuLayout(4, 30, 6, 16, 24, 20), { top: 4, left: 2, width: 20 });
  // 左栏比菜单窄：缩到左栏里，至少 4 列
  assert.equal(menuLayout(0, 2, 6, 16, 12, 20).width, 8);
  assert.equal(menuLayout(0, 2, 6, 16, 3, 20).width, 4);
  // 主体比盒子还矮：top 夹在 0
  assert.equal(menuLayout(3, 2, 6, 4, 48, 20).top, 0);
});

test("menuLines：上下边框，每项一行，选中项反显，删除项用错误色", () => {
  const t = {
    fg: (c: string, s: string) => `<${c}>${s}</>`,
    bg: (c: string, s: string) => `<${c}>${s}</>`,
    bold: (s: string) => s,
  };
  const lines = menuLines(ITEMS, 2, 14, t);
  assert.equal(lines.length, ITEMS.length + 2);
  // 桩主题把颜色包成 <fg>…</>，按颜色名断言，别去 strip（那只能去真 ANSI）
  assert.ok(lines[0].startsWith("<borderMuted>┌") && lines[0].includes("┐</>"));
  assert.ok(lines.at(-1)!.startsWith("<borderMuted>└"));
  // 宽度用真主题量：桩主题的 <fg> 标记会被算进去
  for (const l of menuLines(ITEMS, 2, 14, theme)) assert.equal(visibleWidth(strip(l)), 14);
  assert.ok(lines[3].includes("<selectedBg>"), "third row is highlighted");
  assert.ok(!lines[2].includes("<selectedBg>"));
  assert.ok(lines[1].includes("Open"));
  assert.ok(lines.at(-2)!.includes("<error>"), "delete row uses the error colour");
  // 每一项都被夹在盒子里，不会越过右边框
  assert.equal(visibleWidth(strip(menuLines(ITEMS, 0, menuWidth(ITEMS), theme)[1])), menuWidth(ITEMS));
});
