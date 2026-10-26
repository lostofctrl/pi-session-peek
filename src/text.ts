import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Windows 路径大小写不敏感，统一小写再比
export const normPath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// 本地时间 "MM-DD HH:mm"；withYear 或不是今年时带年份
export function fmtTime(iso: string, withYear = false): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return withYear ? "????-??-?? ??:??" : "??-?? ??:??";
  const p = (n: number) => String(n).padStart(2, "0");
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withYear || d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}-${md}` : md;
}

// 相对时间："now" / "5m" / "2h" / "3d" / "1w" / "4mo" / "2y"。列表里用，宽度固定 4 格好对齐
const AGO_UNITS: [number, string][] = [
  [365 * 86400e3, "y"], // 年
  [30 * 86400e3, "mo"], // 月
  [7 * 86400e3, "w"], // 周
  [86400e3, "d"], // 天
  [3600e3, "h"], // 小时
  [60e3, "m"], // 分钟
];

export function fmtAgo(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return "?";
  const d = Math.max(0, now - ms);
  if (d < 60e3) return "now";
  // 从最大的单位往下找第一个装得下的，除出来的整数就是该单位的格数
  const [span, suffix] = AGO_UNITS.find(([span]) => d >= span)!;
  return `${Math.floor(d / span)}${suffix}`;
}

// 列表里的时间列：相对时间右对齐到 4 格，"now" 和 "12mo" 都不会把后面的目录挤歪
export function fmtAgoCell(ms: number, now: number = Date.now()): string {
  return fmtAgo(ms, now).padStart(4);
}

// 按显示宽度补齐到 w，中文和 ANSI 都算对
export function padEndVisible(s: string, w: number): string {
  const v = visibleWidth(s);
  return v >= w ? truncateToWidth(s, w) : s + " ".repeat(w - v);
}
