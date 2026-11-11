#!/bin/sh
# Claude Code's UserPromptSubmit hook (Over9k): while this project's request
# logging is on (`todo log`; the To-do panel's Log switch), a note with each
# message to put what it asks for on its to-do list. Says nothing outside a git
# repo, when logging is off there, or when the To-do rule isn't installed
# (Options › To-do off).
grep -q '<!-- over9k:todo -->' "$HOME/.claude/CLAUDE.md" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
# todo.sh sits next to this file (the hook runs it by its full path).
t="$(dirname "$0")/todo.sh"
sh "$t" log 2>/dev/null | grep -q ': on$' || exit 0
echo "Request logging is on for this project: if this message asks for something here (or changes or drops an earlier request), update the to-do list now (todo add / todo edit / todo rm), as the Project to-do lists rule says."
