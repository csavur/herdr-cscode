// One file in its own Herdr tab, opened by `cscode-files` (props: { file, on }): edit, save
// (cmd-s), close (ctrl-w, which asks about unsaved changes; cmd-w is tab.close and does
// not). A read-only preview (cmd-shift-v toggles it with the editor) renders Markdown and
// colors every other known format with ./highlight.js, drawn and selected by ./codeview.js;
// plain text, files over BIG characters and EDITOR_FIRST code open in the editor.
// A `mod:cscode-viewer` key does not stop a global binding on the same key, so these keys
// must stay unbound globally.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, spaces, panes, focused, run, exec, nextCommand, readTextFile, writeTextFile, watchFolder, theme, settings, home, shared, setShared } from "herdr";

// Preview tabs, as VS Code's: `cscode-files` opens a single-clicked file in its space's
// preview tab and later sends the next one there instead of opening another tab.
// props().doc names this viewer. shared(PREVIEW): { <space>: { tab, doc } }, the
// preview tab of each space; shared(SHOW): { id, doc, file, on }, a file for the
// viewer `doc` to show in place. Unsaved edits keep a preview tab: it stops being one.
const PREVIEW = "cscode-viewer:preview", SHOW = "cscode-viewer:show";
const isPreview = (doc) => Boolean(doc) && Object.values(shared(PREVIEW) ?? {}).some((v) => v?.doc === doc);
function unpreview(doc) {
  const all = shared(PREVIEW) ?? {}, kept = Object.fromEntries(Object.entries(all).filter(([, v]) => v?.doc !== doc));
  if (Object.keys(kept).length !== Object.keys(all).length) setShared(PREVIEW, kept);
}
import { lex, family } from "./highlight.js";
import { CodeView } from "./codeview.js";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml",
  jsonc: "json", json5: "json", jsonl: "json", geojson: "json", md: "markdown", mdx: "markdown", markdown: "markdown",
  sh: "bash", zsh: "bash", htm: "html", svelte: "html", vue: "html" };
const LIMIT = 400000;
const base = (file) => file.split(/[\\/]/).pop();
const folder = (file) => file.replace(/[\\/][^\\/]*$/, "") || "/";
function ext(file) {
  const name = base(file);
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "txt";
}
const isMarkdown = (file) => LANG[ext(file)] === "markdown";
// Lexing runs on the UI thread; past this the preview waits until asked for.
const BIG = 200000;
// The editor's own grammars already color these well, and they are edited more than read.
const EDITOR_FIRST = new Set(["js", "py", "go", "css", "sh"]);
// The editor knows only these names; the grammar maps everything onto them
// (JSON keys and values are both `string`).
function syntax(t) {
  return { keyword: t.ansi5, string: t.ansi2, "string.escape": t.ansi6, comment: t.dim, function: t.ansi4,
    type: t.ansi3, number: t.ansi1, boolean: t.ansi1, constant: t.ansi6, operator: t.muted, punctuation: t.dim };
}
// Token kinds from ./highlight.js.
function palette(t) {
  return { plain: t.foreground, key: t.ansi4, string: t.ansi2, number: t.ansi1, constant: t.ansi6, keyword: t.ansi5,
    function: t.ansi4, type: t.ansi3, comment: t.dim, punct: t.muted, meta: t.ansi6, section: t.ansi5, tag: t.ansi5,
    attr: t.ansi3, added: t.ansi2, removed: t.ansi1, hunk: t.ansi6 };
}

export default class FileViewer extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.doc = p.doc ?? null;
    this.showDone = shared(SHOW)?.id;
    this.focus = cx.focus_handle();
    this.load(p.file, p.on ?? null, cx);
    cx.spawn(async cx => {
      for (;;) {
        const command = String(await nextCommand()).split(/[.:]/).pop();
        if (!this.d) continue;
        if (command === "save") await this.save(false);
        if (command === "close") this.closeFile();
        if (command === "preview" && this.d.previewable) this.d.preview = !this.d.preview;
        cx.notify();
      }
    });
  }

  // Shows `file` (its props', or the next one sent to this preview tab): read now,
  // then watched (here) or polled (another machine). The last file's watch ends.
  load(file, on, cx) {
    this.d?.state?.release();
    this.poll?.cancel(); this.poll = null;
    this.gen = (this.gen ?? 0) + 1;
    this.asking = false; this.lexed = null;
    this.view = new CodeView(this.focus);
    const fam = file ? family(file) : "plain", previewable = file ? isMarkdown(file) || fam !== "plain" : false;
    this.d = file ? { file, on, fam, previewable, preview: previewable && !EDITOR_FIRST.has(fam),
      text: "", state: null, saved: undefined, disk: undefined, dirty: false, readonly: false, truncated: false,
      error: null, status: null } : null;
    if (!this.d) return;
    this.read(cx);
    // watchFolder is local only, so a file on another machine is polled.
    if (on) this.poll = cx.timer.every(10000, cx => this.read(cx));
    else this.watch(cx);
  }

  read(cx) {
    const d = this.d;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(d.file, { on: d.on });
        if (text === d.saved) { d.disk = undefined; return; }
        // Changed on disk under unsaved edits: keep the edits and say so.
        if (d.dirty) { d.disk = text; return; }
        d.saved = text; d.disk = undefined; d.error = null;
        if (text === null) { d.error = "This file is no longer available"; return; }
        if (text.includes("\0")) { d.error = "Binary file · no text preview"; return; }
        const truncated = text.length > LIMIT, readonly = Boolean(d.on) || truncated;
        const value = truncated ? text.slice(0, LIMIT) + "\n… (file truncated)" : text;
        d.text = value;
        if (d.state && d.readonly === readonly) { d.state.set_value(value); return; }
        if (!d.state && value.length > BIG && !isMarkdown(d.file)) d.preview = false;
        d.state?.release(); d.readonly = readonly; d.truncated = truncated;
        d.state = EditorState.new({ language: LANG[ext(d.file)] ?? ext(d.file), readonly, value,
          font_family: settings().font_family, font_size: 13, soft_wrap: isMarkdown(d.file), syntax: syntax(theme()) });
        d.state.on("change", (_e, cx) => {
          d.text = d.state.value();
          const dirty = !d.readonly && d.text !== d.saved;
          if (dirty) d.status = null;
          if (dirty === d.dirty) return;
          d.dirty = dirty;
          // Edited: no longer a preview, so the next single click won't replace it.
          if (dirty) unpreview(this.doc);
          if (!dirty && d.disk !== undefined) { d.saved = undefined; this.read(cx); }
          cx.notify();
        });
      } catch { d.error = "Cannot open this file (binary, over 1 MiB, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  watch(cx) {
    const { file } = this.d, dir = folder(file), name = base(file), gen = this.gen;
    cx.spawn(async cx => {
      try {
        // Ends once another file is shown here.
        while (this.gen === gen) {
          const changed = await watchFolder(dir);
          if (this.gen !== gen) return;
          if (changed.some(p => p === file || p.endsWith(`/${name}`))) this.read(cx);
        }
      } catch { /* the folder went away; the next read reports it */ }
    });
  }

  async save(overwrite) {
    const d = this.d;
    if (!d?.state || d.readonly || d.error) return;
    if (!d.dirty && !overwrite) { d.status = "No changes to save"; return; }
    const text = d.state.value();
    try {
      const expected = overwrite ? await readTextFile(d.file) : d.saved;
      await writeTextFile(d.file, text, expected ?? null);
      d.saved = text; d.disk = undefined; d.dirty = false; d.status = "Saved";
      if (this.asking) { this.asking = false; this.leave(); }
    } catch (e) {
      // A stale snapshot: someone (an agent) wrote the file since it was read.
      const now = await readTextFile(d.file).catch(() => undefined);
      if (now !== undefined && now !== d.saved) d.disk = now;
      else d.status = `Save failed: ${String(e?.message ?? e)}`;
    }
  }

  reload(cx) {
    Object.assign(this.d, { dirty: false, disk: undefined, saved: undefined, status: null });
    this.read(cx);
  }

  closeFile() {
    if (this.d?.dirty && !this.asking) { this.asking = true; return; }
    this.asking = false;
    this.leave();
  }

  // Its key and buttons act with this pane focused. Closes the whole tab only when this
  // viewer is all it holds; a terminal split in beside it stays.
  leave() {
    const f = focused(), me = panes().find(p => p.pane === f?.pane && p.mod === "cscode-viewer");
    if (!me) return;
    const tab = spaces().flatMap(s => s.tabs ?? []).find(t => t.id === me.tab);
    if (tab && tab.panes <= 1) run("tab.close", { id: me.tab });
    else run("pane.close", { pane: me.pane });
  }

  button(t, key, label, action) {
    return h_flex().id(key).h(22).px(8).flex_none().items_center().rounded(5).border_1().border_color(t.input)
      .cursor_pointer().hover(s => s.bg(t.hover)).text_color(t.foreground)
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); cx.notify(); }).child(label);
  }

  status(t, d) {
    const later = (fn) => (cx) => cx.spawn(async cx => { await fn(); cx.notify(); });
    const mode = d.previewable && d.state && !d.error
      ? [this.button(t, "fv-mode", d.preview ? "Edit" : "Preview", () => { d.preview = !d.preview; })] : [];
    const copy = d.preview && !isMarkdown(d.file) && this.view.range()
      ? [this.button(t, "fv-copy", "Copy  ⌘C", (cx) => this.copy(this.view.selectedText(), cx))] : [];
    return [...this.notice(t, d, later), ...copy, ...mode];
  }

  copy(text, cx) {
    if (!text) return;
    this.d.status = `Copied ${text.length.toLocaleString()} characters`;
    try { cx.write_to_clipboard(text); }
    catch {
      // Without a clipboard grant, pbcopy does it (macOS only).
      cx.spawn(async cx => {
        const r = await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text]).catch(e => ({ code: 1, stderr: String(e) }));
        if (r.code !== 0) { this.d.status = `Copy failed: ${(r.stderr || "pbcopy").trim()}`; cx.notify(); }
      });
    }
  }

  notice(t, d, later) {
    if (this.asking) return [div().text_color(t.blocked).child("Unsaved changes"),
      this.button(t, "fv-ask-save", "Save", later(() => this.save(false))),
      this.button(t, "fv-ask-drop", "Don't save", () => { this.asking = false; this.leave(); }),
      this.button(t, "fv-ask-cancel", "Cancel", () => { this.asking = false; })];
    if (d.disk !== undefined) return [div().text_color(t.blocked).child("Changed on disk"),
      this.button(t, "fv-overwrite", "Overwrite", later(() => this.save(true))),
      this.button(t, "fv-reload", "Reload", (cx) => this.reload(cx))];
    if (d.on) return [div().text_color(t.dim).child("Read-only (another machine)")];
    if (d.truncated) return [div().text_color(t.dim).child("Read-only (too large to edit)")];
    if (d.dirty) return [div().text_color(t.blocked).child("Unsaved"), this.button(t, "fv-save", "Save  ⌘S", later(() => this.save(false)))];
    return d.status ? [div().text_color(/failed/.test(d.status) ? t.ansi1 : t.dim).child(d.status)] : [];
  }

  render(cx) {
    // A file sent to this preview tab: shown in place (never over unsaved edits).
    const req = shared(SHOW);
    if (req && req.id !== this.showDone) {
      this.showDone = req.id;
      if (this.doc && req.doc === this.doc && !this.d?.dirty && (req.file !== this.d?.file || (req.on ?? null) !== this.d?.on)) this.load(req.file, req.on ?? null, cx);
    }
    const t = theme(), d = this.d, preview = isPreview(this.doc);
    if (!d) return div().size_full().p(12).bg(t.background).text_color(t.dim).child("No file");
    let dir = folder(d.file);
    if (!d.on && dir.startsWith(home())) dir = "~" + dir.slice(home().length);
    return v_flex().id("cscode-viewer").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        // In italics while it's the preview tab (as VS Code).
        .child(div().flex_none().text_size(13).font_semibold().text_color(d.dirty ? t.blocked : t.foreground).when(preview, el => el.italic())
          .child(d.dirty ? `● ${base(d.file)}` : base(d.file)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(d.on ? `${d.on}:${dir}` : dir))
        .children(this.status(t, d)))
      .child(!d.state || d.error
        ? div().p(12).text_color(t.dim).child(d.error || "Loading file…")
        : !d.preview ? Editor.new(d.state).flex_1().min_h(0)
        : isMarkdown(d.file)
          ? v_flex().id("fv-preview").flex_1().min_h(0).overflow_y_scrollbar().px(24).py(16)
            .child(TextView.markdown("fv-md", d.text).selectable(true))
          : this.highlighted(t, d));
  }

  highlighted(t, d) {
    if (this.lexed !== d.text) { this.lexed = d.text; this.view.setLines(lex(d.text, d.fam), d.text); }
    return v_flex().id("fv-hl").flex_1().min_h(0).track_focus(this.focus)
      .on_key_down((e, cx) => {
        if (!this.view.key(e, (text) => this.copy(text, cx))) return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(this.view.render(t, palette(t), settings().font_family));
  }
}
