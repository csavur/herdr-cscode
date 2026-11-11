// An agent's name from its terminal title, the same in every mod that shows
// agents (over9k' original; copied into project-tabs and project-menu, since mods
// can't import from each other). Claude Code titles its terminal with the task;
// Codex with "<thread title> | <model> <effort> | Context N% used" (tui.terminal_title
// in ~/.codex/config.toml; a new thread's title is its id until its first answer);
// Pi and others like it with "<app> - <name> - <folder>" (Pi names a session
// after its first message: ~/.pi/agent/extensions/session-title.ts). A title
// that's only a folder, a path or the program names nothing.

export const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}[(]+/u, "").trim();
export const isCodex = (a) => a.app === "codex" || a.program?.key === "codex";
const base = (path) => path.replace(/\/+$/, "").split("/").pop();

export function codexTitle(title) {
  const out = {}, rest = [];
  for (const part of (title ?? "").split(" | ")) {
    const ctx = /^Context (\d+)% used$/.exec(part), model = /^(\S+) (none|minimal|low|medium|high|xhigh|max)$/.exec(part);
    if (ctx) out.context = Number(ctx[1]);
    else if (model) { out.model = model[1]; out.effort = model[2]; }
    else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(part)) rest.push(part);
  }
  if (out.model || out.context != null) out.task = clean(rest.join(" | "));
  return out;
}
// Antigravity titles its conversations In Title Case; names here read in sentence
// case. Only a title that's all in that style changes (a plain lowercase word later
// on, other than a small one like "of", means it isn't), and only plain capitalised
// words: README, SceneKit, TASK.md and Objective-C stay. A proper noun past the
// first word ("Mail") loses its capital: nothing here can tell it apart.
const SMALL = /^(a|an|and|as|at|by|for|from|in|of|on|or|per|the|to|with)$/;
const CAPITALISED = /^(A|\p{Lu}\p{Ll}+(?:'s)?(?:-\p{L}\p{Ll}+)*[,:;.!?]?)$/u;
export function sentenceCase(s) {
  const words = (s ?? "").split(" ");
  if (words.slice(1).some((w) => /^\p{Ll}+$/u.test(w) && !SMALL.test(w))) return s;
  return words.map((w, i) => (i && CAPITALISED.test(w) ? w.toLowerCase() : w)).join(" ");
}
export function agentTask(a, cwd) {
  if (isCodex(a)) return codexTitle(a.title).task ?? "";
  let live = clean(a.title);
  // "<app> - <name> - <folder>", or "<app> - <folder>" before it has a name.
  const parts = live.split(" - "), app = parts[0].toLowerCase();
  if (parts.length >= 2 && (parts[0].length <= 3 || app === a.program?.name?.toLowerCase() || app === a.program?.key))
    live = parts.length >= 3 ? parts.slice(1, -1).join(" - ") : "";
  if (cwd && live === base(cwd)) return "";
  // Herdr titles an untitled terminal by its address ("t14f"): no name either.
  if (live === a.address || live === a.address?.split("/").pop()) return "";
  const telling = live && live !== a.program?.name && !/^[~/]/.test(live) && !live.includes("@") && live.toLowerCase() !== a.program?.key;
  return !telling ? "" : a.app === "antigravity" ? sentenceCase(live) : live;
}
