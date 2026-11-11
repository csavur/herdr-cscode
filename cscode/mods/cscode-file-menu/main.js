// The Files tree's right-click menu. Opened by `cscode-files` as a pointer popup with
// props { path, file, dir, expanded, on, space, context, overlay }.
// ↑/↓ move, Enter runs, Esc closes. Opening in a tab and expanding a folder need the
// tree's own state, so those go back to `cscode-files` through shared(MENU).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, exec, notify, setShared, theme, window } from "herdr";

const MENU = "cscode-files:menu", ROW = 31, PAD = 5;

const parent = (file) => file.replace(/[\\/][^\\/]*$/, "") || "/";

// [label, icon, action]; null is a separator.
function items(p) {
  const local = !p.on;
  return [
    p.dir ? [p.expanded ? "Collapse" : "Expand", p.expanded ? "chevron-down" : "chevron-right", "toggle"] : ["Open", "file-text", "open"],
    ...(local && !p.dir ? [["Open with default app", "monitor", "external"]] : []),
    ...(local ? [["Reveal in Finder", "folder", "reveal"]] : []),
    null,
    ["Copy path", "files", "copy"],
    ["Copy relative path", "files", "copy-relative"],
    ["Copy name", "files", "copy-name"],
    null,
    [p.dir ? "New terminal here" : "New terminal in its folder", "terminal", "terminal"],
  ];
}

async function system(cmd, args) {
  const r = await exec(cmd, args).catch(e => ({ code: 1, stderr: String(e) }));
  if (r.code !== 0) notify({ title: `Couldn't run ${cmd}`, body: (r.stderr || "").trim(), level: "error" });
}

export default class FileMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(action, cx) {
    const p = props() ?? {};
    closeOverlay(p.overlay);
    const mac = window()?.platform === "macos";
    switch (action) {
      case "open":
      case "toggle":
        setShared(MENU, { id: `${Date.now()}-${Math.random()}`, context: p.context, action, path: p.path });
        break;
      case "external":
        cx.spawn(() => system(mac ? "open" : "xdg-open", [p.file]));
        break;
      case "reveal":
        cx.spawn(() => mac ? system("open", ["-R", p.file]) : system("xdg-open", [parent(p.file)]));
        break;
      case "copy":
        cx.write_to_clipboard(p.file);
        break;
      case "copy-relative":
        cx.write_to_clipboard(p.path);
        break;
      case "copy-name":
        cx.write_to_clipboard(p.path.split("/").pop());
        break;
      case "terminal":
        run("tab.new", { space: p.space, folder: p.dir ? p.file : parent(p.file) });
        break;
    }
  }

  render(_cx) {
    const t = theme(), p = props() ?? {}, list = items(p), actions = list.filter(Boolean);
    let n = -1;
    return v_flex().id("cscode-file-menu").track_focus(this.handle).w_full().min_h(0).p(PAD).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % actions.length;
        else if (e.key === "up") this.at = (this.at + actions.length - 1) % actions.length;
        else if (e.key === "enter") return this.choose(actions[this.at][2], cx);
        else if (e.key === "escape") return closeOverlay(p.overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => {
        if (!it) return div().id(`fm-rule-${i}`).mx(7).my(4).h(1).flex_none().bg(t.border);
        const at = ++n;
        return h_flex().id(`fm-${i}`).h(ROW).flex_none().px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
          .when(at === this.at, el => el.bg(t.selected))
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.choose(it[2], cx))
          .child(svg(`mods/workspace-chrome/${it[1]}.svg`).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(it[0]));
      }));
  }
}
