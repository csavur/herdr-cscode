// Opens a folder in VS Code: here, or on another machine through Remote-SSH.
// The same file is in mods/cscode-agents and mods/cscode-pane (mods import only their own files).

import { exec, hc, notify } from "herdr";

// The CLI inside the app, for when `code` isn't on PATH.
const APP_CODE = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";

async function code(args) {
  try {
    return await exec("code", args);
  } catch {
    return exec(APP_CODE, args);
  }
}

// machine: a space's machine (null here); folder: a path on that machine.
export async function openInVSCode(machine, folder) {
  try {
    let args = [folder];
    if (machine) {
      // Remote-SSH reaches the machine the way herdr-core does: its ssh target.
      const r = await hc(["machine", "ls", "--json"]);
      const m = JSON.parse(r.stdout).machines?.find((x) => x.name === machine);
      if (!m?.target) throw new Error(`No SSH address known for ${machine}`);
      args = ["--remote", `ssh-remote+${m.target}`, folder];
    }
    const r = await code(args);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `code exited with ${r.code}`);
  } catch (e) {
    notify({ title: "Couldn't open VS Code", body: String(e?.message ?? e), level: "error" });
  }
}
