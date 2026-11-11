#!/usr/bin/env python3
# Crosses a to-do out of a project's own to-do file, or back in:
#   todo-cross.py <folder> done|undo <text>
# and, with Options › To-do › Keep a TODO.md in each project on, keeps it in step:
#   todo-cross.py <folder> add <text>          appended ("- [ ] text"; the file
#                                             is made, "# To-do", if there's none,
#                                             and git-ignored in .git/info/exclude)
#   todo-cross.py <folder> rm <text>           its line taken out
#   todo-cross.py <folder> rename <text> <new> its text changed
# The file: TODO.md (or todo.md, Todo.md, TODO, TODO.txt, docs/TODO.md), the same
# one Over9k's To-do panel suggests from. The line whose text (without bold,
# code marks and link targets) is <text> changes: "- [ ] x" <-> "- [x] x" in a
# file with checkboxes, else "- x" <-> "- ~~x~~". Nothing else in the file
# changes; no file, or no such line: nothing happens. Used by the panel and
# by `todo done` / `todo undo`.
import os, re, shutil, subprocess, sys

NAMES = ["TODO.md", "todo.md", "Todo.md", "TODO", "TODO.txt", "docs/TODO.md"]
BULLET = r"^(\s*(?:[-*+]|\d+\.)\s+)"


def clean(text):
    text = re.sub(r"\*\*|__|`", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    return text.strip()


def main():
    if len(sys.argv) < 4:
        sys.exit(2)
    folder, what, want = sys.argv[1], sys.argv[2], sys.argv[3].strip().lower()
    path = next((os.path.join(folder, n) for n in NAMES if os.path.isfile(os.path.join(folder, n))), None)
    if not path and what == "add" and os.path.isdir(folder):
        path = os.path.join(folder, "TODO.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write("# To-do\n")
        ignore(folder)
    if not path:
        return
    with open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    boxes = any(re.match(BULLET + r"\[[ xX]\]", l) for l in lines)
    bullets = any(re.match(BULLET, l) for l in lines)
    # The line for a to-do: [index, its bullet, its box or ~~ mark, its text] or None.
    def find():
        for i, l in enumerate(lines):
            m = re.match(BULLET + (r"(\[[ xX]\])\s+(.*)$" if boxes else r"(~~)?(.*?)(?:~~)?\s*$"), l)
            if m and clean(m.group(3)).lower() == want:
                return i, m
        return None
    if what in ("add", "rm", "rename"):
        hit = find()
        if what == "add":
            if hit:
                return
            # After the last bullet, else at the end.
            at = max([i for i, l in enumerate(lines) if re.match(BULLET, l)], default=None)
            new = f"- [ ] {sys.argv[3].strip()}" if boxes or not bullets else f"- {sys.argv[3].strip()}"
            if at is None:
                while lines and lines[-1] == "":
                    lines.pop()
                lines += ["", new, ""]
            else:
                lines.insert(at + 1, new)
        elif not hit:
            return
        elif what == "rm":
            del lines[hit[0]]
        else:
            i, m = hit
            mark = m.group(2) or ""
            lines[i] = f"{m.group(1)}{mark + ' ' if boxes else mark}{sys.argv[4].strip()}{'~~' if mark == '~~' else ''}"
        save(path, lines)
        return
    for i, l in enumerate(lines):
        if boxes:
            m = re.match(BULLET + r"\[( |x|X)\]\s+(.*)$", l)
            if not m or clean(m.group(3)).lower() != want:
                continue
            ticked = m.group(2) != " "
            if what == "done" and not ticked:
                lines[i] = f"{m.group(1)}[x] {m.group(3)}"
            elif what == "undo" and ticked:
                lines[i] = f"{m.group(1)}[ ] {m.group(3)}"
            else:
                continue
        else:
            m = re.match(BULLET + r"(~~)?(.*?)(~~)?\s*$", l)
            if not m or clean(m.group(3)).lower() != want:
                continue
            struck = bool(m.group(2))
            if what == "done" and not struck:
                lines[i] = f"{m.group(1)}~~{m.group(3)}~~"
            elif what == "undo" and struck:
                lines[i] = f"{m.group(1)}{m.group(3)}"
            else:
                continue
        save(path, lines)
        return


# A TODO.md made here is the user's own: git ignores it, through the repo's
# local .git/info/exclude (never committed, so the project's .gitignore stays as it is).
def ignore(folder):
    try:
        top = subprocess.run(["git", "-C", folder, "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=5).stdout.strip()
        info = subprocess.run(["git", "-C", folder, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return
    if not top or not info:
        return
    rel = "/" + os.path.relpath(os.path.join(folder, "TODO.md"), top)
    lines = open(info, encoding="utf-8").read().split("\n") if os.path.isfile(info) else []
    if rel in lines:
        return
    os.makedirs(os.path.dirname(info), exist_ok=True)
    with open(info, "a", encoding="utf-8") as f:
        f.write(("" if not lines or lines[-1] == "" else "\n") + "# Over9k's to-do list (Sync)\n" + rel + "\n")


def save(path, lines):
    tmp = path + ".herdr-tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    shutil.copymode(path, tmp)
    os.replace(tmp, path)


main()
