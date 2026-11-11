// A lazy file browser for the focused pane's folder. A click opens the file in the
// space's preview tab (a `cscode-viewer` mod), a double click in a tab of its own, or
// either shows the tab already open for it; Cmd-click opens it in the system's default app.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, run, shared, setShared, notify, openOverlay, settings, agents, hc } from "herdr";
import { icon } from "./lookup.js";

// shared(OPEN): { "<on>|<file>": { tab, root } }, root being the tree's folder when the
// file was opened. Older entries are a bare tab id.
// shared(MENU): the action chosen in the `cscode-file-menu` popup, { id, context, action, path }.
// Preview tabs, as VS Code's: a single click shows the file in its space's preview tab
// (replacing what it showed), a double click keeps it in a tab of its own.
// shared(PREVIEW): { <space>: { tab, doc } }; shared(SHOW): { id, doc, file, on }, the
// file the viewer named `doc` (its props' doc) shows in place. The viewer drops its
// preview entry once edited.
const VIEWER = "cscode-viewer", OPEN = "cscode-viewer:open", MENU = "cscode-files:menu";
const PREVIEW = "cscode-viewer:preview", SHOW = "cscode-viewer:show";
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let last = null;

const docKey = (file, on) => `${on ?? ""}|${file}`;
const tabOf = (entry) => typeof entry === "string" ? entry : entry?.tab;
const hasViewer = (tab) => panes().some(p => p.tab === tab && p.mod === VIEWER);
const openIn = (tab) => tab ? Object.entries(shared(OPEN) ?? {}).find(([, v]) => tabOf(v) === tab) : null;
const viewing = (tab) => openIn(tab)?.[0] ?? null;

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  // A file tab has no folder of its own: show the one its file was opened from.
  const opened = pane?.mod === VIEWER && openIn(f.tab);
  if (opened) {
    const [k, v] = opened, bar = k.indexOf("|"), file = k.slice(bar + 1);
    return { cwd: v?.root ?? (file.replace(/[\\/][^\\/]*$/, "") || "/"), on: k.slice(0, bar) || null, space: space?.id };
  }
  // Another mod pane has no folder either: keep the tree where it was.
  if (pane?.mod && last?.space === space?.id) return last;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return (last = { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id });
}
const PER_FOLDER = 500, TOTAL = 5000;

// Git marks, as VS Code decorates them: a changed file's name in its mark's colour,
// and every folder above it (up to the tree's root) with a dot and its name coloured
// by the most serious change inside: conflict, deleted, modified, then added.
const RANK = { U: 4, D: 3, M: 2, A: 1 };
const stronger = (a, b) => (!a || RANK[b] > RANK[a] ? b : a);
// The theme's terminal colours, which every theme sets: added green, modified
// yellow, deleted red, conflict magenta (as VS Code).
const markColor = (t, mark) => ({ A: t.ansi2, M: t.ansi3, D: t.ansi1, U: t.ansi5 })[mark] ?? t.muted;
// Each mark's icon (shipped with workspace-chrome) and what it means, for the badge.
const MARK_ICON = { A: "plus", M: "square-pen", D: "minus", U: "git-compare" };
const MARK_NAME = { A: "Added", M: "Modified", D: "Deleted", U: "Conflict" };
const parentOf = (path) => path.replace(/\/[^/]*$/, "");
// marks: absolute path -> letter; root: the tree's folder. Gives the folders to
// mark between them: absolute path -> letter.
function folderMarks(marks, root) {
  const out = {};
  for (const [path, mark] of Object.entries(marks))
    for (let p = parentOf(path); p.length > root.length && p.startsWith(root + "/"); p = parentOf(p)) out[p] = stronger(out[p], mark);
  return out;
}
// "Changed only": the tree of the changed paths under root, as the folder listing
// gives it (folder path relative to root, "" for root -> its entries, folders
// first), built from git's list alone, so nothing else is listed and deleted
// files are there too.
function changedTree(marks, root) {
  const tree = new Map();
  for (const path of Object.keys(marks)) {
    if (!path.startsWith(root + "/")) continue;
    const parts = path.slice(root.length + 1).split("/");
    let prefix = "";
    parts.forEach((name, i) => {
      if (!tree.has(prefix)) tree.set(prefix, new Map());
      const level = tree.get(prefix), dir = i < parts.length - 1;
      if (dir || !level.has(name)) level.set(name, { name, dir: dir || Boolean(level.get(name)?.dir) });
      prefix = prefix ? `${prefix}/${name}` : name;
    });
  }
  return new Map([...tree].map(([prefix, level]) => [prefix,
    [...level.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))]));
}

// Worktrees, for "changed only": `git worktree list --porcelain` as
// [{ path, branch, main }], the main checkout first (as git lists it).
function parseWorktrees(out) {
  const list = [];
  for (const block of out.split(/\n\n+/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path || /^bare$/m.test(block)) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? (/^detached$/m.test(block) ? "detached" : "");
    list.push({ path: path.replace(/\/+$/, ""), branch, main: list.length === 0 });
  }
  return list;
}
const within = (path, dir) => Boolean(path) && (path === dir || path.startsWith(dir + "/"));
// The worktree a folder is in: the deepest one holding it (one may sit inside another).
const worktreeOf = (path, list) => list.filter(w => within(path, w.path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
const machineOf = (address) => address.includes("/") ? address.slice(0, address.indexOf("/")) : null;
// An agent's name, as the agents list gives it: its terminal's title (Claude Code
// titles it with the task), else its tab's, else the program's.
function agentName(a) {
  const title = (a.title ?? "").replace(/^[^\p{L}\p{N}[(]+/u, "").trim();
  return title && title !== a.program?.name && !/^[~/]/.test(title) ? title : a.tab_name || a.program?.name || "Agent";
}
// Which agent works in which worktree. Agents edit by full path, so a terminal can
// sit in the main checkout while its agent works in another: an agent belongs to the
// worktree its recent output names last (by path or folder name), else to the one
// its terminal is in. Agents elsewhere are left out.
async function agentsByWorktree(list, on) {
  const out = new Map(list.map(w => [w.path, []]));
  const cwdOf = (a) => panes().find(p => p.terminal === a.address)?.cwd ?? null;
  const others = list.filter(w => !w.main).map(w => ({ w, name: new RegExp(`(^|[^\\w.-])${w.path.split("/").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g") }));
  for (const a of agents()) {
    if (machineOf(a.address) !== (on ?? null)) continue;
    const home = worktreeOf(cwdOf(a), list);
    if (!home) continue;
    let best = home, at = -1;
    if (others.length) {
      const text = (await hc(["read", a.address, "--lines", "400"]).catch(() => null))?.stdout ?? "";
      for (const { w, name } of others) for (const m of text.matchAll(name)) if (m.index > at) { at = m.index; best = w; }
    }
    out.get(best.path).push(a.address);
  }
  return out;
}

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-Command", "& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.menuDone = shared(MENU)?.id;
    try { this.hideDots = localStorage.getItem("hideDots") === "1"; } catch { this.hideDots = false; }
    // Changed only (the filter button): every folder open unless folded here.
    try { this.changedOnly = localStorage.getItem("changedOnly") === "1"; } catch { this.changedOnly = false; }
    this.folded = new Set();
    // Changed only, in a repo with worktrees: each one with its change count and
    // agents, and the one picked to show (null: where the focused pane is).
    this.worktrees = [];
    this.pick = null; // { base, on, path }
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  // Where the tree is: the focused pane's folder, or the worktree picked for it.
  place() {
    const loc = location(), p = this.pick;
    return this.changedOnly && p && p.base === loc.cwd && p.on === loc.on ? { ...loc, cwd: p.path } : loc;
  }
  placeKey() { return JSON.stringify(this.place()); }

  pickWorktree(w, cx) {
    const loc = location();
    // The worktree the pane is in: back to following the pane.
    this.pick = within(loc.cwd, w.path) && worktreeOf(loc.cwd, this.worktrees)?.path === w.path ? null : { base: loc.cwd, on: loc.on, path: w.path };
    this.refresh(cx);
    cx.notify();
  }

  // The repo's worktrees, their change counts and agents (only when there's more than one).
  async loadWorktrees(cwd, on) {
    const r = await exec("git", ["worktree", "list", "--porcelain"], { cwd, on }).catch(() => null);
    const list = r?.code === 0 ? parseWorktrees(r.stdout) : [];
    if (list.length < 2) return [];
    for (const w of list) {
      const s = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: w.path, on }).catch(() => null);
      w.changes = s?.code === 0 ? s.stdout.split("\0").filter(Boolean).length : null;
    }
    const by = await agentsByWorktree(list, on);
    for (const w of list) w.agents = by.get(w.path) ?? [];
    return list;
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && this.placeKey() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = this.place(), next = this.placeKey();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.folderMarks = {}; this.untracked = []; this.watched = null; this.error = null; this.limited = false;
      this.folded = new Set(); this.tree = null; this.isRepo = false;
      // Same repo, another worktree: keep the list until it's read again.
      if (!this.worktrees.some(w => within(cwd, w.path))) this.worktrees = [];
      this.loading = false;
    }
    if (!cwd) return;
    // A refresh asked for meanwhile (the filter switched) runs when this one ends.
    if (this.loading) { this.rerun = true; return; }
    const context = this.context, changedOnly = this.changedOnly;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        // Changed only lists nothing: its tree comes from git.
        for (const path of changedOnly ? [] : ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {}, untracked = [];
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          // Changed only shows every new file, so git lists those inside new folders too.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", `--untracked-files=${changedOnly ? "all" : "normal"}`], { cwd, on }).catch(() => null);
          if (status?.code === 0 && status.stdout.split("\0").filter(Boolean).length > TOTAL) this.limited = true;
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2), rel = entry.slice(3), path = `${top.stdout.trim()}/${rel.replace(/\/$/, "")}`;
            marks[path] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
            // A new folder is listed once, as "dir/": everything in it is new too.
            if (rel.endsWith("/")) untracked.push(path);
          }
        }
        const worktrees = changedOnly && top?.code === 0 ? await this.loadWorktrees(cwd, on) : [];
        if (!this.current(context)) return;
        this.marks = marks; this.untracked = untracked; this.folderMarks = folderMarks(marks, cwd.replace(/\/+$/, ""));
        this.isRepo = top?.code === 0; this.tree = null; this.worktrees = worktrees;
        this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) this.loading = false;
        if (this.rerun) { this.rerun = false; this.refresh(cx); }
        cx.notify();
      }
    });
  }

  toggleChanged(cx) {
    this.changedOnly = !this.changedOnly;
    try { localStorage.setItem("changedOnly", this.changedOnly ? "1" : "0"); } catch {}
    this.tree = null;
    this.refresh(cx);
    cx.notify();
  }

  // Changed only: its tree (made again after each refresh), and folding a folder in it.
  changed() {
    return (this.tree ??= changedTree(this.marks, (this.root ?? "").replace(/\/+$/, "")));
  }
  fold(path, cx) {
    if (this.folded.has(path)) this.folded.delete(path); else this.folded.add(path);
    cx.notify();
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // keep: a double click, the file in a tab of its own. Else it goes to this space's
  // preview tab (made if there's none). A file already open shows its tab either way.
  open(path, keep = false) {
    if (!this.root) return;
    const file = `${this.root}/${path}`, on = this.on, key = docKey(file, on), open = { ...(shared(OPEN) ?? {}) };
    const space = location().space, previews = { ...(shared(PREVIEW) ?? {}) }, pv = previews[space];
    const tab = tabOf(open[key]);
    if (tab && hasViewer(tab)) {
      run("tab.select", { id: tab });
      // Kept: the preview tab showing it becomes its own.
      if (keep && pv?.tab === tab) { delete previews[space]; setShared(PREVIEW, previews); }
      return;
    }
    // A double click's second click while its first one's tab is still opening.
    if (this.opening?.key === key) { this.opening.keep ||= keep; return; }
    if (open[key]) delete open[key];
    const inSpace = pv && hasViewer(pv.tab) && spaces().find(s => s.id === space)?.tabs?.some(t => t.id === pv.tab);
    if (!keep && inSpace) {
      // The preview tab shows this file instead: it's no longer open for the last one.
      for (const [k, v] of Object.entries(open)) if (tabOf(v) === pv.tab) delete open[k];
      setShared(OPEN, { ...open, [key]: { tab: pv.tab, root: this.root } });
      setShared(SHOW, { id: newId(), doc: pv.doc, file, on });
      run("tab.rename", { id: pv.tab, name: path.split("/").pop() });
      run("tab.select", { id: pv.tab });
      return;
    }
    setShared(OPEN, open);
    // run() gives back no tab id: the viewer pane that wasn't there before is the new tab's.
    const doc = newId();
    this.opening = { key, root: this.root, doc, keep, space, before: new Set(panes().filter(p => p.mod === VIEWER).map(p => p.pane)) };
    run("tab.new", { name: path.split("/").pop(), mod: VIEWER, props: { file, on, doc } });
    this.claim();
  }

  claim() {
    const fresh = this.opening && panes().find(p => p.mod === VIEWER && !this.opening.before.has(p.pane));
    if (!fresh) return;
    const o = this.opening;
    this.opening = null;
    setShared(OPEN, { ...(shared(OPEN) ?? {}), [o.key]: { tab: fresh.tab, root: o.root } });
    // A single click's tab is its space's preview tab now (the last one stays as it is).
    if (!o.keep) setShared(PREVIEW, { ...(shared(PREVIEW) ?? {}), [o.space]: { tab: fresh.tab, doc: o.doc } });
  }

  openExternally(path, cx) {
    if (!this.root) return;
    const file = `${this.root}/${path}`;
    if (this.on) {
      notify({ title: "Can't open in a local app", body: `${path} is on ${this.on}.`, level: "warning" });
      return;
    }
    const mac = window()?.platform === "macos";
    cx.spawn(async () => {
      const r = await exec(mac ? "open" : "xdg-open", [file]).catch(e => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: "Couldn't open the file", body: (r.stderr || path).trim(), level: "error" });
    });
  }

  menu(path, dir) {
    if (!this.root) return;
    const p = { path, file: `${this.root}/${path}`, dir, expanded: this.folders.has(path), on: this.on, space: location().space, context: this.context.key };
    // Matches cscode-file-menu's rows: 31px each, two 9px separators, 5px padding.
    const rows = 5 + (p.on ? 0 : 1) + (p.on || dir ? 0 : 1);
    openOverlay({ mod: "cscode-file-menu", kind: "popup", width: 230, height: rows * 31 + 2 * 9 + 10, props: p });
  }

  // A choice from cscode-file-menu that needs this tree: open in a tab, expand or collapse.
  answer(cx) {
    const req = shared(MENU);
    if (!req || req.id === this.menuDone) return;
    this.menuDone = req.id;
    if (req.context !== this.context?.key) return;
    if (req.action === "open") this.open(req.path);
    else if (req.action === "toggle") this.toggle(req.path, cx);
  }

  toggleDots(cx) {
    this.hideDots = !this.hideDots;
    try { localStorage.setItem("hideDots", this.hideDots ? "1" : "0"); } catch {}
    cx.notify();
  }

  // A row's mark: its own, else (a folder) the strongest below it, else new
  // when it's inside a new folder.
  markOf(path, dir) {
    return this.marks[path] ?? (dir ? this.folderMarks?.[path] : null)
      ?? (this.untracked?.some(d => path.startsWith(d + "/")) ? "A" : null);
  }

  rows(prefix, depth, out, t, current) {
    if (out.length >= TOTAL || depth > 40) return out;
    // Changed only: git's tree, every folder open unless folded. Else the folder listing.
    const changed = this.changedOnly;
    for (const entry of (changed ? this.changed() : this.entries).get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      if (this.hideDots && entry.name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, mark = this.markOf(`${this.root}/${path}`, entry.dir);
      const open = changed ? !this.folded.has(path) : this.folders.has(path);
      const color = mark ? markColor(t, mark) : null, gone = !entry.dir && mark === "D";
      out.push(h_flex().id(`file-${path}`).h(24).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .when(!entry.dir && current === docKey(`${this.root}/${path}`, this.on), el => el.bg(t.selected))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(path, entry.dir); })
        .on_click((e, cx) => entry.dir ? (changed ? this.fold(path, cx) : this.toggle(path, cx))
          // A deleted file has nothing left to open.
          : gone ? notify({ title: `${entry.name} is deleted`, body: "It's gone from the working tree; git still has it.", level: "info" })
          : e.modifiers?.platform ? this.openExternally(path, cx) : this.open(path, e.click_count >= 2))
        .child(entry.dir ? svg(`mods/cscode-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        // Its type's icon (VS Code's Material Icon Theme; folders open and shut).
        .child(image(icon(path, entry.dir, open, settings().dark)).size(16).flex_none())
        .child(div().flex_1().min_w(0).truncate().when(Boolean(color), el => el.text_color(color)).when(gone, el => el.line_through()).child(entry.name))
        // A file: a badge with its mark's icon and letter. A folder: the icon of
        // the strongest change inside.
        .when(Boolean(mark) && !entry.dir, el => el.child(h_flex().id(`mark-${path}`).h(18).px(5).gap(3).flex_none().items_center().rounded(4)
          .bg(color + "24").text_size(10.5).font_semibold().text_color(color).tooltip(MARK_NAME[mark])
          .child(svg(`mods/workspace-chrome/${MARK_ICON[mark]}.svg`).size(10).flex_none()).child(mark)))
        .when(Boolean(mark) && entry.dir, el => el.child(div().id(`mark-${path}`).size(18).flex_none().flex().items_center().justify_center()
          .tooltip(`${MARK_NAME[mark]} inside`)
          .child(svg(`mods/workspace-chrome/${MARK_ICON[mark]}.svg`).size(11).text_color(color)))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t, current);
    }
    return out;
  }

  // Changed only: the repo's worktrees. Each: its folder and change count, then its
  // branch and the agents working in it (a click on one goes to it). A click on a
  // worktree shows its changes below; the one shown is shaded.
  worktreeList(t) {
    const shown = worktreeOf(this.root, this.worktrees)?.path, all = agents();
    const chip = (address) => {
      const a = all.find(x => x.address === address);
      if (!a) return null;
      return h_flex().id(`wt-agent-${address}`).h(18).max_w(150).px(5).gap(4).flex_none().items_center().rounded(4).cursor_pointer()
        .bg(t.raised).text_size(10.5).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip(`${agentName(a)} (${a.status}): go to it`)
        .on_click((_e, cx) => { cx.stop_propagation(); run("agent.focus", { terminal: address }); })
        .child(div().size(6).flex_none().rounded(3).bg(t[a.status] ?? t.idle))
        .child(div().min_w(0).truncate().child(agentName(a)));
    };
    return v_flex().flex_none().max_h(220).px(6).pt(6).pb(5).gap(1).border_b(1).border_color(t.border)
      .child(div().px(8).pb(2).text_size(10.5).text_color(t.dim).child("Worktrees"))
      .child(v_flex().id("wt-list").min_h(0).overflow_y_scrollbar().gap(1).children(this.worktrees.map(w => {
        const on = w.path === shown, chips = (w.agents ?? []).map(chip).filter(Boolean);
        return v_flex().id(`wt-${w.path}`).px(8).py(4).gap(3).rounded(7).cursor_pointer()
          .when(on, el => el.bg(t.selected)).hover(s => s.bg(on ? t.selected : t.hover))
          .on_click((_e, cx) => this.pickWorktree(w, cx))
          .child(h_flex().gap(7).items_center()
            .child(svg("mods/workspace-chrome/git-branch.svg").size(13).flex_none().text_color(on ? t.accent : t.muted))
            .child(div().min_w(0).truncate().text_size(12.5).text_color(on ? t.foreground : t.muted).child(w.path.split("/").pop()))
            .when(w.main, el => el.child(div().flex_none().text_size(10).text_color(t.dim).child("main checkout")))
            .child(div().flex_1())
            .child(div().flex_none().text_size(11).text_color(w.changes ? t.ansi3 : t.dim)
              .child(w.changes == null ? "" : w.changes ? `${w.changes} changed` : "clean")))
          .child(h_flex().pl(20).gap(4).flex_wrap().items_center()
            .child(div().flex_none().max_w(160).truncate().text_size(11).text_color(t.dim).child(w.branch || "no branch"))
            .children(chips)
            .when(!chips.length, el => el.child(div().text_size(10.5).text_color(t.dim).child("· no agent"))));
      })));
  }

  render(cx) {
    if (this.placeKey() !== this.context?.key) this.refresh(cx);
    this.answer(cx);
    this.claim();
    const t = theme(), current = viewing(focused()?.tab), list = this.rows("", 0, [], t, current);
    const empty = this.error || (this.loading ? "Loading files…" : !this.root ? "No folder"
      : this.changedOnly ? (!this.isRepo ? "Not a git repository" : this.changed().get("")?.length ? "Only hidden files changed" : "No changes")
      : this.entries.get("")?.length ? "Only hidden files" : "No files");
    const changes = Object.keys(this.marks ?? {}).filter(p => this.root && p.startsWith(this.root.replace(/\/+$/, "") + "/")).length;
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? ""))
        // Changed only: on, it's shaded with the count of changed files.
        .child(h_flex().id("files-changed").h(24).min_w(24).px(this.changedOnly ? 6 : 0).gap(4).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
          .when(this.changedOnly, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
          .tooltip(this.changedOnly ? "Showing changed files only (click for all)" : "Show changed files only")
          .on_click((_e, cx) => this.toggleChanged(cx))
          .child(svg("mods/workspace-chrome/git-branch.svg").size(14).text_color(this.changedOnly ? t.accent : t.muted))
          .when(this.changedOnly && changes > 0, el => el.child(div().text_size(11).text_color(t.accent).child(String(changes)))))
        .child(div().id("files-dots").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.toggleDots(cx))
          .child(svg(`mods/cscode-files/${this.hideDots ? "eye-off" : "eye"}.svg`).size(14).text_color(this.hideDots ? t.dim : t.muted))))
      .when(this.changedOnly && this.worktrees.length > 1, el => el.child(this.worktreeList(t)))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(list)
        .when(Boolean(this.error) || !list.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(empty)))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }
}
