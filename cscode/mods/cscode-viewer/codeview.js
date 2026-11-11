// Colored lines with character selection. `list` rows can't carry pointer handlers, so this
// draws its own viewport: fixed-height rows (no wrap), wheel scrolling, a draggable scrollbar.
// Each row is cut into chunks whose characters share one width (narrow, wide or a single
// astral character); a press or move inside a chunk finds its column from the chunk's own
// bounds, so the font's real advances never need to be known.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

const ROW = 20, CHUNK = 12, MAX_COLS = 4000, PAD = 6;
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const WORD = /[\p{L}\p{N}_$-]/u;
const before = (a, b) => a.line < b.line || (a.line === b.line && a.col < b.col);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class CodeView {
  constructor(focus) {
    this.focus = focus;
    this.y = 0; this.x = 0; this.size = { width: 0, height: 0 }; this.cw = 8;
    this.sel = null; this.drag = false; this.thumb = null; this.lines = [];
  }

  /** lines: [[kind, text]] per line, tabs already spaces; source: the file's own text. */
  setLines(lines, source) {
    this.lines = lines;
    this.text = lines.map(l => l.map(([, s]) => s).join(""));
    this.source = source.split("\n");
    this.chunks = new Map();
    this.longest = this.text.reduce((n, s) => Math.max(n, Math.min(s.length, MAX_COLS)), 0);
    if (this.sel) {
      const fix = (p) => ({ line: Math.min(p.line, lines.length - 1), col: p.col });
      this.sel = { anchor: fix(this.sel.anchor), head: fix(this.sel.head) };
    }
    this.y = clamp(this.y, 0, this.maxY());
  }

  maxY() { return Math.max(0, this.lines.length * ROW + 2 * PAD - this.size.height); }
  maxX(gutter) { return Math.max(0, this.longest * this.cw + 40 - (this.size.width - gutter)); }

  range() {
    if (!this.sel) return null;
    const { anchor, head } = this.sel;
    if (anchor.line === head.line && anchor.col === head.col) return null;
    return before(head, anchor) ? [head, anchor] : [anchor, head];
  }

  selectedText() {
    const r = this.range();
    if (!r) return "";
    const [a, b] = r, out = [];
    for (let i = a.line; i <= b.line; i++)
      out.push(this.original(i, i === a.line ? a.col : 0, i === b.line ? b.col : Infinity));
    return out.join("\n");
  }

  // Display columns (tab = 4) back to the file's own characters.
  original(i, from, to) {
    const src = this.source[i] ?? "";
    if (!/[\t\r]/.test(src)) return src.slice(from, to);
    let col = 0, out = "";
    for (const ch of src) {
      const w = ch === "\t" ? 4 : ch === "\r" ? 0 : ch.length;
      if (w && col >= from && col + w <= to) out += ch;
      col += w;
    }
    return out;
  }

  selectAll() {
    const last = this.lines.length - 1;
    this.sel = { anchor: { line: 0, col: 0 }, head: { line: last, col: this.text[last]?.length ?? 0 } };
  }

  chunksOf(i) {
    let out = this.chunks.get(i);
    if (out) return out;
    out = [];
    let col = 0;
    for (const [kind, s] of this.lines[i]) {
      let cur = null;
      for (const ch of s) {
        if (col >= MAX_COLS) break;
        const cls = ch.length > 1 ? "astral" : WIDE.test(ch) ? "wide" : "narrow";
        if (!cur || cur.cls !== cls || cls === "astral" || cur.n >= CHUNK) {
          cur = { kind, cls, col, text: "", n: 0, offsets: [0] };
          out.push(cur);
        }
        cur.text += ch; cur.n++; col += ch.length; cur.offsets.push(cur.text.length);
      }
    }
    if (this.text[i].length > MAX_COLS) out.push({ kind: "comment", cls: "more", col, text: " …", n: 0, offsets: [0] });
    this.chunks.set(i, out);
    return out;
  }

  hit(chunk, e) {
    if (!chunk.n) return chunk.col;
    const w = e.bounds?.width || 1, x = e.local_position?.x ?? 0;
    if (chunk.cls === "narrow") this.cw = w / chunk.n;
    return chunk.col + chunk.offsets[clamp(Math.round(x / (w / chunk.n)), 0, chunk.n)];
  }

  press(line, col, e, cx) {
    this.focus.focus();
    const at = { line, col }, text = this.text[line] ?? "";
    this.drag = false;
    if (e.click_count === 2) {
      let a = col, b = col;
      while (a > 0 && WORD.test(text[a - 1])) a--;
      while (b < text.length && WORD.test(text[b])) b++;
      this.sel = { anchor: { line, col: a }, head: { line, col: b } };
    } else if (e.click_count >= 3) {
      this.sel = line + 1 < this.lines.length
        ? { anchor: { line, col: 0 }, head: { line: line + 1, col: 0 } }
        : { anchor: { line, col: 0 }, head: { line, col: text.length } };
    } else {
      this.sel = e.modifiers.shift && this.sel ? { anchor: this.sel.anchor, head: at } : { anchor: at, head: at };
      this.drag = true;
    }
    cx.notify();
  }

  move(line, col, cx) {
    if (!this.drag || !this.sel) return;
    const h = this.sel.head;
    if (h.line === line && h.col === col) return;
    this.sel = { anchor: this.sel.anchor, head: { line, col } };
    cx.notify();
  }

  /** Keys while the view has the keyboard; returns whether it used the key. */
  key(e, copy) {
    const cmd = e.modifiers.platform && !e.modifiers.alt, page = Math.max(ROW, this.size.height - 2 * ROW);
    const scroll = (dy) => { this.y = clamp(this.y + dy, 0, this.maxY()); };
    if (cmd && e.key === "c") copy(this.selectedText());
    else if (cmd && e.key === "a") this.selectAll();
    else if (e.key === "escape" && this.sel) this.sel = null;
    else if (e.key === "down") scroll(cmd ? Infinity : ROW);
    else if (e.key === "up") scroll(cmd ? -Infinity : -ROW);
    else if (e.key === "pagedown" || (e.key === "space" && !e.modifiers.shift)) scroll(page);
    else if (e.key === "pageup" || (e.key === "space" && e.modifiers.shift)) scroll(-page);
    else if (e.key === "home") scroll(-Infinity);
    else if (e.key === "end") scroll(Infinity);
    else return false;
    return true;
  }

  render(t, color, font) {
    const n = this.lines.length, gutter = String(n).length * 9 + 24, r = this.range();
    const selBg = /^#[\da-f]{6}$/i.test(t.accent) ? `${t.accent}40` : t.selected;
    const first = clamp(Math.floor((this.y - PAD) / ROW), 0, Math.max(0, n - 1));
    const count = Math.ceil(this.size.height / ROW) + 2, last = Math.min(n, first + count);
    const offset = this.y - PAD - first * ROW;
    this.x = clamp(this.x, 0, this.maxX(gutter));
    const rows = [];
    for (let i = first; i < last; i++) rows.push(this.row(i, t, color, gutter, r, selBg));
    const h = this.size.height, total = n * ROW + 2 * PAD, maxY = this.maxY();
    const thumbH = total > h && h > 0 ? Math.max(24, (h * h) / total) : 0;
    const thumbTop = maxY ? (this.y / maxY) * (h - thumbH) : 0;
    return v_flex().id("fv-view").relative().flex_1().min_h(0).overflow_hidden().cursor_text()
      .when(Boolean(font), el => el.font_family(font)).text_size(13)
      .on_size_change((size, cx) => { this.size = size; this.y = clamp(this.y, 0, this.maxY()); cx.notify(); })
      .on_scroll_wheel((e, cx) => {
        const dx = e.modifiers.shift && !e.delta.x ? e.delta.y : e.delta.x, dy = e.modifiers.shift ? 0 : e.delta.y;
        this.y = clamp(this.y - dy, 0, this.maxY());
        this.x = clamp(this.x - dx, 0, this.maxX(gutter));
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { this.drag = false; this.thumb = null; cx.notify(); })
      .on_hover((hovered) => { if (!hovered) { this.drag = false; this.thumb = null; } })
      .on_mouse_move((e, cx) => {
        if (!this.thumb) return;
        const room = Math.max(1, h - thumbH);
        this.y = clamp(this.thumb.y + ((e.position.y - this.thumb.at) * maxY) / room, 0, maxY);
        cx.notify();
      })
      .child(v_flex().mt(-offset).children(rows))
      .when(thumbH > 0, el => el.child(div().id("fv-track").absolute().top(0).right(0).bottom(0).w(10)
        .child(div().id("fv-thumb").absolute().right(2).w(6).top(thumbTop).h(thumbH).rounded(3).bg(t.border)
          .hover(s => s.bg(t.input))
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.thumb = { at: e.position.y, y: this.y }; }))));
  }

  row(i, t, color, gutter, r, selBg) {
    const text = this.text[i], from = r && i >= r[0].line && i <= r[1].line ? (i === r[0].line ? r[0].col : 0) : -1;
    const to = from < 0 ? -1 : i === r[1].line ? r[1].col : Infinity;
    const cells = this.chunksOf(i).map((c, k) => {
      const end = c.col + c.text.length, a = Math.max(from, c.col), b = Math.min(to, end);
      const cell = h_flex().id(`c${k}`).flex_none().text_color(color[c.kind] ?? t.foreground)
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.press(i, this.hit(c, e), e, cx); })
        .on_mouse_move((e, cx) => { cx.stop_propagation(); this.move(i, this.hit(c, e), cx); });
      if (from < 0 || a >= b) return cell.child(c.text);
      const s = c.text, p = a - c.col, q = b - c.col;
      return cell.when(p > 0, el => el.child(s.slice(0, p))).child(div().bg(selBg).child(s.slice(p, q)))
        .when(q < s.length, el => el.child(s.slice(q)));
    });
    return h_flex().id(`r${i}`).h(ROW).flex_none().items_center().whitespace_nowrap()
      .on_mouse_down("left", (e, cx) => this.press(i, text.length, e, cx))
      .on_mouse_move((_e, cx) => this.move(i, text.length, cx))
      .child(div().id("g").w(gutter).flex_none().pr(14).text_right().text_color(t.dim).bg(t.background)
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.press(i, 0, e, cx); })
        .on_mouse_move((_e, cx) => { cx.stop_propagation(); this.move(i, 0, cx); })
        .child(String(i + 1)))
      .child(h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden()
        .child(h_flex().relative().left(-this.x).flex_none().h_full().items_center().children(cells)
          .when(to === Infinity, el => el.child(div().w(6).h(ROW - 4).bg(selBg)))));
  }
}
