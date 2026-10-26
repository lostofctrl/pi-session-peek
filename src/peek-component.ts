import {
  Input,
  Key,
  matchesKey,
  parseKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type MarkdownTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { msg } from "./i18n.ts";
import { DragSelect } from "./drag-select.ts";
import { BODY_TOP, bodyRows, paneWidths } from "./layout.ts";
import { buildList, followSelection, listRows, visibleItems, type ListCache } from "./list.ts";
import { menuLayout, menuLines, menuWidth, type MenuAction, type MenuItem } from "./menu.ts";
import { buildPreview, initialOffset, nextMatchTarget, type RenderCache } from "./preview.ts";
import { matchesSession, parseQuery, roleTerms, type ParsedQuery, type RoleTerms } from "./query.ts";
import { bounds, highlightColumns, rowColumns, selectionText, type Selection } from "./selection.ts";
import type { PeekSession, SortMode } from "./sessions.ts";
import { sortSessions } from "./sessions.ts";
import { fmtTime, normPath, padEndVisible } from "./text.ts";
import type { PeekTheme } from "./theme.ts";

// 双栏选择器。文件操作（删除 / 重命名 / 分叉）不在这里做，由 index.ts 通过回调注入。
// 几何常量在 layout.ts，左栏在 list.ts，右栏在 preview.ts，拖选状态机在 drag-select.ts

const WHEEL_LINES = 3; // 滚轮每格滚几行预览，和 Shift+↑↓ 一样
const WHEEL_ITEMS = 1; // 滚轮每格滚几个列表项（每项两行）。只滚视图，不换选中项，像浏览器的滚动条
const HINT_MS = 1500; // 底部"已复制"提示停留时间
const MENU_ROWS = 4; // ↑↓ 滚过几行就画一次菜单，省得每格都重画

// 头部四个可点 / 可按键切换的开关
type HeadAction = "scope" | "sort" | "pin" | "draft";

// 鼠标按下到松开之间移动超过这么多列就算拖动选字，不算点击（菜单在松开时才弹）
const DRAG_SLOP = 3;

export class PeekComponent implements Component, Focusable {
  private input: Input;
  private scope: "current" | "all";
  private filtered: PeekSession[] = [];
  private selected = 0;
  private listOffset = 0;
  private followSel = true; // 下次 render 把选中项带回视野：换选中项、重新过滤、删除后置真，滚轮滚列表不置
  private previewOffset = 0;
  private previewKey = ""; // 预览缓存的键（会话 + 关键词 + 宽度 + 工具开关），置空强制重建
  private showTools = false; // Ctrl+T：预览里显示每次工具调用的一行摘要
  private previewLines: string[] = [];
  private matchLines: number[] = []; // 预览里含关键词的行（升序），Ctrl+N / Ctrl+P 用
  private listCache: ListCache = new WeakMap();
  private cachedListTerms?: { query: string; rt: RoleTerms; hasBody: boolean };
  private byPath = new Map<string, PeekSession>(); // 路径 → 列表项；懒加载时按路径原地填充占位项
  private scopeAuto = false; // 还没解析出 cwd 时先按全局列出，第一批当前目录树的会话到了再自动切过去
  // Alt+P：只看 Pi Web 里 /pin 过的会话；和输入框里的 pin: 条件是 AND
  private pinOnly = false;
  // Alt+D：只看 pi-web 的草稿；和输入框里的 draft: 条件是 AND
  private draftOnly = false;
  // Alt+S：列表按什么时间排。默认最近提问，切到创建时间
  private sort: SortMode = "prompt";
  private rendered: RenderCache = new WeakMap(); // 每条消息渲染好的行，按宽度缓存
  // 三个互斥的输入状态：搜索（默认）、Ctrl+R 之后在输入新名字、Ctrl+D 之后等待确认。改名和确认只从搜索进入、退回搜索
  private mode: "search" | "rename" | "confirmDelete" = "search";
  private busy = false; // 删除 / 重命名的异步回调还没回来：期间不能再删、改名、进入或分叉，免得对同一个文件动两次
  private renameInput: Input;
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private layout = { lw: 0, rw: 0, H: 0 }; // 最近一次 render 的分栏尺寸，鼠标定位用
  // 头部可点的几段（范围 / 排序 / 置顶 / 草稿）占的列区间，点击切换。范围之前是标题，所以空白处点不动
  private headHits: { from: number; to: number; act: HeadAction }[] = [];
  // 拖选状态机。分栏尺寸和滚动位置惰性从组件读，自动滚动时把新的预览偏移写回来
  private drag = new DragSelect({
    geometry: () => ({ ...this.layout, listOffset: this.listOffset, previewOffset: this.previewOffset }),
    previewLength: () => this.previewLines.length,
    setPreviewOffset: (n) => void (this.previewOffset = n),
    changed: () => {
      this.invalidate();
      this.requestRender?.();
    },
  });
  // 右键（或 Ctrl+Enter）打开的会话菜单。anchorRow / anchorCol 是弹出位置（主体行号、组件列号）
  private menu?: { session: PeekSession; anchorRow: number; anchorCol: number; index: number; items: MenuItem[] };
  private menuBox?: { top: number; left: number; width: number }; // 菜单盒子在主休里的位置，鼠标命中和绘制用
  private swallowClick = false; // 菜单刚用鼠标松开处理过，紧跟的 click 事件吃掉，别落到下面的列表上
  private pressedAt?: { x: number; y: number }; // 左键按下的位置，判断是点击还是拖选
  private dragged = false; // 本次按下之后拖过：原地松开才弹右键菜单
  private hint?: { text: string; ok: boolean }; // 底部一闪而过的复制结果
  private hintTimer?: ReturnType<typeof setTimeout>;
  private _focused = false;

  // 由 index.ts 注入
  onResume?: (s: PeekSession) => void;
  onFork?: (s: PeekSession) => void;
  onCancel?: () => void;
  onDelete?: (s: PeekSession) => Promise<boolean>;
  onRename?: (s: PeekSession, name: string) => Promise<boolean>;
  onCopy?: (text: string) => Promise<boolean>; // 拖选后 Ctrl+C
  onPin?: (s: PeekSession, pinned: boolean) => Promise<boolean>; // 菜单里的置顶开关，写进会话文件
  onDispose?: () => void; // 关闭时
  requestRender?: () => void; // 异步操作完成后让 TUI 重画
  afterRender?: () => void; // 每次 render 之后调用；常规模式的鼠标桥接靠它重新测组件在屏幕上的位置

  constructor(
    private all: PeekSession[],
    private currentCwd: string,
    private theme: PeekTheme,
    private mdTheme: MarkdownTheme,
    private termRows: number,
    initialQuery: string,
  ) {
    this.input = new Input({ placeholder: msg("searchPlaceholder") });
    this.renameInput = new Input({ placeholder: msg("renamePlaceholder") });
    if (initialQuery) this.input.setValue(initialQuery);
    for (const s of all) this.byPath.set(s.path, s);
    // 当前目录树下有会话就默认当前目录，否则全局。
    // 懒加载时占位项还没有 cwd，先按全局画出来；第一批解析完如果发现当前目录树有会话，
    // scopeAuto 会在 mergeLoaded 里切过去，用户自己按过 Tab 之后就不再自动切换
    const hasCurrent = all.some((s) => !s.pending && this.inCurrentTree(s));
    this.scope = hasCurrent ? "current" : "all";
    this.scopeAuto = !hasCurrent;
    this.refilter();
  }

  // 焦点要落到真正在用的那个输入框上，否则 IME 候选框位置不对
  get focused(): boolean {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
    this.input.focused = v && this.mode !== "rename";
    this.renameInput.focused = v && this.mode === "rename";
  }

  getQuery(): string {
    return this.input.getValue().trim();
  }

  private query(): ParsedQuery {
    return parseQuery(this.getQuery());
  }

  // 等于当前目录，或在它的子目录下
  private inCurrentTree(s: PeekSession): boolean {
    const cur = normPath(this.currentCwd);
    const c = normPath(s.cwd);
    return c === cur || c.startsWith(cur + "/");
  }

  // keepSelection：尽量保持原来选中的会话，重命名后用
  private refilter(keepSelection = false, keepPreview = false): void {
    const prev = keepSelection ? this.filtered[this.selected] : undefined;
    this.listCache = new WeakMap();
    const q = this.query();
    const { terms, since } = q;
    const pinned = this.pinOnly ? [...q.pinned, true] : q.pinned;
    const drafts = this.draftOnly ? [...q.drafts, true] : q.drafts;
    let out = this.all;
    if (this.scope === "current") out = out.filter((s) => this.inCurrentTree(s));
    if (since) out = out.filter((s) => s.mtime >= since);
    // 还没解析的会话不知道内容、置顶和草稿状态，有过滤条件时先不列；后台解析完会自动补进来
    if (terms.length || pinned.length || drafts.length) {
      out = out.filter((s) => !s.pending && matchesSession(s, terms, pinned, drafts));
    }
    this.filtered = sortSessions(out, this.sort);
    const idx = prev ? this.filtered.indexOf(prev) : -1;
    this.selected = idx >= 0 ? idx : keepSelection ? Math.min(this.selected, Math.max(0, this.filtered.length - 1)) : 0;
    if (!keepSelection) this.listOffset = 0;
    this.followSel = true;
    // 后台填充时会一批批调用；选中项没变就别重建预览，否则滚动位置一直被打回底部
    if (!keepPreview) {
      this.previewKey = "";
      this.drag.clear();
    }
  }

  /** 后台解析完一批会话：按路径原地填充占位项，然后只重算一次列表。
   * 已经在列表里被删掉 / 已解析过的路径直接跳过；解析失败的文件用 dropSession 移除 */
  mergeLoaded(list: PeekSession[]): void {
    if (!list.length) return;
    const selected = this.filtered[this.selected];
    let selectedLoaded = false;
    let any = false;
    for (const s of list) {
      const slot = this.byPath.get(s.path);
      if (!slot || !slot.pending) continue;
      Object.assign(slot, s);
      delete slot.pending;
      any = true;
      if (slot === selected) selectedLoaded = true;
    }
    // 第一批带 cwd 的会话到了：用户没动过范围的话，自动落到当前目录树
    if (this.scopeAuto && this.scope === "all" && this.all.some((s) => !s.pending && this.inCurrentTree(s))) {
      this.scope = "current";
      this.scopeAuto = false;
      selectedLoaded = true;
    }
    if (!any) return;
    this.refilter(true, !selectedLoaded);
    this.invalidate();
    this.requestRender?.();
  }

  /** 没有正文（空会话 / 解析失败）的文件：把占位项从列表里去掉 */
  dropSession(path: string): void {
    const s = this.byPath.get(path);
    if (!s) return;
    this.byPath.delete(path);
    let i = this.all.indexOf(s);
    if (i >= 0) this.all.splice(i, 1);
    i = this.filtered.indexOf(s);
    if (i >= 0) {
      this.filtered.splice(i, 1);
      this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
      this.followSel = true;
      this.previewKey = "";
    }
    this.invalidate();
    this.requestRender?.();
  }

  // 换选中的会话：预览重建，拖选的选区作废，视野跟过去
  private select(idx: number): void {
    this.selected = idx;
    this.followSel = true;
    this.previewKey = "";
    this.drag.clear();
  }

  dispose(): void {
    this.drag.dispose();
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = undefined;
    this.onDispose?.();
  }

  private bodyHeight(): number {
    return bodyRows(this.termRows);
  }

  handleInput(data: string): void {
    // 菜单打开时吃掉全部按键：↑↓ 换项，Enter 执行，Esc / Ctrl+C / 其他任何键关闭
    if (this.menu) {
      this.menuKey(data);
      return;
    }
    // 重命名输入中：Enter 提交，Esc / Ctrl+C 取消，其他键交给输入框
    if (this.mode === "rename") {
      if (matchesKey(data, Key.enter)) {
        const s = this.filtered[this.selected];
        const name = this.renameInput.getValue().trim();
        this.mode = "search";
        this.focused = this._focused;
        this.invalidate();
        if (s && name && this.onRename && !this.busy) {
          this.busy = true;
          void this.onRename(s, name).then((ok) => {
            if (ok) {
              s.name = name;
              // 名字参与搜索，改完可能就不再匹配当前关键词了
              this.refilter(true);
            }
          }).catch(() => {
            // 回调自己负责提示；这里吞掉，别变成 unhandled rejection
          }).finally(() => {
            // 放在 finally：回调抛了错也要解锁，否则删除 / 改名 / 进入全部永久失效
            this.busy = false;
            this.invalidate();
            this.requestRender?.();
          });
        }
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        this.mode = "search";
        this.focused = this._focused;
        this.invalidate();
        return;
      }
      this.renameInput.handleInput(data);
      this.invalidate();
      return;
    }
    // 删除确认中：y / Enter 执行，其他任何键取消
    if (this.mode === "confirmDelete") {
      this.mode = "search";
      this.invalidate();
      if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) {
        const s = this.filtered[this.selected];
        if (s && this.onDelete && !this.busy) {
          this.busy = true;
          void this.onDelete(s).then((ok) => {
            if (ok) {
              this.byPath.delete(s.path);
              // 后台可能还在读这个文件：解析完 mergeLoaded 找不到占位项就自动跳过
              let i = this.all.indexOf(s);
              if (i >= 0) this.all.splice(i, 1);
              i = this.filtered.indexOf(s);
              if (i >= 0) this.filtered.splice(i, 1);
              // 选中位置留在原地
              this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
              this.followSel = true;
              this.previewKey = "";
              this.drag.clear();
            }
          }).catch(() => {
          }).finally(() => {
            this.busy = false;
            this.invalidate();
            this.requestRender?.();
          });
        }
      }
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      // 有拖选的选区时 Ctrl+C 是复制，和终端里的习惯一样；没有才是关闭
      if (matchesKey(data, Key.ctrl("c")) && this.drag.active()) {
        this.copySelection();
        return;
      }
      this.onCancel?.();
      return;
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      if (this.filtered.length && this.onDelete && !this.busy) {
        this.mode = "confirmDelete";
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      const s = this.filtered[this.selected];
      // 占位项还没有旧名字，解析中的内容也可能覆盖刚改的名字：等载入完再改名
      if (s?.pending) {
        this.showHint(msg("loadingSession"), false);
        return;
      }
      if (s && this.onRename && !this.busy) {
        this.mode = "rename";
        this.renameInput.setValue(s.name || "");
        this.focused = this._focused;
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.headAction("scope");
      return;
    }
    if (matchesKey(data, Key.up)) {
      if (this.selected > 0) {
        this.select(this.selected - 1);
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (this.selected < this.filtered.length - 1) {
        this.select(this.selected + 1);
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
      const step = matchesKey(data, Key.pageUp) ? this.bodyHeight() : Math.max(1, this.bodyHeight() >> 1);
      this.previewOffset = Math.max(0, this.previewOffset - step);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) {
      const step = matchesKey(data, Key.pageDown) ? this.bodyHeight() : Math.max(1, this.bodyHeight() >> 1);
      this.previewOffset += step;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.shift("up"))) {
      this.previewOffset = Math.max(0, this.previewOffset - 3);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.shift("down"))) {
      this.previewOffset += 3;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.alt("p"))) {
      this.headAction("pin");
      return;
    }
    if (matchesKey(data, Key.alt("d"))) {
      this.headAction("draft");
      return;
    }
    if (matchesKey(data, Key.alt("s"))) {
      this.headAction("sort");
      return;
    }
    if (matchesKey(data, Key.ctrl("w"))) {
      this.togglePin();
      return;
    }
    if (matchesKey(data, Key.ctrl("y"))) {
      this.copyPath();
      return;
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      this.showTools = !this.showTools;
      this.previewKey = "";
      this.drag.clear();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.ctrl("n"))) {
      this.jumpMatch(1);
      return;
    }
    if (matchesKey(data, Key.ctrl("p"))) {
      this.jumpMatch(-1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const s = this.filtered[this.selected];
      if (s && !this.busy) this.onResume?.(s);
      return;
    }
    // Ctrl+Enter：不给鼠标也能开菜单，锚在当前选中项第一行
    if (parseKey(data) === "ctrl+enter") {
      const s = this.filtered[this.selected];
      if (s) this.openMenu(s, (this.selected - this.listOffset) * 2, 2);
      return;
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      const s = this.filtered[this.selected];
      if (s && !this.busy) this.onFork?.(s);
      return;
    }
    // 其余按键交给搜索框
    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) this.refilter(); // 光标移动不算输入，别重置列表
    this.invalidate();
  }

  // 硬件光标在组件内的行号：搜索框在第 1 行，改名时在最后一行。常规模式的鼠标桥接靠它算组件顶行
  cursorRow(): number | undefined {
    if (!this._focused || !this.layout.H) return undefined;
    return this.mode === "rename" ? BODY_TOP + this.layout.H + 1 : 1;
  }

  // 鼠标：左栏按下选中、双击进入、滚轮换选中项；右栏滚轮滚预览；点头部"范围"切换；点输入框移光标；
  // 在任一栏里按住拖动是选文字，只选这一栏，Ctrl+C 复制。
  // 全屏模式由 pi-tui 按布局直接调，常规模式由 mouse.ts 换算成组件内坐标后调。坐标以组件左上角为原点
  handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
    const { lw, H } = this.layout;
    if (!H) return undefined; // 还没画过，不知道分栏在哪
    const inList = ev.x < lw;
    const bodyRow = ev.y - BODY_TOP;
    const inBody = bodyRow >= 0 && bodyRow < H;
    const itemAt = (): number => (inList && inBody ? this.listOffset + (bodyRow >> 1) : -1); // 每项两行

    // 菜单刚用鼠标松开处理过（执行了某项或点外关闭），鼠标桥接随后补的 click 不能再落到下面的列表上
    if (this.swallowClick) {
      if (ev.type === "click") {
        this.swallowClick = false;
        return { handled: true, render: false };
      }
      if (ev.type === "press" || ev.type === "wheel") this.swallowClick = false; // 没有补 click 的话别一直吞
    }

    if (ev.type === "wheel") {
      const delta = ev.wheelDelta ?? 0;
      if (!delta) return undefined;
      // 菜单开着滚轮不滚内容，只吃掉事件
      if (this.menu) return { handled: true, render: false };
      // 和按键一样，滚一下就算取消确认。只退出确认，改名中滚轮不退出改名
      let changed = this.cancelConfirm();
      if (inList) {
        // 只滚视图，选中项不动；↑↓、点击、重新过滤会把选中项带回视野
        const maxOff = Math.max(0, this.filtered.length - visibleItems(H));
        const next = Math.max(0, Math.min(maxOff, this.listOffset + delta * WHEEL_ITEMS));
        if (next !== this.listOffset) {
          this.listOffset = next;
          changed = true;
        }
      } else {
        const maxOff = Math.max(0, this.previewLines.length - H);
        const next = Math.max(0, Math.min(maxOff, this.previewOffset + delta * WHEEL_LINES));
        if (next !== this.previewOffset) {
          this.previewOffset = next;
          changed = true;
        }
      }
      if (changed) this.invalidate();
      return { handled: true, render: changed };
    }
    // 菜单：点菜单项执行，点外关闭；按下 / 松开 / 随后合成的 click 都要接住
    if (this.menu) {
      if (ev.type === "press") return { handled: true, render: false };
      if (ev.type === "release") {
        const idx = this.menuItemAt(ev.x, ev.y);
        // 同一格松开后，鼠标桥接还会补一个 click；别让它落到下面的列表上
        this.swallowClick = true;
        if (idx >= 0) this.runMenu(idx);
        else this.closeMenu();
        return { handled: true, render: true };
      }
      if (ev.type === "click") {
        const idx = this.menuItemAt(ev.x, ev.y);
        if (idx >= 0) this.runMenu(idx);
        else this.closeMenu();
        return { handled: true, render: true };
      }
      // 拖动、滚轮都吃掉
      return { handled: true, render: false };
    }
    // 右键：按下时记下位置，原地松开才弹菜单（拖开就不弹），按下松开都吃掉不传给别人
    if (ev.button === "right") {
      if (ev.type === "press") {
        this.pressedAt = { x: ev.x, y: ev.y };
        this.dragged = false;
      } else if (ev.type === "drag") {
        this.markDragged(ev.x, ev.y);
      } else if (ev.type === "release") {
        const idx = inList && inBody ? this.listOffset + (bodyRow >> 1) : -1;
        const s = idx >= 0 && idx < this.filtered.length ? this.filtered[idx] : undefined;
        const dragged = this.dragged;
        this.dragged = false;
        if (s && !dragged && !this.busy) {
          // 菜单就弹在鼠标处：行用按下时的行，列用点击的列
          this.openMenu(s, Math.max(0, bodyRow), ev.x);
          this.swallowClick = true; // 紧跟的 right click 不算菜单里的点击
          return { handled: true, render: true };
        }
      }
      return { handled: true, render: false };
    }
    // 左键按住后离开按下位置超过拖动阀值就当成选字
    if (ev.type === "drag") this.markDragged(ev.x, ev.y);
    if (ev.type === "drag") {
      const d = this.drag;
      if (!d.dragging || !d.sel || ev.button !== "left") return undefined;
      const pane = d.sel.pane;
      const changed = d.move(ev.x, bodyRow);
      // 右栏拖出上下边就自动滚；左栏不滚
      if (pane === "preview") d.autoScroll(bodyRow < 0 ? -1 : bodyRow >= H ? 1 : 0);
      if (changed) this.invalidate();
      return { handled: true, render: changed };
    }
    if (ev.button !== "left") return undefined;
    if (ev.type === "release") {
      this.dragged = false;
      // moved 不算的话，原地左键松开可能是在结束一段选字，也清一下
      if (!this.drag.release()) return undefined;
      return { handled: true, render: false };
    }
    if (ev.type === "click") {
      // 单击在 press 里已经选中了，双击才进入
      const s = this.filtered[itemAt()];
      if (!s) return undefined;
      if (this.mode !== "rename" && !this.busy && (ev.clickCount ?? 1) >= 2) this.onResume?.(s);
      return { handled: true, render: false };
    }
    if (ev.type !== "press") return undefined;
    this.pressedAt = { x: ev.x, y: ev.y };
    this.dragged = false;

    // 删除确认和已有的选区：点一下就没了，和按键一样
    let changed = this.cancelConfirm() || this.drag.active() !== undefined;
    this.drag.clear();
    let handled = changed;
    if (this.mode === "rename") {
      if (ev.y === BODY_TOP + H + 1) {
        // 改名行：点哪里光标就去哪里
        this.renameInput.handleMouse({ ...ev, x: ev.x - visibleWidth(msg("renamePrefix")), y: 0 });
        handled = changed = true;
      }
    } else if (ev.y === 1) {
      this.input.handleMouse({ ...ev, y: 0 });
      handled = changed = true;
    } else if (ev.y === 0) {
      const hit = this.headHits.find((h) => ev.x >= h.from && ev.x < h.to);
      if (hit) {
        this.headAction(hit.act);
        handled = changed = true;
      }
    } else {
      const idx = itemAt();
      if (idx >= 0 && idx < this.filtered.length && idx !== this.selected) {
        this.select(idx);
        changed = true;
      }
    }
    if (inBody) {
      // 两栏里按下都可能是拖选的起点，拖起来才算数；接管后面的拖动和松开
      this.drag.begin(inList ? "list" : "preview", ev.x, bodyRow);
      handled = true;
    }
    if (!handled) return undefined;
    if (changed) this.invalidate();
    return inBody ? { handled: true, capture: true, render: changed } : { handled: true, render: changed };
  }

  // 离开按下位置超过拖动阀值，就把这次拖动算成选字而不是点击
  private markDragged(x: number, y: number): void {
    const p = this.pressedAt;
    if (p && (Math.abs(x - p.x) > DRAG_SLOP || Math.abs(y - p.y) > DRAG_SLOP)) this.dragged = true;
  }

  // ---- 会话菜单 ----

  // 菜单项：置顶文案跟着当前状态走，占位项（还没解析）给不了名字就先不给改名、分叉、删除
  private menuItems(s: PeekSession): MenuItem[] {
    const items: MenuItem[] = [
      { action: "open", label: msg("menuOpen") },
      { action: "fork", label: msg("menuFork") },
      { action: "rename", label: msg("menuRename") },
      { action: "pin", label: s.pinned ? msg("menuUnpin") : msg("menuPin") },
      { action: "copyPath", label: msg("menuCopyPath") },
    ];
    items.push({ action: "delete", label: msg("menuDelete"), danger: true });
    return items;
  }

  /** 在鼠标处（主体行 / 组件列）弹出菜单，会话已经选中 */
  private openMenu(s: PeekSession, anchorRow: number, anchorCol: number): void {
    const idx = this.filtered.indexOf(s);
    if (idx < 0) return;
    this.select(idx);
    const H = this.layout.H;
    this.menu = {
      session: s,
      anchorRow: Math.max(0, Math.min(anchorRow, Math.max(0, H - 1))),
      anchorCol: Math.max(0, anchorCol),
      index: 0,
      items: this.menuItems(s),
    };
    this.invalidate();
    this.requestRender?.();
  }

  private closeMenu(): void {
    if (!this.menu) return;
    this.menu = undefined;
    this.menuBox = undefined;
    this.invalidate();
    this.requestRender?.();
  }

  // 组件内坐标 → 菜单项序号，不在菜单里返回 -1
  private menuItemAt(x: number, y: number): number {
    const box = this.menuBox;
    const m = this.menu;
    if (!m || !box) return -1;
    if (x <= box.left || x >= box.left + box.width - 1) return -1;
    const i = y - BODY_TOP - box.top - 1; // 第一行是上边框
    return i >= 0 && i < m.items.length ? i : -1;
  }

  // 菜单里的按键：↑↓ 换项，Enter 执行，Esc / Ctrl+C / 其他任何键关闭
  private menuKey(data: string): void {
    const m = this.menu;
    if (!m) return;
    const n = m.items.length;
    if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
      m.index = (m.index + 1) % n;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.up)) {
      m.index = (m.index + n - 1) % n;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.runMenu(m.index);
      return;
    }
    this.closeMenu();
  }

  private runMenu(index: number): void {
    const m = this.menu;
    if (!m) return;
    const s = m.session;
    const act: MenuAction | undefined = m.items[index]?.action;
    this.closeMenu();
    if (!act || this.busy) return;
    if (act === "open") this.onResume?.(s);
    else if (act === "fork") this.onFork?.(s);
    else if (act === "rename") this.startRename(s);
    else if (act === "pin") this.togglePin(s);
    else if (act === "copyPath") this.copyPath(s);
    else if (act === "delete") {
      this.select(this.filtered.indexOf(s));
      this.mode = "confirmDelete";
      this.invalidate();
    }
  }

  // 进入改名：占位项还没有旧名字，改名也会被后台解析覆盖，等载入完
  private startRename(s: PeekSession): void {
    if (s.pending) {
      this.showHint(msg("loadingSession"), false);
      return;
    }
    if (this.busy) return;
    this.mode = "rename";
    this.renameInput.setValue(s.name || "");
    this.focused = this._focused;
    this.invalidate();
  }

  // 置顶开关（Ctrl+W 和菜单共用）：先写文件，成功了再改内存和显示
  private togglePin(target?: PeekSession): void {
    const s = target ?? this.filtered[this.selected];
    if (!s || this.busy) return;
    if (s.pending) {
      this.showHint(msg("pinUnsupported"), false);
      return;
    }
    if (!this.onPin) return;
    const want = !s.pinned;
    this.busy = true;
    void this.onPin(s, want).then((ok) => {
      if (!ok) {
        this.showHint(msg("pinFailed"), false);
        return;
      }
      if (want) s.pinned = true;
      else delete s.pinned;
      this.showHint(want ? msg("pinHint") : msg("unpinHint"), true);
      // 「只看置顶」开着时取消置顶会让它从列表里消失，得重新过滤
      if (this.pinOnly || this.query().pinned.length) this.refilter(true, true);
    }).catch(() => {
      this.showHint(msg("pinFailed"), false);
    }).finally(() => {
      this.busy = false;
      this.invalidate();
      this.requestRender?.();
    });
  }

  // 复制完整会话文件路径（Ctrl+Y 和菜单共用）
  private copyPath(target?: PeekSession): void {
    const s = target ?? this.filtered[this.selected];
    if (!s || !this.onCopy) return;
    void this.onCopy(s.path).then((ok) => this.showHint(ok ? msg("pathCopied") : msg("pathCopyFailed"), ok));
  }

  // 头部四个开关：点头部的字样、Tab / Alt+S / Alt+P / Alt+D 都走这里
  private headAction(act: HeadAction): void {
    if (act === "scope") {
      this.scope = this.scope === "all" ? "current" : "all";
      this.scopeAuto = false;
    } else if (act === "sort") {
      this.sort = this.sort === "prompt" ? "created" : "prompt";
    } else if (act === "pin") {
      this.pinOnly = !this.pinOnly;
    } else {
      this.draftOnly = !this.draftOnly;
    }
    this.refilter();
    this.invalidate();
  }

  // 鼠标滚轮 / 按下时退出删除确认（只退出确认，改名状态不动）。返回有没有退出
  private cancelConfirm(): boolean {
    if (this.mode !== "confirmDelete") return false;
    this.mode = "search";
    return true;
  }

  // 选区里的纯文本
  private selectionToText(sel: Selection): string {
    const { lw, rw } = this.layout;
    if (sel.pane === "preview") return selectionText(sel, rw, (row) => this.previewLines[row]);
    const { rt, hasBody } = this.listTerms();
    return selectionText(sel, lw, (row) => {
      const s = this.filtered[row >> 1];
      return s && listRows(s, (row >> 1) === this.selected, lw, rt, hasBody, this.theme, undefined, this.sort, Date.now())[row & 1];
    });
  }

  // Ctrl+C：复制选区，清掉高亮，底部闪一下结果
  private copySelection(): void {
    const sel = this.drag.active();
    if (!sel) return;
    const text = this.selectionToText(sel);
    const n = text.split("\n").length;
    this.drag.clear();
    this.invalidate();
    if (!text.trim() || !this.onCopy) return;
    void this.onCopy(text).then((ok) => this.showHint(ok ? msg("copied", { n }) : msg("copyFailed"), ok));
  }

  private showHint(text: string, ok: boolean): void {
    this.hint = { text, ok };
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      this.hintTimer = undefined;
      this.hint = undefined;
      this.invalidate();
      this.requestRender?.();
    }, HINT_MS);
    this.hintTimer.unref?.();
    this.invalidate();
    this.requestRender?.();
  }

  // 预览里跳到当前视口之外的下一个 / 上一个命中行，到头了回绕
  private jumpMatch(dir: 1 | -1): void {
    const H = this.bodyHeight();
    const top = this.previewOffset;
    const bottom = Math.min(top + H, this.previewLines.length) - 1;
    const target = nextMatchTarget(this.matchLines, top, bottom, dir);
    if (target !== undefined) {
      this.previewOffset = Math.max(0, target - 2);
      this.invalidate();
    }
  }

  // 左栏用的关键词：排除词和 name: / cwd: 不在正文里高亮
  private listTerms(): { rt: RoleTerms; hasBody: boolean } {
    const query = this.getQuery();
    if (!this.cachedListTerms || this.cachedListTerms.query !== query) {
      const rt = roleTerms(this.query().terms);
      this.cachedListTerms = { query, rt, hasBody: rt.user.length > 0 || rt.assistant.length > 0 };
    }
    return this.cachedListTerms;
  }

  // 右栏。预览键（会话 + 关键词 + 宽度 + 工具开关）没变就复用；变了重建，滚动位置放到首个命中处或底部
  private rebuildPreview(rw: number, rt: RoleTerms): void {
    const s = this.filtered[this.selected];
    const key = s ? `${s.path}|${this.getQuery()}|${rw}|${this.showTools ? "t" : ""}` : "none";
    if (key === this.previewKey) return;
    this.previewKey = key;
    const p = buildPreview(s, rt, rw, this.showTools, this.theme, this.mdTheme, this.rendered);
    this.previewLines = p.lines;
    this.matchLines = p.matchLines;
    this.previewOffset = initialOffset(p, this.bodyHeight());
  }

  render(width: number): string[] {
    const H = this.bodyHeight();
    const cacheKey = width * 1000 + H; // 宽或高变了都要重画
    if (this.cachedWidth === cacheKey) {
      // 缓存命中时组件在屏幕上的位置也可能变了（上面多了一行状态提示），照样通知一次，桥接那边自己去重
      this.afterRender?.();
      return this.cachedLines;
    }
    const t = this.theme;
    const { lw, rw } = paneWidths(width);
    this.layout = { lw, rw, H };

    const out: string[] = [];

    // 头部：标题，然后是范围 / 排序 / 置顶 / 草稿四个可点的开关，最后是时间过滤、匹配数
    const scopeLabel = this.scope === "all" ? msg("scopeAll") : msg("scopeCurrent");
    const { sinceLabel } = this.query();
    let head = t.fg("accent", t.bold(msg("title")));
    const hits: typeof this.headHits = [];
    // 「范围[Tab]: 当前目录树」整段都能点；(前) 后的列号按可见宽度算，中文和 emoji 都不跑偏
    const chip = (label: string, value: string, act: HeadAction) => {
      const from = visibleWidth(head);
      head += t.fg("dim", label) + t.fg("warning", value);
      hits.push({ from, to: visibleWidth(head), act });
    };
    chip(msg("scopeLabel"), scopeLabel, "scope");
    chip(msg("sortLabel"), this.sort === "prompt" ? msg("sortPrompt") : msg("sortCreated"), "sort");
    chip(msg("pinLabel"), this.pinOnly ? msg("pinOnly") : msg("pinAll"), "pin");
    chip(msg("draftLabel"), this.draftOnly ? msg("draftOnly") : msg("draftAll"), "draft");
    this.headHits = hits;
    let pending = 0;
    for (const s of this.all) if (s.pending) pending++;
    head +=
      (sinceLabel ? t.fg("dim", msg("timeLabel")) + t.fg("warning", sinceLabel) : "") +
      t.fg("dim", msg("matchCount", { n: this.filtered.length, total: this.all.length })) +
      (pending ? t.fg("dim", msg("loading", { n: pending })) : "");
    out.push(truncateToWidth(head, width));
    out.push(this.input.render(width)[0] ?? "");
    out.push(t.fg("borderMuted", "─".repeat(width)));

    // 双栏
    const { rt, hasBody } = this.listTerms();
    this.rebuildPreview(rw, rt);
    // 选中项变了才把视野挪过去；滚轮滚出去的视野留着。列表变短、终端变高后别在底下留空白
    const visible = visibleItems(H);
    if (this.followSel) {
      this.listOffset = followSelection(this.selected, this.listOffset, visible);
      this.followSel = false;
    }
    this.listOffset = Math.min(this.listOffset, Math.max(0, this.filtered.length - visible));
    const leftRows = buildList(this.filtered, this.selected, this.listOffset, H, lw, rt, hasBody, t, this.listCache, this.sort, Date.now());

    const maxOff = Math.max(0, this.previewLines.length - H);
    if (this.previewOffset > maxOff) this.previewOffset = maxOff;
    const rightRows = this.previewLines.slice(this.previewOffset, this.previewOffset + H);
    // 右上角：有命中时显示"第几处/共几处"（视口内第一个命中的序号），行数多时再加行号范围
    const end = Math.min(this.previewOffset + H, this.previewLines.length);
    let info = "";
    if (this.matchLines.length) {
      const i = this.matchLines.findIndex((l) => l >= this.previewOffset && l < end);
      info += msg("hitPos", { k: i >= 0 ? String(i + 1) : "-", n: this.matchLines.length });
    }
    if (this.previewLines.length > H) info += ` (${this.previewOffset + 1}-${end}/${this.previewLines.length})`;
    const scrollInfo = info ? t.fg("dim", info) : "";

    const sel = this.drag.active();
    // 菜单盒子盖到左栏上，坐标相对主体；每次重画重算，终端大小变了也跟着重新摆放
    let overlay: { top: number; left: number; lines: string[] } | undefined;
    this.menuBox = undefined;
    if (this.menu) {
      const items = this.menu.items;
      const box = menuLayout(this.menu.anchorRow, this.menu.anchorCol, items.length, H, lw, menuWidth(items));
      this.menuBox = box;
      overlay = { ...box, lines: menuLines(items, this.menu.index, box.width, t) };
    }
    for (let i = 0; i < H; i++) {
      let l = leftRows[i] ?? " ".repeat(lw);
      let r = rightRows[i] ?? "";
      if (overlay) {
        const k = i - overlay.top;
        const line = overlay.lines[k];
        if (line !== undefined) {
          const start = Math.min(overlay.left, lw);
          const len = Math.min(visibleWidth(line), lw - start);
          l = sliceByColumn(l, 0, start) + line + sliceByColumn(l, start + len, lw - start - len);
        }
      }
      const infoW = i === 0 && scrollInfo ? visibleWidth(scrollInfo) : 0;
      if (infoW) r = truncateToWidth(r, Math.max(0, rw - infoW));
      r = padEndVisible(r, rw - infoW) + (infoW ? scrollInfo : "");
      // 拖选的高亮最后叠上去，反显整格；右栏第一行别盖到右上角的命中信息
      if (sel?.pane === "list") {
        const cols = rowColumns(sel, this.listOffset * 2 + i, l, lw);
        if (cols) l = highlightColumns(l, cols[0], cols[1]);
      } else if (sel?.pane === "preview") {
        const cols = rowColumns(sel, this.previewOffset + i, r, rw - infoW);
        if (cols) r = highlightColumns(r, cols[0], cols[1]);
      }
      // 左栏在 buildList 里已经 pad 到 lw，这里再 pad 会把带样式的行截坏
      out.push(l + t.fg("borderMuted", " │ ") + r);
    }

    // 底部：重命名和删除确认时换成对应的操作行，复制结果和选区提示也在这里
    out.push(t.fg("borderMuted", "─".repeat(width)));
    if (this.mode === "rename") {
      const prefix = msg("renamePrefix");
      const inputLine = this.renameInput.render(Math.max(10, width - visibleWidth(prefix)))[0] ?? "";
      out.push(truncateToWidth(t.fg("warning", prefix) + inputLine, width));
    } else if (this.mode === "confirmDelete") {
      const s = this.filtered[this.selected];
      const desc = !s ? "" : s.pending ? `${fmtTime(s.time, true)} ${msg("loadingSession")}` : `${fmtTime(s.time, true)} ${s.first.slice(0, 30)}`;
      out.push(
        truncateToWidth(
          t.fg("error", t.bold(msg("confirmDelete", { desc }))),
          width,
        ),
      );
    } else if (this.hint) {
      out.push(truncateToWidth(t.fg(this.hint.ok ? "success" : "error", this.hint.text), width));
    } else if (this.menu) {
      out.push(truncateToWidth(t.fg("warning", msg("menuHint")), width));
    } else if (sel) {
      const [s, e] = bounds(sel);
      out.push(truncateToWidth(t.fg("warning", msg("selHint", { n: e.row - s.row + 1 })), width));
    } else {
      out.push(
        truncateToWidth(
          t.fg("dim", msg("footer")),
          width,
        ),
      );
    }

    this.cachedWidth = cacheKey;
    this.cachedLines = out;
    this.afterRender?.();
    return out;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.input.invalidate();
  }
}
