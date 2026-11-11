// The preview's own highlighter. The built-in editor colors only a few categories
// (JSON keys and values are both `string`), so the preview lexes the text itself.
// lex(text, family) returns one array per line of [kind, text] pairs; the viewer maps
// kinds to theme colors. Each lexer is one sticky regex per step, run once per text change.

const EXT = {
  json: "json", jsonc: "json", json5: "json", jsonl: "json", geojson: "json", har: "json", webmanifest: "json",
  ipynb: "json", babelrc: "json", eslintrc: "json", prettierrc: "json",
  yaml: "yaml", yml: "yaml", toml: "toml",
  ini: "ini", cfg: "ini", conf: "ini", properties: "ini", editorconfig: "ini", gitconfig: "ini", gitmodules: "ini",
  npmrc: "ini", desktop: "ini", service: "ini",
  xml: "markup", html: "markup", htm: "markup", xhtml: "markup", svg: "markup", vue: "markup", svelte: "markup",
  plist: "markup", xsd: "markup", xsl: "markup",
  css: "css", scss: "scss", sass: "scss", less: "scss",
  diff: "diff", patch: "diff",
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
  py: "py", pyi: "py", go: "go", rs: "rust",
  java: "c", kt: "c", kts: "c", scala: "c", c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", cxx: "c", cs: "c",
  swift: "c", dart: "c", m: "c", mm: "c", groovy: "c", gradle: "c",
  rb: "ruby", rake: "ruby", gemspec: "ruby", sh: "sh", bash: "sh", zsh: "sh", fish: "sh", ksh: "sh",
  sql: "sql", lua: "lua", php: "php", tf: "hcl", tfvars: "hcl", hcl: "hcl",
};

/** The preview family of a file, or "plain" when it has no highlighter. */
export function family(file) {
  const name = file.split(/[\\/]/).pop().toLowerCase(), ext = name.includes(".") ? name.split(".").pop() : "";
  if (name === "dockerfile" || name.startsWith("dockerfile.") || ext === "dockerfile") return "dockerfile";
  if (name === "makefile" || name === "gnumakefile" || ext === "mk") return "make";
  if (name.startsWith(".env") || ext === "env") return "env";
  return EXT[ext] ?? "plain";
}

const CONSTANTS = new Set("true false null undefined None True False nil NaN Infinity self this super".split(" "));
const CODE = {
  json: { line: ["//"], block: true, quotes: "\"", keys: true, kw: "" },
  js: { line: ["//"], block: true, quotes: "\"'`", kw: "break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static switch throw try typeof var void while with yield async await as interface type enum implements namespace declare readonly abstract private protected public keyof satisfies" },
  py: { line: ["#"], triple: true, quotes: "\"'", kw: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case" },
  go: { line: ["//"], block: true, quotes: "\"'`", kw: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var" },
  rust: { line: ["//"], block: true, quotes: "\"", kw: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct trait type unsafe use where while" },
  c: { line: ["//"], block: true, quotes: "\"'", kw: "abstract break case catch char class const continue default do double else enum extends final finally float for fun func if implements import in int interface internal is let long namespace new object open override package private protected public return short sealed static struct switch throw throws try typedef union unsigned using val var virtual void volatile when where while" },
  ruby: { line: ["#"], quotes: "\"'", kw: "alias and begin break case class def do else elsif end ensure for if in module next not or redo require require_relative rescue retry return then unless until when while yield" },
  sh: { line: ["#"], quotes: "\"'", vars: true, types: false, kw: "if then else elif fi case esac for while until do done in function return local export readonly declare unset shift exit source alias echo set" },
  sql: { line: ["--"], block: true, quotes: "'\"", nocase: true, kw: "select from where and or not insert into values update set delete create table alter drop index view join left right inner outer full on as group by order having limit offset union all distinct case when then else end is null like in between exists primary key foreign references default unique check constraint begin commit rollback with returning" },
  lua: { line: ["--"], quotes: "\"'", kw: "and break do else elseif end for function goto if in local not or repeat return then until while" },
  php: { line: ["//", "#"], block: true, quotes: "\"'", vars: true, kw: "abstract and as break case catch class const continue declare default do echo else elseif extends final finally for foreach function global if implements include interface namespace new or private protected public require return static switch throw trait try use var while yield" },
  hcl: { line: ["#", "//"], block: true, quotes: "\"", kw: "resource data variable output module provider locals terraform for in if" },
  toml: { line: ["#"], triple: true, quotes: "\"'", kw: "" },
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const lexers = new Map();

// One combined sticky regex per config: the first group that matched names the token.
function codeLexer(name) {
  if (lexers.has(name)) return lexers.get(name);
  const cfg = CODE[name], parts = [];
  const comments = cfg.line.map(l => `${esc(l)}[^\\n]*`);
  if (cfg.block) comments.push("\\/\\*[\\s\\S]*?(?:\\*\\/|$)");
  parts.push([comments.join("|"), "comment"]);
  const strings = cfg.triple ? ['"""[\\s\\S]*?(?:"""|$)', "'''[\\s\\S]*?(?:'''|$)"] : [];
  for (const q of cfg.quotes) strings.push(q === "`" ? "`(?:[^`\\\\]|\\\\[\\s\\S])*`?" : `${q}(?:[^${q}\\\\\\n]|\\\\.)*${q}?`);
  parts.push([strings.join("|"), "string"]);
  if (cfg.vars) parts.push(["\\$\\{[^}\\n]*\\}?|\\$\\([^)\\n]*\\)?|\\$[\\w@#?*!]+", "constant"]);
  parts.push(["@[\\w.]+", "meta"]);
  parts.push(["(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?)[a-zA-Z_]*", "number"]);
  parts.push(["[A-Za-z_$][\\w$]*", "ident"]);
  parts.push(["[ \\t]+", "plain"]);
  parts.push([cfg.line.includes("--") ? "[(){}\\[\\];,.:=+*&|!?<>%^~\\\\]+" : "[(){}\\[\\];,.:=+*&|!?<>%^~\\\\-]+", "punct"]);
  parts.push(["[\\s\\S]", "plain"]);
  const lexer = { cfg, re: new RegExp(parts.map(([s]) => `(${s})`).join("|"), "y"), kinds: parts.map(([, k]) => k),
    kw: new Set(cfg.kw.split(" ").filter(Boolean)) };
  lexers.set(name, lexer);
  return lexer;
}

const AFTER = /[ \t]*/y;
function nextChar(text, pos) {
  AFTER.lastIndex = pos;
  AFTER.exec(text);
  return text[AFTER.lastIndex];
}

function lexCode(text, name, out = []) {
  const { cfg, re, kinds, kw } = codeLexer(name);
  re.lastIndex = 0;
  for (let m; re.lastIndex < text.length && (m = re.exec(text));) {
    let g = 1;
    while (m[g] === undefined) g++;
    let kind = kinds[g - 1];
    const s = m[0], end = m.index + s.length;
    if (kind === "ident") {
      const w = cfg.nocase ? s.toLowerCase() : s;
      kind = kw.has(w) ? "keyword" : CONSTANTS.has(w) ? "constant" : nextChar(text, end) === "(" ? "function"
        : !cfg.nocase && cfg.types !== false && /^[A-Z]/.test(s) ? "type" : "plain";
    } else if (kind === "string" && cfg.keys && nextChar(text, end) === ":") kind = "key";
    out.push([kind, s]);
  }
  return out;
}

// Splits a token stream at newlines; joins neighbours of one kind so a row draws few spans.
function toLines(tokens) {
  const lines = [[]];
  const push = (kind, s) => {
    const row = lines[lines.length - 1], last = row[row.length - 1];
    if (last && last[0] === kind) last[1] += s;
    else row.push([kind, s]);
  };
  for (const [kind, s] of tokens) {
    const parts = s.split("\n");
    parts.forEach((p, i) => { if (i) lines.push([]); if (p) push(kind, p); });
  }
  return lines;
}

const SCALAR = /([ \t]+)|(#.*)|("(?:[^"\\]|\\.)*"?|'(?:[^']|'')*'?)|([&*!][^\s,[\]{}]*)|([[\]{},]|[|>][-+\d]*(?=[ \t]*(?:#|$)))|([^\s,[\]{}#][^,[\]{}]*?)(?=[ \t]+#|[ \t]*[,[\]{}]|[ \t]*$)/y;
const NUMBER = /^[-+]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|0x[\da-fA-F]+|\.inf|\.nan)$/i;
const LITERAL = /^(?:true|false|yes|no|on|off|null|~)$/i;

// The value side of YAML, INI and .env lines: unquoted text is a string there.
function lexScalars(s, out, comments = true) {
  SCALAR.lastIndex = 0;
  while (SCALAR.lastIndex < s.length) {
    const at = SCALAR.lastIndex, m = SCALAR.exec(s);
    if (!m) { out.push(["string", s.slice(at)]); break; }
    const v = m[0];
    if (m[1]) out.push(["plain", v]);
    else if (m[2]) out.push([comments ? "comment" : "string", v]);
    else if (m[3]) out.push(["string", v]);
    else if (m[4]) out.push(["meta", v]);
    else if (m[5]) out.push(["punct", v]);
    else out.push([NUMBER.test(v.trim()) ? "number" : LITERAL.test(v.trim()) ? "constant" : /\$\{?\w/.test(v) ? "constant" : "string", v]);
  }
  return out;
}

const YAML_KEY = /("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{}[\],&*!|>][^#]*?)([ \t]*:)(?=[ \t]|$)/y;
function lexYaml(text) {
  const lines = [];
  let block = -1;
  for (const line of text.split("\n")) {
    const indent = line.match(/^ */)[0].length;
    if (block >= 0 && (!line.trim() || indent > block)) { lines.push(line ? [["string", line]] : []); continue; }
    block = -1;
    const row = [];
    const lead = line.match(/^\s*(?:-(?:[ \t]+|$))*/)[0];
    if (/^\s*#/.test(line)) { lines.push([["plain", lead], ["comment", line.slice(lead.length)]]); continue; }
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(line)) { row.push(["meta", line.slice(0, 3)]); lexScalars(line.slice(3), row); lines.push(row); continue; }
    if (lead) row.push(["punct", lead]);
    let pos = lead.length;
    YAML_KEY.lastIndex = pos;
    const key = YAML_KEY.exec(line);
    if (key) { row.push(["key", key[1]], ["punct", key[2]]); pos = YAML_KEY.lastIndex; }
    const value = line.slice(pos);
    lexScalars(value, row);
    if (/^[ \t]*[|>][-+\d]*[ \t]*(?:#.*)?$/.test(value)) block = indent;
    lines.push(row);
  }
  return lines;
}

// TOML, INI-style config and .env: [sections], key = value, comments.
function lexKeyValue(text, style) {
  const comment = style === "ini" ? /^\s*[#;!]/ : /^\s*#/;
  const pair = style === "ini" ? /^(\s*)([^\s=:#;[][^=:]*?)([ \t]*[=:][ \t]*)(.*)$/ : /^(\s*)(export[ \t]+)?([^\s=#[][^=]*?)([ \t]*=[ \t]*)(.*)$/;
  return text.split("\n").map(line => {
    if (comment.test(line)) return [["comment", line]];
    const section = style !== "env" && /^(\s*)(\[\[?[^\]]*\]\]?)(.*)$/.exec(line);
    if (section) return toLines([["plain", section[1]], ["section", section[2]], ...lexValue(section[3], style)])[0];
    const m = pair.exec(line);
    if (!m) return toLines(lexValue(line, style))[0];
    const [, indent, ...rest] = m, [exp, key, sep, value] = style === "ini" ? [undefined, ...rest] : rest;
    return toLines([["plain", indent], ...(exp ? [["keyword", exp]] : []), ["key", key], ["punct", sep], ...lexValue(value, style)])[0];
  });
}
const lexValue = (s, style) => style === "toml" ? lexCode(s, "toml") : lexScalars(s, [], style !== "ini");

function lexMarkup(text) {
  const OUT = /(<!--[\s\S]*?(?:-->|$))|(<!\[CDATA\[[\s\S]*?(?:\]\]>|$))|(<[!?][^>]*>?)|(<\/?[\w:.-]+)|(&[#\w]+;)|([^<&]+)|([\s\S])/y;
  const IN = /(\/?>)|("[^"]*"?|'[^']*'?)|([\w:@.#-]+)|(=)|(\s+)|([\s\S])/y;
  const out = [];
  let inTag = false, i = 0;
  while (i < text.length) {
    const re = inTag ? IN : OUT;
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) break;
    let g = 1;
    while (m[g] === undefined) g++;
    if (inTag) { out.push([["tag", "string", "attr", "punct", "plain", "plain"][g - 1], m[0]]); if (g === 1) inTag = false; }
    else { out.push([["comment", "string", "meta", "tag", "constant", "plain", "plain"][g - 1], m[0]]); if (g === 4) inTag = true; }
    i = re.lastIndex;
  }
  return toLines(out);
}

function lexCss(text, scss) {
  const re = new RegExp([
    scss ? "(\\/\\*[\\s\\S]*?(?:\\*\\/|$)|\\/\\/[^\\n]*)" : "(\\/\\*[\\s\\S]*?(?:\\*\\/|$))",
    "(\"(?:[^\"\\\\\\n]|\\\\.)*\"?|'(?:[^'\\\\\\n]|\\\\.)*'?)", "(@[\\w-]+)", "(#[\\w-]+)", "(\\$[\\w-]+|--[\\w-]+)",
    "(!important)", "(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:%|[a-zA-Z]+)?)", "([\\w-]+)", "([{}])", "([\\s\\S])",
  ].join("|"), "y");
  const out = [];
  let depth = 0;
  for (let m; re.lastIndex < text.length && (m = re.exec(text));) {
    let g = 1;
    while (m[g] === undefined) g++;
    const s = m[0], end = m.index + s.length;
    let kind = ["comment", "string", "keyword", "number", "constant", "keyword", "number", "plain", "punct", "plain"][g - 1];
    if (g === 4 && depth === 0) kind = "type";
    if (g === 8) kind = depth > 0 && nextChar(text, end) === ":" ? "key" : depth === 0 ? "type" : "plain";
    if (g === 9) depth = Math.max(0, depth + (s === "{" ? 1 : -1));
    out.push([kind, s]);
  }
  return toLines(out);
}

function lexDiff(text) {
  return text.split("\n").map(line => !line ? [] : [[
    /^(?:\+\+\+|---)\s/.test(line) || /^(?:diff|index) /.test(line) ? "meta"
      : line[0] === "@" ? "hunk" : line[0] === "+" ? "added" : line[0] === "-" ? "removed" : "plain", line]]);
}

function lexDockerfile(text) {
  return text.split("\n").map(line => {
    if (/^\s*#/.test(line)) return [["comment", line]];
    const m = /^(\s*)([A-Za-z]+)(?=\s|$)/.exec(line);
    if (!m || m[2] !== m[2].toUpperCase()) return toLines(lexCode(line, "sh"))[0];
    return toLines([["plain", m[1]], ["keyword", m[2]], ...lexCode(line.slice(m[0].length), "sh")])[0];
  });
}

function lexMake(text) {
  return text.split("\n").map(line => {
    if (/^\s*#/.test(line)) return [["comment", line]];
    if (line.startsWith("    ")) return toLines(lexCode(line, "sh"))[0];
    const v = /^(\s*[\w.-]+)([ \t]*(?:[:+?!]?=|::=))(.*)$/.exec(line);
    if (v) return toLines([["key", v[1]], ["punct", v[2]], ...lexScalars(v[3], [])])[0];
    const t = /^([^\s:#=][^:#=]*)(::?)(?!=)(.*)$/.exec(line);
    if (t) return toLines([["function", t[1]], ["punct", t[2]], ...lexCode(t[3], "sh")])[0];
    return toLines(lexCode(line, "sh"))[0];
  });
}

/** Lines of [kind, text] for one family; "plain" text comes back uncolored. */
export function lex(text, fam) {
  text = text.replace(/\t/g, "    ").replace(/\r/g, "");
  switch (fam) {
    case "yaml": return lexYaml(text);
    case "toml": case "ini": case "env": return lexKeyValue(text, fam);
    case "markup": return lexMarkup(text);
    case "css": case "scss": return lexCss(text, fam === "scss");
    case "diff": return lexDiff(text);
    case "dockerfile": return lexDockerfile(text);
    case "make": return lexMake(text);
    case "plain": return text.split("\n").map(l => l ? [["plain", l]] : []);
    default: return toLines(lexCode(text, fam));
  }
}
