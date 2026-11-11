#!/bin/sh
# cscode-todo's setup outside Herdr (from Over9k's setup.sh): what the To-do panel's
# Set up button runs. Linux, macOS, and Windows through Git Bash.
#   setup.sh todo on|off <mods>       the to-do rule (CLAUDE.md, AGENTS.md), the `todo`
#                                     command (~/.local/bin) and its hook (UserPromptSubmit)
#   setup.sh default log|sync on|off  Log / Sync for projects that haven't set their own
#   setup.sh check                    what's missing: one line each (none: nothing printed)
# <mods>: Herdr's mods folder (forward slashes on Windows). Claude Code's settings
# are ~/.claude/settings.json; Over9k's own entries are found by a marker in
# their command, so an older one is replaced and no one else's is touched.
set -u
cmd=${1:-} on=${2:-} mods=${3:-}
settings="$HOME/.claude/settings.json"

need_jq() { command -v jq >/dev/null 2>&1 || { echo "Over9k needs jq for this (https://jqlang.org/download/)" >&2; exit 4; }; }

# Claude Code's settings through jq: edit '<filter>' [jq args...].
edit() {
  need_jq
  mkdir -p "$HOME/.claude"; [ -s "$settings" ] || echo '{}' > "$settings"
  filter=$1; shift
  tmp=$(mktemp) || exit 1
  if jq "$@" "$filter" "$settings" > "$tmp" && [ -s "$tmp" ]; then cat "$tmp" > "$settings"; fi
  rm -f "$tmp"
}

# One of Over9k's hooks on or off: hook <on|off> <event> <marker> <command>.
hook() {
  edit '
    .hooks[$ev] = ((.hooks[$ev] // []) | map(.hooks |= map(select((.command // "") | contains($m) | not))) | map(select(.hooks | length > 0)))
    | if $on == "on" then .hooks[$ev] += [{hooks: [{type: "command", command: $c}]}] else . end
    | if .hooks[$ev] == [] then del(.hooks[$ev]) else . end
    | if .hooks == {} then del(.hooks) else . end' \
    --arg on "$1" --arg ev "$2" --arg m "$3" --arg c "$4"
}

case "$cmd" in
  todo)
    t="$mods/cscode-todo/todo.sh"
    [ -f "$t" ] || { echo "No $t" >&2; exit 2; }
    sh "$t" --rule "$on"
    # The `todo` command agents run: a small wrapper (only Over9k's own is ever
    # replaced or removed).
    w="$HOME/.local/bin/todo"
    ours() { grep -q 'over9k todo wrapper' "$w" 2>/dev/null || { [ -L "$w" ] && readlink "$w" | grep -q over9k; }; }
    if [ "$on" = on ]; then
      if [ ! -e "$w" ] || ours; then
        mkdir -p "$HOME/.local/bin" && rm -f "$w" \
          && printf '#!/bin/sh\n# over9k todo wrapper (Options > To-do)\nexec sh "%s" "$@"\n' "$t" > "$w" && chmod +x "$w"
      fi
    elif ours; then rm -f "$w"; fi
    command -v jq >/dev/null 2>&1 && hook "$on" UserPromptSubmit cscode-todo/todo-hook.sh "sh \"$mods/cscode-todo/todo-hook.sh\""
    exit 0 ;;
  default)
    k=$on v=${3:-}
    case "$k:$v" in log:on|log:off|sync:on|sync:off) ;; *) echo "usage: setup.sh default log|sync on|off" >&2; exit 2 ;; esac
    d="${XDG_DATA_HOME:-$HOME/.local/share}/over9k"; mkdir -p "$d"
    { grep -v "^$k " "$d/todo-defaults" 2>/dev/null; echo "$k $v"; } > "$d/todo-defaults.tmp" && mv "$d/todo-defaults.tmp" "$d/todo-defaults" ;;
  check)
    command -v git >/dev/null 2>&1 || echo "git: the sidebar's branch, changes and push/pull"
    command -v jq >/dev/null 2>&1 || echo "jq: subagents, background tasks, resume, hand-off, the to-do hook"
    { command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; } || echo "python 3: the Timeline, TODO.md sync"
    exit 0 ;;
  *) sed -n '2,12s/^# \{0,1\}//p' "$0"; exit 2 ;;
esac
