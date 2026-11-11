// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { openInVSCode } from "./vscode.js";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, exec } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
// The session's name: the agent's own terminal title (Claude Code sets it to the
// session's summary) when it says more than the program's name or a path; else the
// tab's label, unless that is only an automatic number; else the program.
function sessionName(a, fallback) {
  const prog = a.program?.name;
  const live = clean(a.title);
  const lower = live.toLowerCase();
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && lower !== a.program?.key && lower !== (a.app ?? "");
  if (telling) return live;
  if (fallback && !/^\d+$/.test(fallback)) return fallback;
  return prog || fallback || a.address;
}

// The space's color, as the spaces list draws its avatar: the name it stored in
// shared "space.colors", shown through the same strong hue table.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
function spaceColor(t, id) {
  const c = (shared("space.colors") ?? {})[id] ?? "ansi6";
  return c.startsWith("#") ? c : (MARK[c] ?? t[c] ?? t.dim);
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "mods/workspace-chrome/clock.svg" },
  { id: "grouped", label: "Grouped by space", icon: "mods/workspace-chrome/layers.svg" },
  // One flat list in space number order (Ctrl-1..9), the number on each pill.
  { id: "space", label: "Space number", icon: "mods/cscode-agents/hash.svg" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
// hue: Claude Code's one-color mark is drawn in its repo's color.
function icon(p, size, color, hue) {
  if (!p?.icon) return null;
  if (hue && p.key === "claude") return svg(p.icon).size(size).flex_none().text_color(hue);
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
    // Git status per [machine, folder]: { changes, ahead, behind }, null when not a repo.
    this.git = {};
    this.gitAt = {};
    this.wanted = new Set();
    this.stale = new Set();
    this.lastStatus = {};
    this.gitBusy = false;
    // Cheap unless something is due: no redraw without a change.
    cx.timer.every(1000, (cx) => this.pollGit(cx));
  }

  // Looks again at folders not seen yet, marked stale (an agent changed state:
  // it likely touched files), or not seen for a while (other machines less often).
  pollGit(cx) {
    if (this.gitBusy) return;
    const now = Date.now();
    const due = [...this.wanted].filter((k) => this.stale.has(k) || !(k in this.gitAt) || now - this.gitAt[k] > (JSON.parse(k)[0] ? 30000 : 15000));
    if (!due.length) return;
    this.gitBusy = true;
    cx.spawn(async (cx) => {
      let changed = false;
      for (const k of due) {
        this.stale.delete(k);
        const before = JSON.stringify(this.git[k]);
        await this.checkGit(k);
        if (JSON.stringify(this.git[k]) !== before) changed = true;
      }
      this.gitBusy = false;
      if (changed) cx.notify();
    });
  }

  async checkGit(key) {
    const [on, cwd] = JSON.parse(key);
    this.gitAt[key] = Date.now();
    try {
      // No optional locks, no fsmonitor: looking must not write under .git.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        this.git[key] = null;
        return;
      }
      const info = { changes: 0, ahead: 0, behind: 0 };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        } else if (/^[12u?] /.test(line)) info.changes++;
      }
      this.git[key] = info;
    } catch {
      // The machine is away: keep what it showed, look again later.
    }
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(s.icon).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact, hue) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground, hue);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  // Uncommitted changes (a pencil and a count), then ahead and behind, as the spaces list colors them.
  gitStatus(t, gs) {
    return h_flex().flex_none().gap(5).items_center().text_size(11)
      .when(gs.changes > 0, (el) => el.child(h_flex().gap(2).items_center().text_color(t.ansi3)
        .child(svg("mods/cscode-agents/pencil.svg").size(10).flex_none())
        .child(String(gs.changes))))
      .when(gs.ahead > 0, (el) => el.child(div().text_color(t.ansi2).child(`\u2191${gs.ahead}`)))
      .when(gs.behind > 0, (el) => el.child(div().text_color(t.ansi1).child(`\u2193${gs.behind}`)));
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const bySpace = sort.id === "space";
    // Each space's number, as space.select (Ctrl-1..9) counts.
    const spaceList = spaces();
    const spaceNumber = new Map(spaceList.map((s, i) => [s.id, i + 1]));
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    // Stable: agents of one tab keep their pane order.
    const num = (a) => spaceNumber.get(a.space) ?? Infinity;
    if (bySpace) list = [...list].sort((x, y) => num(x) - num(y) || x.tab_index - y.tab_index);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority, spaceColor(t, a.space)))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row has two lines: the session's name, then where it runs (space, branch,
    // machine). The tab's label is the fallback name for agents without a title.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const paneList = panes();
    const leads = leadPanes(paneList);
    const branchOf = new Map(paneList.map((p) => [p.pane, p.branch]));
    const cwdOf = new Map(paneList.map((p) => [p.pane, p.cwd]));
    // Each agent's repo, for its git status; only folders with a branch are repos.
    const gitKey = (a) => {
      const cwd = cwdOf.get(a.pane);
      return cwd && branchOf.get(a.pane) ? JSON.stringify([a.address.includes("/") ? a.address.split("/")[0] : null, cwd]) : null;
    };
    this.wanted = new Set();
    for (const a of list) {
      const k = gitKey(a);
      if (!k) continue;
      this.wanted.add(k);
      if (this.lastStatus[a.address] !== a.status) this.stale.add(k);
      this.lastStatus[a.address] = a.status;
    }
    // Completed agent turns, from the core.
    const turnOf = new Map(all.map((x) => [x.address, x.turn ?? 0]));
    const tabLabels = new Map(spaceList.flatMap(s => s.tabs).map(tab => [tab.id, title(tab, leads.get(tab.id))]));
    const label = (a) => tabLabels.get(a.tab) ?? (a.title || a.program?.name || "");

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground, spaceColor(t, a.space));
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Open the agent's folder in VS Code (Remote-SSH for another machine).
      const folder = cwdOf.get(a.pane);
      const vscode = folder ? div()
        .id(`code-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(machine ? `Open in VS Code on ${machine}` : "Open in VS Code")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          cx.spawn(async () => openInVSCode(machine, folder));
        })
        .child(svg("mods/cscode-agents/code.svg").size(13)) : null;
      // Line 2: the space as a pill in its own color, then branch and machine.
      const session = sessionName(a, label(a));
      // A branch means the agent's folder is in a git repo: a git mark follows the pill.
      const branch = branchOf.get(a.pane);
      const git = branch ? svg("mods/workspace-chrome/git-branch.svg").size(12).flex_none().text_color(t.muted) : null;
      // Where it runs, as an icon: a cloud for another machine, a monitor (the
      // spaces list's) for this one. The name is in the tooltip.
      const host = div().id(`host-${a.address}`).flex_none().text_color(t.muted)
        .tooltip(machine ?? "This computer")
        .child(svg(machine ? "mods/cscode-agents/cloud.svg" : "mods/workspace-chrome/monitor.svg").size(12));
      const gs = this.git[gitKey(a)] ?? null;
      const turns = turnOf.get(a.address) ?? 0;
      const gitTip = gs ? [gs.changes && `${gs.changes} uncommitted`, gs.ahead && `${gs.ahead} ahead`, gs.behind && `${gs.behind} behind`].filter(Boolean).join(", ") : "";
      const tip = [[a.space_name, machine ?? "This computer", branch].filter(Boolean).join(" · "), gitTip, turns ? `${turns} turns` : ""].filter(Boolean).join("\n");
      const hue = spaceColor(t, a.space);
      const spaceNum = spaceNumber.get(a.space);
      const pill = a.space_name
        // Shrinks (its name truncating) before the branch disappears.
        ? h_flex().max_w(150).min_w(48).px(6).h(17).gap(4).rounded(5).bg(hue + "2e").border(1).border_color(hue + "59")
            .text_size(10.5).font_medium().text_color(hue).items_center()
            .when(spaceNum != null, el => el.child(div().flex_none().font_bold().child(String(spaceNum))))
            .child(div().min_w(0).truncate().child(a.space_name))
        : null;
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .py(5)
        .min_h(44)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .border(1)
        .border_color(t.chrome + "00")
        .when(a.focused, (el) => el.bg(t.selected))
        // Needs you: the whole row says so, not only its badge.
        .when(a.status === "blocked", (el) => el.bg(t.blocked + (a.focused ? "33" : "1f")).border_color(t.blocked + "66"))
        .cursor_pointer()
        .hover((s) => s.bg(a.status === "blocked" ? t.blocked + "33" : t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .tooltip(`${session}\n${tip}`)
        .child(v_flex().flex_1().min_w(0).gap(3)
          // Line 1: the name (long names wrap to a second line, then clip), then
          // when it last changed (the pin while hovered) and its turns.
          .child(h_flex().min_w(0).gap(8).items_start()
            .child(div().flex_1().min_w(0).line_height("17px").max_h(34).overflow_hidden().text_color(idle ? t.muted : t.foreground).child(session))
            .child(h_flex().flex_none().h(17).gap(7).items_center().text_size(11).text_color(t.dim)
              .when(this.hovered === a.address && Boolean(vscode), el => el.child(vscode))
              .when(this.hovered === a.address, el => el.child(pin))
              .when(this.hovered !== a.address && Boolean(when), el => el.child(div().child(duration(now - when))))
              .when(turns > 0, el => el.child(h_flex().gap(3).items_center()
                .child(svg("mods/cscode-agents/turns.svg").size(10).flex_none())
                .child(String(turns))))))
          .child(h_flex().min_w(0).gap(6).items_center()
            .when(Boolean(pill), el => el.child(pill))
            .child(host)
            .when(Boolean(git), el => el.child(h_flex().min_w(30).gap(3).items_center()
              .child(git)
              .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(branch))))
            .when(Boolean(gs), el => el.child(this.gitStatus(t, gs)))))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    // By space number: one group; its header only where pins are above it.
    if (bySpace && rest.length) groups.push({ id: "by-space", label: pinned.length ? "By space number" : null, status: null, members: rest });
    else for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [...(g.label == null ? [] : [header(g)]), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "cscode-agents", kind: "popup", width: 200, height: 172, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(sort.icon).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
