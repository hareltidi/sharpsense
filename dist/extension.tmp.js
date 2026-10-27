"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode4 = __toESM(require("vscode"));

// src/context.ts
var UNITY_MESSAGE_NAMES = /* @__PURE__ */ new Set([
  "Awake",
  "Start",
  "Update",
  "FixedUpdate",
  "LateUpdate",
  "OnEnable",
  "OnDisable",
  "OnDestroy",
  "OnGUI",
  "OnValidate",
  "Reset",
  "OnTriggerEnter",
  "OnTriggerExit",
  "OnTriggerStay",
  "OnTriggerEnter2D",
  "OnTriggerExit2D",
  "OnTriggerStay2D",
  "OnCollisionEnter",
  "OnCollisionExit",
  "OnCollisionStay",
  "OnCollisionEnter2D",
  "OnCollisionExit2D",
  "OnCollisionStay2D",
  "OnMouseDown",
  "OnMouseUp",
  "OnBecameVisible",
  "OnBecameInvisible"
]);
var TYPE_KEYWORDS = new Set(
  "void var object string int bool double float decimal".split(" ")
);
var MODIFIERS = "public|private|protected|internal|static|readonly|volatile|virtual|override|abstract|sealed|extern|unsafe|async|partial|required|file|scoped|event|const|record|class|struct|interface|enum|namespace|using|case";
function isTypeLike(t) {
  if (TYPE_KEYWORDS.has(t)) {
    return true;
  }
  if (t.includes("<") || t.includes("[") || t.endsWith("?")) {
    return true;
  }
  return /^[A-Z]/.test(t);
}
function stripModifiers(head) {
  const m = head.match(new RegExp(`^(?:(?:${MODIFIERS})\\s+)+`, "i"));
  if (!m) {
    return { hadModifier: false, rest: head };
  }
  return { hadModifier: true, rest: head.slice(m[0].length) };
}
function isBareModifierHead(head) {
  const { hadModifier, rest } = stripModifiers(head.trimStart());
  return hadModifier && rest.trim() === "";
}
function isDeclarationHead(head) {
  const { hadModifier, rest } = stripModifiers(head.trimStart());
  const trimmed = rest.trimEnd();
  const twoWord = trimmed.match(/([A-Za-z_]\w*(?:<[^<>]*>)?(?:\[\])*\??)\s+([A-Za-z_]\w*(?:<[^<>]*>)?)$/);
  if (twoWord && isTypeLike(twoWord[1])) {
    return true;
  }
  if (hadModifier && /^[A-Z][A-Za-z0-9_]*$/.test(trimmed)) {
    return true;
  }
  const single = trimmed.match(new RegExp(`^(?:(?:${MODIFIERS})\\s+)*([A-Za-z_]\\w*(?:<[^<>]*>)?(?:\\[\\])*\\??)$`, "i"));
  if (single && (hadModifier || isTypeLike(single[1]))) {
    return true;
  }
  return false;
}
function isInsideDeclarationParens(prefix) {
  let depth = 0;
  for (let i = prefix.length - 1; i >= 0; i--) {
    const c = prefix[i];
    if (c === ")" || c === "]" || c === "}") {
      depth++;
    } else if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) {
        return c === "(" && isDeclarationHead(prefix.slice(0, i));
      }
      depth--;
    } else if (depth === 0 && (c === ";" || c === "{" || c === "}")) {
      return false;
    }
  }
  return false;
}
function detectInvokeContext(prefix, suffix) {
  if (/^\s*\(/.test(suffix)) {
    const dupName = prefix.match(/([A-Za-z_]\w*)(<[^<>]*>)?$/)?.[1] ?? "";
    return { kind: "existing-parens", name: dupName };
  }
  const genericNew = prefix.match(/\bnew\s+([A-Za-z_][\w.]*<[^<>]*>)$/);
  if (genericNew) {
    return { kind: "object-creation", name: genericNew[1] };
  }
  const nameMatch = prefix.match(/([A-Za-z_]\w*)(<[^<>]*>)?$/);
  const name = nameMatch ? nameMatch[1] : "";
  if (!name) {
    return { kind: "other", name: "" };
  }
  if (/\bnameof\s*\([^()]*$/.test(prefix)) {
    return { kind: "suppress-nameof", name };
  }
  if (/[+-]=\s*(?:[\w.]+\.)?[A-Za-z_]\w*$/.test(prefix)) {
    return { kind: "suppress-plus-equals", name };
  }
  if (/(?:^|[\s(,=])\[[A-Za-z_]\w*$/.test(prefix)) {
    return { kind: "attribute", name };
  }
  if (/\bnew\s+[A-Za-z_][\w.]*$/.test(prefix)) {
    return { kind: "object-creation", name };
  }
  const rawName = nameMatch?.[0] ?? name;
  const head = prefix.slice(0, prefix.length - rawName.length);
  if (new RegExp(`^\\s*(?:(?:${MODIFIERS})\\s+)*~[A-Za-z_]\\w*$`).test(prefix)) {
    return { kind: "definition", name };
  }
  const headOnly = stripModifiers(head.trimStart());
  if (headOnly.hadModifier && headOnly.rest.trim() === "" && /^[A-Z]/.test(name)) {
    return { kind: "definition", name };
  }
  if (!head.trimEnd().endsWith(".")) {
    if (isInsideDeclarationParens(prefix)) {
      return {
        kind: UNITY_MESSAGE_NAMES.has(name) ? "unity-message-definition" : "definition",
        name
      };
    }
    if (isDeclarationHead(head)) {
      return {
        kind: UNITY_MESSAGE_NAMES.has(name) ? "unity-message-definition" : "definition",
        name
      };
    }
  }
  if (UNITY_MESSAGE_NAMES.has(name) && /^\s*[A-Za-z_]\w*(<[^<>]*>)?$/.test(prefix)) {
    return { kind: "unity-message-definition", name };
  }
  return { kind: "invocation", name };
}
function parseGenericArity(detail) {
  const method = detail.match(/[A-Za-z_]\w*\s*<([^<>]*)>\s*\(/);
  if (method) {
    return method[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0).length;
  }
  return 0;
}
function isGenericInferrable(detail) {
  const clean = detail.replace(/^\s*\([^)]*\)\s*/, "");
  const named = clean.match(/([A-Za-z_]\w*)\s*<([^<>]*)>\s*\(/);
  if (!named) {
    return true;
  }
  const typeParams = named[2].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (typeParams.length === 0) {
    return true;
  }
  const parenStart = clean.indexOf("(", named.index ?? 0);
  let depth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < clean.length; i++) {
    const c = clean[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  if (parenStart < 0 || parenEnd <= parenStart) {
    return false;
  }
  const params = clean.slice(parenStart, parenEnd + 1);
  return typeParams.every((t) => new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(params));
}
function resolveBraceStyle(setting, documentText) {
  if (setting === "allman" || setting === "k&r") {
    return setting;
  }
  const sample = documentText.length > 1e5 ? documentText.slice(0, 1e5) : documentText;
  const allman = (sample.match(/\)[ \t]*\r?\n\s*\{/g) ?? []).length;
  const sameLine = (sample.match(/\)[ \t]*\{/g) ?? []).length;
  if (allman === 0 && sameLine === 0) {
    return "allman";
  }
  return allman >= sameLine ? "allman" : "k&r";
}
var POSTFIX_STOP_AT_DEPTH_ZERO = /* @__PURE__ */ new Set([
  ";",
  "{",
  "}",
  "=",
  ",",
  ":",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "!",
  "~",
  " ",
  "	"
]);
function extractPostfixTarget(prefix) {
  const dot = prefix.match(/\.([A-Za-z_]*)$/);
  if (!dot || dot.index === void 0) {
    return null;
  }
  const trigger = dot[1];
  const dotIndex = dot.index;
  let depth = 0;
  let i = dotIndex - 1;
  for (; i >= 0; i--) {
    const c = prefix[i];
    if (c === ")" || c === "]" || c === "}") {
      depth++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) {
        break;
      }
      depth--;
      continue;
    }
    if (depth === 0 && POSTFIX_STOP_AT_DEPTH_ZERO.has(c)) {
      break;
    }
  }
  let exprStart = i + 1;
  while (exprStart < dotIndex && (prefix[exprStart] === " " || prefix[exprStart] === "	")) {
    exprStart++;
  }
  while (exprStart < dotIndex && (prefix[exprStart] === ">" || prefix[exprStart] === "=")) {
    exprStart++;
  }
  const expr = prefix.slice(exprStart, dotIndex).trim();
  if (!expr || !/[A-Za-z0-9_)\]"']$/.test(expr)) {
    return null;
  }
  return { expr, trigger, exprStart };
}

// src/completions.ts
var vscode2 = __toESM(require("vscode"));

// src/postfix.ts
var vscode = __toESM(require("vscode"));
function esc(text) {
  return text.replace(/[$}]/g, (c) => `\\${c}`);
}
function braced(bs, header, body) {
  if (bs === "allman") {
    return `${header}
{
	${body}
}`;
  }
  return `${header} {
	${body}
}`;
}
function snip(value, preview) {
  return { snippet: new vscode.SnippetString(value), preview };
}
var POSTFIX_TEMPLATES = [
  {
    trigger: "var",
    description: "Introduce local: var name = expr;",
    expand: (e) => snip(`var \${1:name} = ${esc(e)};`, `var name = ${e};`)
  },
  {
    trigger: "if",
    description: "Wrap in if (expr)",
    expand: (e, bs) => snip(braced(bs, `if (${esc(e)})`, "$0"), `if (${e}) { ... }`)
  },
  {
    trigger: "null",
    description: "if (expr == null)",
    expand: (e, bs) => snip(braced(bs, `if (${esc(e)} == null)`, "$0"), `if (${e} == null) { ... }`)
  },
  {
    trigger: "notnull",
    description: "if (expr != null)",
    expand: (e, bs) => snip(braced(bs, `if (${esc(e)} != null)`, "$0"), `if (${e} != null) { ... }`)
  },
  {
    trigger: "for",
    description: "Index loop over expr (uses .Length)",
    expand: (e, bs) => snip(
      braced(bs, `for (var \${1:i} = 0; \${1:i} < ${esc(e)}.Length; \${1:i}++)`, "$0"),
      `for (var i = 0; i < ${e}.Length; i++) { ... }`
    )
  },
  {
    trigger: "foreach",
    description: "foreach (var item in expr)",
    expand: (e, bs) => snip(
      braced(bs, `foreach (var \${1:item} in ${esc(e)})`, "$0"),
      `foreach (var item in ${e}) { ... }`
    )
  },
  {
    trigger: "return",
    description: "return expr;",
    expand: (e) => snip(`return ${esc(e)};`, `return ${e};`)
  },
  {
    trigger: "await",
    description: "await expr;",
    expand: (e) => snip(`await ${esc(e)};`, `await ${e};`)
  },
  {
    trigger: "using",
    description: "using (expr) { ... }",
    expand: (e, bs) => snip(braced(bs, `using (${esc(e)})`, "$0"), `using (${e}) { ... }`)
  },
  {
    trigger: "try",
    description: "Wrap expr in try/catch",
    expand: (e, bs) => snip(
      `${braced(bs, "try", `${esc(e)};`)}
catch (Exception \${1:e})
${bs === "allman" ? "{\n	$0\n}" : "{\n	$0\n}"}`,
      `try { ${e}; } catch (Exception e) { ... }`
    )
  },
  {
    trigger: "throw",
    description: "throw expr;",
    expand: (e) => snip(`throw ${esc(e)};`, `throw ${e};`)
  },
  {
    trigger: "cast",
    description: "(Target)expr",
    expand: (e) => snip(`(\${1:Target})${esc(e)}$0`, `(Target)${e}`)
  },
  {
    trigger: "as",
    description: "expr as Target",
    expand: (e) => snip(`${esc(e)} as \${1:Target}$0`, `${e} as Target`)
  },
  {
    trigger: "switch",
    description: "switch (expr) { ... }",
    expand: (e, bs) => snip(braced(bs, `switch (${esc(e)})`, "$0"), `switch (${e}) { ... }`)
  }
];
function findPostfixTemplates(partial) {
  const p = partial.toLowerCase();
  return POSTFIX_TEMPLATES.filter((t) => t.trigger.startsWith(p));
}

// src/completions.ts
var braceCache = /* @__PURE__ */ new Map();
function cachedBraceStyle(doc, setting) {
  const key = doc.uri.toString();
  const hit = braceCache.get(key);
  if (hit && hit.version === doc.version) return hit.style;
  const style = resolveBraceStyle(setting, doc.getText());
  braceCache.set(key, { version: doc.version, style });
  if (braceCache.size > 50) {
    const oldest = braceCache.keys().next();
    if (!oldest.done) braceCache.delete(oldest.value);
  }
  return style;
}
function shouldAddSemicolon(prefix, suffix) {
  if (/^\s*;/.test(suffix)) return false;
  const trimmed = suffix.trim();
  if (trimmed.length !== 0 && !trimmed.startsWith("//")) return false;
  let depth = 0;
  let inStr = null;
  let esc2 = false;
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i];
    if (esc2) {
      esc2 = false;
      continue;
    }
    if (c === "\\" && inStr) {
      esc2 = true;
      continue;
    }
    if (inStr) {
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
  }
  return depth === 0;
}
function completionLabel(item) {
  const l = item.label;
  return typeof l === "string" ? l : l.label;
}
function isCallableKind(kind) {
  return kind === vscode2.CompletionItemKind.Method || kind === vscode2.CompletionItemKind.Function || kind === vscode2.CompletionItemKind.Constructor;
}
function isTypeKind(kind) {
  return kind === vscode2.CompletionItemKind.Class || kind === vscode2.CompletionItemKind.Struct || kind === vscode2.CompletionItemKind.Interface;
}
function kindName(kind) {
  if (kind === void 0) return "?";
  return vscode2.CompletionItemKind[kind] ?? String(kind);
}
function baseNameOf(label) {
  return label.match(/^([A-Za-z_]\w*)/)?.[1] ?? "";
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function registerPostfixProvider(context, getSettings) {
  const provider = {
    provideCompletionItems(doc, pos) {
      if (!getSettings().postfix || doc.languageId !== "csharp") return void 0;
      const line = doc.lineAt(pos.line).text;
      const target = extractPostfixTarget(line.slice(0, pos.character));
      if (!target) return void 0;
      const templates = findPostfixTemplates(target.trigger);
      if (templates.length === 0) return void 0;
      const bs = cachedBraceStyle(doc, getSettings().braceStyle);
      const range = new vscode2.Range(pos.line, target.exprStart, pos.line, pos.character);
      const filterText = line.slice(target.exprStart, pos.character);
      return templates.map((t) => {
        const built = t.expand(target.expr, bs);
        const item = new vscode2.CompletionItem(t.trigger, vscode2.CompletionItemKind.Snippet);
        item.__sharpsensePostfix = true;
        item.range = range;
        item.filterText = filterText;
        item.detail = `SharpSense postfix .${t.trigger} \u2014 ${t.description}`;
        item.documentation = new vscode2.MarkdownString().appendCodeblock(built.preview, "csharp");
        item.insertText = built.snippet;
        return item;
      });
    }
  };
  context.subscriptions.push(vscode2.languages.registerCompletionItemProvider("csharp", provider, "."));
}
var LIVE_TEMPLATES = [
  { trigger: "class", snippet: "class ${1:MyClass}\n{\n	${0}\n}", description: "class declaration" },
  { trigger: "interface", snippet: "interface I${1:MyInterface}\n{\n	${0}\n}", description: "interface declaration" },
  { trigger: "struct", snippet: "struct ${1:MyStruct}\n{\n	${0}\n}", description: "struct declaration" },
  { trigger: "enum", snippet: "enum ${1:MyEnum}\n{\n	${0}\n}", description: "enum declaration" },
  { trigger: "record", snippet: "record ${1:MyRecord}(${2});${0}", description: "record declaration" },
  { trigger: "prop", snippet: "public ${1:int} ${2:MyProperty} { get; set; }${0}", description: "auto-property" }
];
function isLiveScope(head) {
  if (/[=\.]/.test(head)) return false;
  const tail = head.trimStart().replace(new RegExp(`^(?:(?:${MODIFIERS})\\s+)*`, "i"), "").trim();
  if (tail === "") return true;
  return /[{};\s]$/.test(head);
}
function registerLiveTemplateProvider(context, _getSettings) {
  const provider = {
    provideCompletionItems(doc, pos) {
      if (doc.languageId !== "csharp") return void 0;
      const line = doc.lineAt(pos.line).text;
      const prefix = line.slice(0, pos.character);
      const wordMatch = prefix.match(/([A-Za-z_]\w*)$/);
      const word = wordMatch ? wordMatch[1].toLowerCase() : "";
      if (!word) return void 0;
      const head = wordMatch && wordMatch.index !== void 0 ? prefix.slice(0, wordMatch.index) : prefix;
      if (!isLiveScope(head)) return void 0;
      const hits = LIVE_TEMPLATES.filter((t) => t.trigger.toLowerCase().startsWith(word));
      if (hits.length === 0) return void 0;
      const wordStart = pos.character - (wordMatch ? wordMatch[1].length : 0);
      const range = new vscode2.Range(pos.line, wordStart, pos.line, pos.character);
      return hits.map((t) => {
        const item = new vscode2.CompletionItem(t.trigger, vscode2.CompletionItemKind.Snippet);
        item.range = range;
        item.filterText = t.trigger;
        item.sortText = "!0000";
        item.detail = `SharpSense ${t.description}`;
        item.documentation = new vscode2.MarkdownString().appendCodeblock(t.snippet.replace(/\$\{\d+:?[^}]*\}/g, (m) => m.replace(/\$\{\d+:?/, "").replace(/\}/, "")), "csharp");
        item.insertText = new vscode2.SnippetString(t.snippet);
        return item;
      });
    }
  };
  context.subscriptions.push(vscode2.languages.registerCompletionItemProvider("csharp", provider));
}
function registerExpectedNewProvider(context, getSettings) {
  const pendingKeys = /* @__PURE__ */ new Set();
  const provider = {
    async provideCompletionItems(doc, pos) {
      try {
        if (doc.languageId !== "csharp") return void 0;
        const s = getSettings();
        if (!s.smartParens) return void 0;
        const line = doc.lineAt(pos.line).text;
        const prefix = line.slice(0, pos.character);
        const suffix = line.slice(pos.character);
        if (!/=\s*new\s*[\w<>,.]*$/.test(prefix)) return void 0;
        const eqIdx = prefix.lastIndexOf("=");
        if (eqIdx === -1) return void 0;
        const beforeEq = prefix.slice(0, eqIdx);
        const trimmed = beforeEq.trimEnd();
        if (!/\b([A-Za-z_]\w*)\s*$/.test(trimmed)) return void 0;
        const typeMatch = trimmed.match(/(.+?)\s+([A-Za-z_]\w*)\s*$/);
        if (!typeMatch) return void 0;
        let typeText = typeMatch[1].trim().replace(new RegExp(`^(?:(?:${MODIFIERS})\\s+)+`, "i"), "").trim();
        if (!typeText || typeText === "var" || /^[0-9]/.test(typeText)) return void 0;
        if (/[=;{}]/.test(typeText)) return void 0;
        if (!/^[A-Za-z_][\w$]/.test(typeText) && !typeText.includes("<")) return void 0;
        const key = `${doc.uri.toString()}:${pos.line}:${pos.character}:${doc.version}`;
        if (pendingKeys.has(key)) return void 0;
        pendingKeys.add(key);
        try {
          const res = await vscode2.commands.executeCommand(
            "vscode.executeCompletionItemProvider",
            doc.uri,
            pos
          );
          const items = Array.isArray(res) ? res : res?.items ?? [];
          const base = (typeText.split("<")[0].split(".").pop() ?? "").trim() || baseNameOf(typeText);
          if (base) {
            for (const it of items) {
              if (baseNameOf(completionLabel(it)) !== base) continue;
              if (it.kind === vscode2.CompletionItemKind.Interface) return void 0;
              const detail = typeof it.detail === "string" ? it.detail : "";
              if (/\binterface\b/i.test(detail)) return void 0;
              if (/\babstract\b/i.test(detail)) return void 0;
            }
          }
        } catch {
        } finally {
          pendingKeys.delete(key);
        }
        const newStart = prefix.lastIndexOf("new");
        if (newStart === -1) return void 0;
        let typedStart = newStart + 3;
        while (typedStart < prefix.length && (prefix[typedStart] === " " || prefix[typedStart] === "	")) typedStart++;
        const typedFragment = prefix.slice(typedStart, pos.character);
        if (typedFragment.length > 0 && /[^A-Za-z0-9_<>,]/.test(typedFragment)) return void 0;
        const range = new vscode2.Range(pos.line, typedStart, pos.line, pos.character);
        const hasParenAhead = /^\s*\(/.test(suffix);
        const needsSemi = !hasParenAhead && s.smartSemicolon && shouldAddSemicolon(prefix + typeText, suffix);
        const semi = needsSemi ? ";" : "";
        const snippetBody = hasParenAhead ? `${typeText}\${0}${semi}` : `${typeText}(\${0})${semi}`;
        const label = hasParenAhead ? `${typeText}` : `${typeText}()`;
        const item = new vscode2.CompletionItem(label, vscode2.CompletionItemKind.Snippet);
        item.range = range;
        item.filterText = typeText;
        item.sortText = "!0000";
        item.preselect = true;
        item.detail = `SharpSense: create new ${typeText}()`;
        item.documentation = new vscode2.MarkdownString(`Creates \`new ${typeText}()\` for \`${typeMatch[2]}\``);
        item.insertText = new vscode2.SnippetString(snippetBody);
        return [item];
      } catch (e) {
        try {
          console.error("[SharpSense] expectedNew provider error", e);
        } catch {
        }
        return void 0;
      }
    }
  };
  context.subscriptions.push(vscode2.languages.registerCompletionItemProvider("csharp", provider, " ", "<", ">", ",", ".", ":", '"', "'", "(", "[", "{"));
}
function docTextOf(it) {
  const d = it.documentation;
  if (typeof d === "string") return d;
  if (d instanceof vscode2.MarkdownString) return d.value;
  return "";
}
function methodSignatureText(escBase, detail, doc) {
  const re = new RegExp(`\\b${escBase}\\s*<[^<>]*>\\s*\\(`);
  if (re.test(detail)) return detail;
  if (doc && re.test(doc)) return doc;
  return void 0;
}
async function fetchShadowMap(doc, pos) {
  const buildMap = (res2) => {
    if (!res2) return void 0;
    const items = Array.isArray(res2) ? res2 : res2.items ?? [];
    const map2 = /* @__PURE__ */ new Map();
    for (const it of items) {
      const label = completionLabel(it);
      const base = baseNameOf(label);
      if (!base) continue;
      const detail = typeof it.detail === "string" ? it.detail : "";
      const doc2 = docTextOf(it);
      const flag = rowNeedsAngles(it.kind, label, detail, doc2);
      const prior = map2.get(base);
      if (prior) {
        prior.needsAngles = prior.needsAngles || flag;
        const esc2 = escapeRegExp(base);
        const re = new RegExp(`\\b${esc2}\\s*<[^<>]*>\\s*\\(`);
        if (!re.test(prior.detail) && re.test(detail)) prior.detail = detail;
        if (doc2 && (!prior.doc || !re.test(prior.doc) && re.test(doc2))) prior.doc = doc2;
        continue;
      }
      map2.set(base, { kind: it.kind, label, detail, doc: doc2, needsAngles: flag });
    }
    return map2;
  };
  const isAmbiguous = (map2) => {
    for (const [, entry] of map2) {
      if (!isCallableKind(entry.kind)) continue;
      const base = baseNameOf(entry.label);
      if (!base) continue;
      const esc2 = escapeRegExp(base);
      const labelHasGeneric = new RegExp(`^${esc2}\\s*<[^<>]*>`).test(entry.label);
      if (!labelHasGeneric) continue;
      const re = new RegExp(`\\b${esc2}\\s*<[^<>]*>\\s*\\(`);
      const hasSig = re.test(entry.detail) || re.test(entry.doc) || /<[^<>]*>\s*\(/.test(entry.detail) || /<[^<>]*>\s*\(/.test(entry.doc);
      if (!hasSig) return true;
    }
    return false;
  };
  let res;
  try {
    res = await vscode2.commands.executeCommand(
      "vscode.executeCompletionItemProvider",
      doc.uri,
      pos
    );
  } catch {
    return void 0;
  }
  let map = buildMap(res);
  if (!map) return void 0;
  if (!isAmbiguous(map)) return map;
  try {
    const res2 = await vscode2.commands.executeCommand(
      "vscode.executeCompletionItemProvider",
      doc.uri,
      pos,
      void 0,
      20
    );
    const map2 = buildMap(res2);
    if (map2) return map2;
  } catch {
  }
  return map;
}
function logIntegrationProof(output2) {
  output2.appendLine("[SharpSense] Integration proof: Roslyn is sole semantic source via vscode.executeCompletionItemProvider (ms-dotnettools.csharp + ms-dotnettools.csdevkit). Shadow contributes zero plain-symbol rows; Tier1 new + Live Templates are supplemental Snippet rows with sortText !0000; suffixes via STRATEGY_MATRIX + insertSnippet(undoStopBefore/After:false).");
}
async function logRoslynRows(output2, doc, pos) {
  const probe = pos.character > 0 ? pos.translate(0, -1) : pos;
  const wordRange = doc.getWordRangeAtPosition(probe);
  const word = wordRange ? doc.getText(wordRange) : "";
  if (!word) {
    output2.appendLine("[SharpSense] inspect: no word under cursor");
    return;
  }
  let res;
  try {
    res = await vscode2.commands.executeCommand(
      "vscode.executeCompletionItemProvider",
      doc.uri,
      pos
    );
  } catch {
    output2.appendLine("[SharpSense] inspect: Roslyn fetch failed");
    return;
  }
  const items = Array.isArray(res) ? res : res?.items ?? [];
  const rows = items.filter((it) => baseNameOf(completionLabel(it)) === word);
  output2.appendLine(`[SharpSense] inspect: ${rows.length} Roslyn row(s) for "${word}"`);
  rows.slice(0, 10).forEach((it, i) => {
    const label = completionLabel(it);
    const detail = (typeof it.detail === "string" ? it.detail : "").replace(/\s+/g, " ");
    const doc2 = docTextOf(it).replace(/\s+/g, " ").slice(0, 120);
    output2.appendLine(`  [${i}] kind=${kindName(it.kind)} label="${label}" detail="${detail}" doc="${doc2}" needsAngles=${rowNeedsAngles(it.kind, label, typeof it.detail === "string" ? it.detail : "", docTextOf(it))}`);
  });
  if (rows.length > 10) output2.appendLine(`  ... and ${rows.length - 10} more`);
}
function isInsideGenericArgs(prefix) {
  let depth = 0;
  for (let i = prefix.length - 1; i >= 0; i--) {
    const c = prefix[i];
    if (c === ">") {
      depth++;
      continue;
    }
    if (c === "<") {
      if (depth === 0) return true;
      depth--;
      continue;
    }
    if (depth === 0 && (c === ";" || c === "{" || c === "}" || c === "(" || c === ")" || c === "[" || c === "]")) return false;
  }
  return false;
}
function slotOf(prefix, detected) {
  switch (detected.kind) {
    case "object-creation":
      return "TypeInstantiation";
    case "definition":
    case "unity-message-definition":
      return "Declaration";
    case "invocation":
      return isInsideGenericArgs(prefix) ? "GenericTypeArgument" : "Invocation";
    default:
      return "Other";
  }
}
function categorizeKind(kind) {
  if (isCallableKind(kind)) return "Callable";
  if (isTypeKind(kind)) return "Type";
  return "Bare";
}
function rowNeedsAngles(kind, label, detail, doc = "") {
  const base = baseNameOf(label);
  if (!base) return false;
  const esc2 = escapeRegExp(base);
  if (isCallableKind(kind)) {
    const labelHasGeneric = new RegExp(`^${esc2}\\s*<[^<>]*>`).test(label);
    const detailHasMethodGeneric = new RegExp(`\\b${esc2}\\s*<[^<>]*>\\s*\\(`).test(detail);
    const docHasMethodGeneric = doc ? new RegExp(`\\b${esc2}\\s*<[^<>]*>\\s*\\(`).test(doc) : false;
    const hasGeneric = labelHasGeneric || detailHasMethodGeneric || docHasMethodGeneric;
    if (!hasGeneric) return false;
    const sig = methodSignatureText(esc2, detail, doc);
    if (sig) return !isGenericInferrable(sig);
    if (detail && /<[^<>]*>\s*\(/.test(detail)) return !isGenericInferrable(detail);
    if (doc && /<[^<>]*>\s*\(/.test(doc)) return !isGenericInferrable(doc);
    return labelHasGeneric;
  }
  if (isTypeKind(kind)) {
    if (new RegExp(`^${esc2}\\s*<[^<>]*>`).test(label)) return true;
    if (new RegExp(`\\b${esc2}\\s*<[^<>]*>`).test(detail)) return true;
    return false;
  }
  return false;
}
function deriveGenericState(category, entry, s, afterNew) {
  if (!entry.needsAngles) return "Standard";
  if (category === "Callable") {
    if (!s.smartGenerics) return "Standard";
    if (!afterNew) {
      const base = baseNameOf(entry.label);
      const esc2 = escapeRegExp(base);
      const sig = methodSignatureText(esc2, entry.detail, entry.doc) ?? (entry.detail || entry.doc);
      if (sig && parseGenericArity(sig) > 0 && isGenericInferrable(sig)) return "Standard";
      if (entry.doc && entry.doc !== sig && parseGenericArity(entry.doc) > 0 && isGenericInferrable(entry.doc)) return "Standard";
      if (entry.detail && entry.detail !== sig && parseGenericArity(entry.detail) > 0 && isGenericInferrable(entry.detail)) return "Standard";
      if (!sig || sig.trim() === "" || parseGenericArity(sig) === 0) {
        const labelHasGeneric = new RegExp(`^${esc2}\\s*<[^<>]*>`).test(entry.label);
        return labelHasGeneric ? "Generic" : "Standard";
      }
    }
  }
  return "Generic";
}
var TYPE_DEFINITION_HEAD = /(?:^|[\s;{}])(?:class|struct|interface|enum|record|namespace)\s+$/i;
function deriveDeclaration(word, prefix, slot, entry) {
  if (slot !== "Declaration") return false;
  if (isTypeKind(entry.kind) && entry.needsAngles) {
    const head = prefix.slice(0, prefix.length - word.length);
    if (isBareModifierHead(head) && !TYPE_DEFINITION_HEAD.test(head)) return false;
  }
  return true;
}
function resolveStrategyKey(kind, hasGenerics, isAfterNew, isDeclaration) {
  const category = categorizeKind(kind);
  if (category === "Bare" || isDeclaration) return "Bare:PassThrough";
  const generic = hasGenerics ? "Generic" : "Standard";
  if (category === "Callable") return `Callable:${generic}`;
  return isAfterNew ? `Type:${generic}:New` : `Type:${generic}:Decl`;
}
function statementTerminator(ctx) {
  return ctx.s.smartSemicolon && shouldAddSemicolon(ctx.prefix, ctx.suffix) ? ";" : "";
}
var STRATEGY_MATRIX = {
  "Callable:Generic": (ctx) => `<\${1}>(\${0})${statementTerminator(ctx)}`,
  "Callable:Standard": (ctx) => `(\${0})${statementTerminator(ctx)}`,
  "Type:Generic:New": (ctx) => `<${1}>(\${0})${statementTerminator(ctx)}`,
  "Type:Standard:New": (ctx) => `(\${0})${statementTerminator(ctx)}`,
  "Type:Generic:Decl": () => "<${1}>${0}",
  "Type:Standard:Decl": () => "",
  "Bare:PassThrough": () => ""
};
var KEY_RULE = {
  "Callable:Generic": "R1",
  "Callable:Standard": "R2",
  "Type:Generic:New": "R2",
  "Type:Standard:New": "R2",
  "Type:Generic:Decl": "R3",
  "Type:Standard:Decl": "",
  "Bare:PassThrough": ""
};
var KEY_WHY = {
  "Callable:Generic": "R1 generic callable",
  "Callable:Standard": "R2 callable",
  "Type:Generic:New": "R2 construction",
  "Type:Standard:New": "R2 construction",
  "Type:Generic:Decl": "R3 generic type"
};
function targetArgsForNew(prefix, committedBase) {
  const newIdx = prefix.search(/\bnew\s+[A-Za-z_][\w.]*(<[^<>]*>)?$/);
  if (newIdx === -1) return void 0;
  const beforeNew = prefix.slice(0, newIdx);
  const eqIdx = beforeNew.lastIndexOf("=");
  if (eqIdx === -1) return void 0;
  const before = beforeNew[eqIdx - 1];
  if (before === "=" || before === ">" || before === "<" || before === "!") return void 0;
  const beforeEq = beforeNew.slice(0, eqIdx).trimEnd();
  const typeMatch = beforeEq.match(/(.+?)\s+([A-Za-z_]\w*)\s*$/);
  if (!typeMatch) return void 0;
  const typeText = typeMatch[1].trim().replace(new RegExp(`^(?:(?:${MODIFIERS})\\s+)+`, "i"), "").trim();
  if (!typeText || typeText === "var" || /^[0-9]/.test(typeText)) return void 0;
  if (/[=;{}]/.test(typeText)) return void 0;
  const lt = typeText.indexOf("<");
  if (lt === -1 || !typeText.trimEnd().endsWith(">")) return void 0;
  const targetBase = typeText.slice(0, lt).trim().split(".").pop() ?? "";
  const wantBase = (committedBase.split(".").pop() ?? "").trim();
  if (!targetBase || !wantBase || targetBase !== wantBase) return void 0;
  return typeText.slice(lt).trim();
}
function planShadowSuffix(word, entry, prefix, suffix, s) {
  const bare = (why, rule) => ({ body: "", why, rule });
  const detected = detectInvokeContext(prefix, suffix);
  const slot = slotOf(prefix, detected);
  const rawAfterNew = /\bnew\s+[A-Za-z_][\w.]*$/.test(prefix);
  const afterNew = slot === "TypeInstantiation" || rawAfterNew;
  const effectiveSlot = rawAfterNew && slot === "Other" && detected.kind === "existing-parens" ? "TypeInstantiation" : slot;
  const declaration = deriveDeclaration(word, prefix, effectiveSlot, entry);
  const generic = deriveGenericState(categorizeKind(entry.kind), entry, s, afterNew);
  const key = resolveStrategyKey(entry.kind, generic === "Generic", afterNew, declaration);
  const hasAngleAhead = /^\s*</.test(suffix);
  const hasParenAhead = /^\s*\(/.test(suffix);
  if (generic === "Generic" && hasAngleAhead) return bare("suppressed (C2 angle present)", KEY_RULE[key] ?? "");
  if (slot === "Other") {
    if (detected.kind === "existing-parens" && generic === "Generic") return { body: "<${1}>${0}", why: KEY_WHY[key] ?? key, rule: KEY_RULE[key] ?? "" };
    return bare(`suppressed (${detected.kind})`, "");
  }
  if (hasParenAhead) {
    if (generic === "Generic") return { body: "<${1}>${0}", why: KEY_WHY[key] ?? key, rule: KEY_RULE[key] ?? "" };
    return bare("C1 already has parens", "");
  }
  if (generic === "Generic" && /\>\s*$/.test(prefix)) {
    if (key === "Type:Generic:Decl") return bare("generic args already present", "R3");
    if (afterNew && isTypeKind(entry.kind)) {
      const angle = prefix.match(/<([^<>]*)>$/);
      if (angle && /^[\s,]*$/.test(angle[1])) {
        const args = targetArgsForNew(prefix, baseNameOf(word));
        if (args) {
          return { body: `${args}(\${0})${statementTerminator({ prefix, suffix, s })}`, why: KEY_WHY[key] ?? key, rule: KEY_RULE[key] ?? "", replaceBack: angle[0].length };
        }
      }
    }
    const parenBody = `(\${0})${statementTerminator({ prefix, suffix, s })}`;
    return { body: parenBody, why: KEY_WHY[key] ?? key, rule: KEY_RULE[key] ?? "" };
  }
  if (key === "Type:Generic:New" && generic === "Generic") {
    const args = targetArgsForNew(prefix, baseNameOf(word));
    if (args) {
      return { body: `${args}(\${0})${statementTerminator({ prefix, suffix, s })}`, why: KEY_WHY[key] ?? key, rule: KEY_RULE[key] ?? "" };
    }
  }
  const format = STRATEGY_MATRIX[key];
  if (!format) return bare(`no strategy for ${key}`, "");
  const body = format({ prefix, suffix, s });
  if (!body) {
    if (key === "Type:Standard:Decl") return bare("non-generic type reference", "");
    if (declaration) return bare("R4 declaration", "R4");
    return bare(`R5 kind ${kindName(entry.kind)}`, "R5");
  }
  return { body, why: KEY_WHY[key] ?? key, rule: KEY_RULE[key] ?? "" };
}
function locateCommittedWord(doc, cursor, spot) {
  const tryLine = (line) => {
    if (line < 0 || line >= doc.lineCount || cursor.character === 0) return void 0;
    const lineText = doc.lineAt(line).text;
    if (cursor.character > lineText.length) return void 0;
    const probe = new vscode2.Position(line, cursor.character - 1);
    const wordRange = doc.getWordRangeAtPosition(probe);
    const prefixUpToCursor = lineText.slice(0, cursor.character);
    if (!wordRange || wordRange.end.character !== cursor.character) {
      const generic = prefixUpToCursor.match(/([A-Za-z_]\w*)<[^<>]*>$/);
      if (generic && generic.index !== void 0) {
        const base = generic[1];
        const wordStart = generic.index;
        if (wordStart > spot.pos.character) return void 0;
        const typedLen2 = spot.pos.character - wordStart;
        if (typedLen2 < 0) return void 0;
        if (spot.lineText.slice(wordStart, spot.pos.character) !== base.slice(0, typedLen2)) return void 0;
        return { word: base, lineText };
      }
      return void 0;
    }
    if (wordRange.start.character > spot.pos.character) return void 0;
    const word = doc.getText(wordRange);
    const typedLen = spot.pos.character - wordRange.start.character;
    if (typedLen < 0) return void 0;
    if (spot.lineText.slice(wordRange.start.character, spot.pos.character) !== word.slice(0, typedLen)) return void 0;
    return { word, lineText };
  };
  return tryLine(cursor.line) ?? tryLine(cursor.line - 1) ?? tryLine(cursor.line + 1) ?? tryLine(cursor.line - 2) ?? tryLine(cursor.line + 2) ?? tryLine(cursor.line - 3) ?? tryLine(cursor.line + 3);
}
function registerCommitShadow(context, output2, getSettings) {
  logIntegrationProof(output2);
  const acceptBuiltIn = () => vscode2.commands.executeCommand("acceptSelectedSuggestion");
  const forward = acceptBuiltIn;
  let disposable;
  try {
    disposable = vscode2.commands.registerCommand("sharpsense.acceptDecorated", async () => {
      const ed = vscode2.window.activeTextEditor;
      const s = getSettings();
      if (!ed || ed.document.languageId !== "csharp" || !s.smartParens) return forward();
      if (!ed.selections.every((sel) => sel.isEmpty)) return forward();
      const doc = ed.document;
      const versionBefore = doc.version;
      const pre = ed.selections.map((sel) => ({ pos: sel.active, lineText: doc.lineAt(sel.active.line).text }));
      const mapPromise = fetchShadowMap(doc, ed.selection.active).catch(() => void 0);
      await vscode2.commands.executeCommand("acceptSelectedSuggestion");
      const map = await mapPromise;
      if (!map) {
        output2.appendLine("[SharpSense] accept: Roslyn fetch failed, left bare (already accepted)");
        return;
      }
      const after = vscode2.window.activeTextEditor;
      if (!after || after.document !== doc || doc.version === versionBefore) {
        output2.appendLine("[SharpSense] accept: no document change, nothing to shadow");
        return;
      }
      if (after.selections.length > pre.length) {
        output2.appendLine("[SharpSense] accept: cursor count changed, left bare");
        return;
      }
      const groups = /* @__PURE__ */ new Map();
      const replaceGroups = /* @__PURE__ */ new Map();
      const verdicts = [];
      const names = [];
      after.selections.forEach((sel, i) => {
        const skip = (why) => {
          verdicts.push(why);
        };
        if (!sel.isEmpty) {
          skip("no cursor");
          return;
        }
        const spot = pre[i];
        if (!spot) {
          skip("no pre-state");
          return;
        }
        const found = locateCommittedWord(doc, sel.active, spot);
        if (!found) {
          skip("no committable word");
          return;
        }
        const entry = map.get(found.word) ?? map.get(baseNameOf(found.word));
        if (!entry) {
          skip(`"${found.word}" not in Roslyn list`);
          return;
        }
        const prefix = found.lineText.slice(0, sel.active.character);
        const suffix = found.lineText.slice(sel.active.character);
        const planned = planShadowSuffix(found.word, entry, prefix, suffix, s);
        if (!planned.body) {
          skip(`"${found.word}" bare (${planned.why})`);
          return;
        }
        verdicts.push(`"${found.word}" ${planned.rule}`);
        names.push(`${found.word} ${planned.rule}`);
        if (planned.replaceBack && planned.replaceBack > 0 && sel.active.character - planned.replaceBack >= 0) {
          const range = new vscode2.Range(sel.active.line, sel.active.character - planned.replaceBack, sel.active.line, sel.active.character);
          const list2 = replaceGroups.get(planned.body);
          if (list2) list2.push(range);
          else replaceGroups.set(planned.body, [range]);
          verdicts.push(`"${found.word}" ${planned.rule}`);
          names.push(`${found.word} ${planned.rule}`);
          return;
        }
        const list = groups.get(planned.body);
        if (list) list.push(sel.active);
        else groups.set(planned.body, [sel.active]);
      });
      if (groups.size === 0 && replaceGroups.size === 0) {
        output2.appendLine(`[SharpSense] accept: ${verdicts.join("; ") || "no cursors"}`);
        return;
      }
      for (const [body, positions] of groups) {
        await after.insertSnippet(new vscode2.SnippetString(body), positions, { undoStopBefore: false, undoStopAfter: false });
      }
      for (const [body, ranges] of replaceGroups) {
        await after.insertSnippet(new vscode2.SnippetString(body), ranges, { undoStopBefore: false, undoStopAfter: false });
      }
      output2.appendLine(`[SharpSense] accept: ${verdicts.join("; ")} => decorated ${names.join(", ")} at ${after.selection.active.line + 1}:${after.selection.active.character}`);
      await vscode2.commands.executeCommand("editor.action.triggerParameterHints");
    });
  } catch (err) {
    output2.appendLine(`[SharpSense] commit shadow disabled: ${String(err)}`);
    return;
  }
  context.subscriptions.push(disposable);
}

// src/brackets.ts
var vscode3 = __toESM(require("vscode"));
var PAIRS = {
  "(": ")",
  "[": "]",
  "{": "}",
  "<": ">",
  '"': '"',
  "'": "'"
};
var CLOSES = /* @__PURE__ */ new Set([")", "]", "}", ">", '"', "'"]);
function charAfter(doc, pos) {
  const line = doc.lineAt(pos.line).text;
  return pos.character < line.length ? line[pos.character] : "";
}
function charBefore(doc, pos) {
  const line = doc.lineAt(pos.line).text;
  return pos.character > 0 ? line[pos.character - 1] : "";
}
function isEmptyPair(doc, pos) {
  const before = charBefore(doc, pos);
  return before !== "" && PAIRS[before] === charAfter(doc, pos);
}
var OPENERS = { "(": ")", "[": "]", "{": "}" };
function isTabOutAvailable(doc, pos) {
  const after = charAfter(doc, pos);
  if (CLOSES.has(after) || after === ";") return true;
  return doc.lineAt(pos.line).text.slice(pos.character, pos.character + 2) === "()";
}
function isWhitespaceLine(doc, line) {
  return doc.lineAt(line).text.trim() === "";
}
var lastTabOut;
var lastPair;
function updateContextKeys(ed, getSettings, output2) {
  const s = getSettings();
  let tab = false;
  let pair = false;
  if (ed.document.languageId === "csharp") {
    const allEmpty = ed.selections.every((sel) => sel.isEmpty);
    if (allEmpty) {
      tab = s.tabOut && ed.selections.every((sel) => isTabOutAvailable(ed.document, sel.active));
      pair = s.smartBackspace && ed.selections.every((sel) => isEmptyPair(ed.document, sel.active));
    }
  }
  if (tab !== lastTabOut) {
    lastTabOut = tab;
    void vscode3.commands.executeCommand("setContext", "sharpsense.tabOutAvailable", tab);
    if (output2 && getSettings().verbose) {
      output2.appendLine(`[SharpSense] tabOutAvailable -> ${tab}`);
    }
  }
  if (pair !== lastPair) {
    lastPair = pair;
    void vscode3.commands.executeCommand("setContext", "sharpsense.pairBackspaceAvailable", pair);
    if (output2) {
      const msg = `[SharpSense] pairBackspaceAvailable -> ${pair} at ${ed.document.lineAt(ed.selection.active.line).text.slice(Math.max(0, ed.selection.active.character - 2), ed.selection.active.character + 2)} (pos ${ed.selection.active.line}:${ed.selection.active.character})`;
      if (getSettings().verbose || pair) {
        output2.appendLine(msg);
      }
    }
  }
}
async function doTabOut() {
  const ed = vscode3.window.activeTextEditor;
  if (!ed || ed.document.languageId !== "csharp") {
    return;
  }
  ed.selections = ed.selections.map((sel) => {
    if (!sel.isEmpty) return sel;
    if (isTabOutAvailable(ed.document, sel.active)) {
      const next = sel.active.translate(0, 1);
      return new vscode3.Selection(next, next);
    }
    return sel;
  });
}
async function doDeletePair(output2) {
  const ed = vscode3.window.activeTextEditor;
  if (output2) {
    output2.appendLine(`[SharpSense] deletePair invoked at ${ed?.selection.active.line}:${ed?.selection.active.character} lang=${ed?.document.languageId} sel=${JSON.stringify(ed?.selections.map((s) => s.active.character))} line="${ed ? ed.document.lineAt(ed.selection.active.line).text : ""}"`);
  }
  if (!ed || ed.document.languageId !== "csharp") {
    if (output2) output2.appendLine("[SharpSense] deletePair abort: not csharp");
    return;
  }
  const ok = ed.selections.every((sel) => sel.isEmpty && isEmptyPair(ed.document, sel.active));
  if (!ok) {
    if (output2) output2.appendLine("[SharpSense] deletePair abort: not empty pair at exec time");
    return;
  }
  await ed.edit((builder) => {
    for (const sel of ed.selections) {
      if (!sel.isEmpty || !isEmptyPair(ed.document, sel.active)) {
        continue;
      }
      builder.delete(
        new vscode3.Range(sel.active.translate(0, -1), sel.active.translate(0, 1))
      );
    }
  });
  if (output2) {
    output2.appendLine("[SharpSense] deletePair edit applied");
  }
}
async function doDefaultBackspace(ed) {
  await ed.edit((builder) => {
    for (const sel of ed.selections) {
      if (!sel.isEmpty) {
        builder.delete(new vscode3.Range(sel.start, sel.end));
      } else if (sel.active.character > 0) {
        builder.delete(new vscode3.Range(sel.active.translate(0, -1), sel.active));
      } else if (sel.active.line > 0) {
        const prevLine = ed.document.lineAt(sel.active.line - 1);
        const prevEnd = new vscode3.Position(sel.active.line - 1, prevLine.text.length);
        builder.delete(new vscode3.Range(prevEnd, sel.active));
      }
    }
  });
}
async function doDeleteWhitespaceLine(ed, output2) {
  const linesToDelete = /* @__PURE__ */ new Set();
  for (const sel of ed.selections) {
    if (!sel.isEmpty) continue;
    if (isWhitespaceLine(ed.document, sel.active.line)) {
      linesToDelete.add(sel.active.line);
    }
  }
  if (linesToDelete.size === 0) return;
  const sorted = Array.from(linesToDelete).sort((a, b) => b - a);
  if (output2) output2.appendLine(`[SharpSense] whitespace line delete @${sorted.join(",")}`);
  await ed.edit((builder) => {
    for (const line of sorted) {
      if (!isWhitespaceLine(ed.document, line)) continue;
      if (line < ed.document.lineCount - 1) {
        builder.delete(new vscode3.Range(new vscode3.Position(line, 0), new vscode3.Position(line + 1, 0)));
      } else if (line > 0) {
        const prevLine = ed.document.lineAt(line - 1);
        const curLen = ed.document.lineAt(line).text.length;
        builder.delete(new vscode3.Range(new vscode3.Position(line - 1, prevLine.text.length), new vscode3.Position(line, curLen)));
        if (curLen === 0) {
        }
      } else {
        builder.delete(new vscode3.Range(new vscode3.Position(line, 0), new vscode3.Position(line, ed.document.lineAt(line).text.length)));
      }
    }
  });
  if (output2) output2.appendLine("[SharpSense] whitespace line delete applied");
}
function interceptDeleteLeft(output2, getSettings) {
  const ed = vscode3.window.activeTextEditor;
  if (output2 && getSettings().verbose) {
    output2.appendLine(`[SharpSense] deleteLeft intercept at ${ed?.selection.active.line}:${ed?.selection.active.character} lang=${ed?.document.languageId} line="${ed ? ed.document.lineAt(ed.selection.active.line).text : ""}"`);
  }
  if (!ed || ed.document.languageId !== "csharp") {
    if (ed) return doDefaultBackspace(ed);
    return Promise.resolve();
  }
  if (!getSettings().smartBackspace) {
    return doDefaultBackspace(ed);
  }
  const allEmpty = ed.selections.every((sel) => sel.isEmpty);
  if (!allEmpty) {
    return doDefaultBackspace(ed);
  }
  const anyWhitespace = ed.selections.some((sel) => isWhitespaceLine(ed.document, sel.active.line));
  if (anyWhitespace && ed.selections.every((sel) => isWhitespaceLine(ed.document, sel.active.line))) {
    return doDeleteWhitespaceLine(ed, output2);
  }
  if (ed.selections.every((sel) => isEmptyPair(ed.document, sel.active))) {
    if (output2) output2.appendLine("[SharpSense] deleteLeft pair intercept -> deletePair");
    return doDeletePair(output2);
  }
  return doDefaultBackspace(ed);
}
async function interceptType(args, output2, getSettings) {
  const forward = () => vscode3.commands.executeCommand("default:type", args).then(
    () => void 0,
    (err) => {
      output2.appendLine(`[SharpSense] type forward failed: ${String(err)}`);
    }
  );
  const ed = vscode3.window.activeTextEditor;
  const ch = args?.text;
  if (!ed || ed.document.languageId !== "csharp" || typeof ch !== "string" || ch.length !== 1) {
    return forward();
  }
  if (!ed.selections.every((sel) => sel.isEmpty)) {
    return forward();
  }
  const s = getSettings();
  if (CLOSES.has(ch) && s.overtype) {
    if (ed.selections.every((sel) => charAfter(ed.document, sel.active) === ch)) {
      ed.selections = ed.selections.map((sel) => {
        const next = sel.active.translate(0, 1);
        return new vscode3.Selection(next, next);
      });
      return Promise.resolve();
    }
    return forward();
  }
  const expectedClose = OPENERS[ch];
  if (expectedClose && s.overtype) {
    if (ed.selections.every((sel) => {
      const line = ed.document.lineAt(sel.active.line).text;
      return line.slice(sel.active.character, sel.active.character + 2) === ch + expectedClose;
    })) {
      ed.selections = ed.selections.map((sel) => {
        const next = sel.active.translate(0, 1);
        return new vscode3.Selection(next, next);
      });
      return Promise.resolve();
    }
  }
  if (ch === ".") {
    const chain = ed.selections.every((sel) => charAfter(ed.document, sel.active) === ";" && charBefore(ed.document, sel.active) === ")");
    if (chain) {
      await ed.edit((builder) => {
        for (const sel of ed.selections) {
          builder.delete(new vscode3.Range(sel.active, sel.active.translate(0, 1)));
          builder.insert(sel.active, ".");
        }
      });
      ed.selections = ed.selections.map((sel) => new vscode3.Selection(sel.active.translate(0, 1), sel.active.translate(0, 1)));
      return Promise.resolve();
    }
  }
  if (ch === ";" && s.smartParens) {
    const insideWithSemi = ed.selections.every((sel) => {
      if (charAfter(ed.document, sel.active) !== ")") return false;
      const afterParen = sel.active.translate(0, 1);
      const line = ed.document.lineAt(afterParen.line).text;
      return afterParen.character < line.length && line[afterParen.character] === ";";
    });
    if (insideWithSemi) {
      ed.selections = ed.selections.map((sel) => new vscode3.Selection(sel.active.translate(0, 2), sel.active.translate(0, 2)));
      return Promise.resolve();
    }
    if (ed.selections.every((sel) => charAfter(ed.document, sel.active) === ")")) {
      ed.selections = ed.selections.map((sel) => {
        const next = sel.active.translate(0, 1);
        return new vscode3.Selection(next, next);
      });
      if (ed.selections.every((sel) => charAfter(ed.document, sel.active) === ";")) {
        ed.selections = ed.selections.map((sel) => new vscode3.Selection(sel.active.translate(0, 1), sel.active.translate(0, 1)));
        return Promise.resolve();
      }
      return forward();
    }
    if (ed.selections.every((sel) => charAfter(ed.document, sel.active) === ";")) {
      ed.selections = ed.selections.map((sel) => {
        const next = sel.active.translate(0, 1);
        return new vscode3.Selection(next, next);
      });
      return Promise.resolve();
    }
  }
  return forward();
}
function registerBracketHandlers(context, output2, getSettings) {
  context.subscriptions.push(
    vscode3.commands.registerCommand("sharpsense.tabOut", () => doTabOut()),
    vscode3.commands.registerCommand("sharpsense.deletePair", () => doDeletePair(output2)),
    vscode3.window.onDidChangeTextEditorSelection((e) => updateContextKeys(e.textEditor, getSettings, output2)),
    vscode3.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode3.window.activeTextEditor;
      if (ed && ed.document === e.document) {
        updateContextKeys(ed, getSettings, output2);
      }
    }),
    vscode3.commands.registerCommand("type", (args) => interceptType(args, output2, getSettings)),
    vscode3.commands.registerCommand("deleteLeft", () => interceptDeleteLeft(output2, getSettings))
  );
  if (vscode3.window.activeTextEditor) {
    updateContextKeys(vscode3.window.activeTextEditor, getSettings, output2);
  }
}

// src/extension.ts
var output;
var settings;
function readSettings() {
  const config = vscode4.workspace.getConfiguration("sharpsense");
  settings = {
    smartParens: config.get("smartParens", true),
    smartGenerics: config.get("smartGenerics", true),
    smartBackspace: config.get("smartBackspace", true),
    tabOut: config.get("tabOut", true),
    overtype: config.get("overtype", true),
    postfix: config.get("postfixTemplates", true),
    verbose: config.get("verboseLogging", false),
    braceStyle: config.get("braceStyle", "allman"),
    smartSemicolon: config.get("smartSemicolon", true)
  };
  return settings;
}
function activate(context) {
  output = vscode4.window.createOutputChannel("SharpSense");
  output.appendLine("[SharpSense] starting activate...");
  try {
    output.appendLine(`[SharpSense] extensions active: ${(vscode4.extensions?.all ?? []).filter((e) => /csharp|csdevkit/i.test(e.id)).map((e) => e.id).join(",") || "(none yet)"}`);
  } catch {
  }
  readSettings();
  try {
    const editorCfg = vscode4.workspace.getConfiguration("editor");
    output.appendLine(`[SharpSense] editor.tabCompletion=${String(editorCfg.get("tabCompletion"))} acceptSuggestionOnEnter=${String(editorCfg.get("acceptSuggestionOnEnter"))}`);
  } catch {
  }
  context.subscriptions.push(
    output,
    vscode4.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("sharpsense")) {
        readSettings();
      }
    })
  );
  const getSettings = () => settings;
  try {
    registerCommitShadow(context, output, getSettings);
    output.appendLine("[SharpSense] commitShadow registered");
  } catch (e) {
    output.appendLine(`[SharpSense] commitShadow failed: ${String(e)} 
${e?.stack ?? ""}`);
  }
  try {
    registerLiveTemplateProvider(context, getSettings);
    output.appendLine("[SharpSense] liveTemplates registered");
  } catch (e) {
    output.appendLine(`[SharpSense] liveTemplates failed: ${String(e)} 
${e?.stack ?? ""}`);
  }
  try {
    registerPostfixProvider(context, getSettings);
    output.appendLine("[SharpSense] postfix registered");
  } catch (e) {
    output.appendLine(`[SharpSense] postfix failed: ${String(e)} 
${e?.stack ?? ""}`);
  }
  try {
    registerExpectedNewProvider(context, getSettings);
    output.appendLine("[SharpSense] expectedNew registered");
  } catch (e) {
    output.appendLine(`[SharpSense] expectedNew failed: ${String(e)} 
${e?.stack ?? ""}`);
  }
  try {
    registerBracketHandlers(context, output, getSettings);
    output.appendLine("[SharpSense] brackets registered");
  } catch (e) {
    output.appendLine(`[SharpSense] brackets failed: ${String(e)} 
${e?.stack ?? ""}`);
  }
  context.subscriptions.push(
    vscode4.commands.registerCommand("sharpsense.showStatus", () => {
      const s = readSettings();
      void vscode4.window.showInformationMessage(
        `SharpSense ON \u2014 parens=${s.smartParens} generics=${s.smartGenerics} backspace=${s.smartBackspace} tabOut=${s.tabOut} overtype=${s.overtype} postfix=${s.postfix} braces=${s.braceStyle} semi=${s.smartSemicolon}`
      );
    }),
    vscode4.commands.registerCommand("sharpsense.logContext", async () => {
      const ed = vscode4.window.activeTextEditor;
      if (!ed || ed.document.languageId !== "csharp") {
        void vscode4.window.showInformationMessage("SharpSense: open a C# file first.");
        return;
      }
      const pos = ed.selection.active;
      const lineText = ed.document.lineAt(pos.line).text;
      const detected = detectInvokeContext(
        lineText.slice(0, pos.character),
        lineText.slice(pos.character)
      );
      output.appendLine(
        `[SharpSense] ${pos.line + 1}:${pos.character} -> ${detected.kind} (name="${detected.name}")`
      );
      await logRoslynRows(output, ed.document, pos);
      output.show(true);
    })
  );
  output.appendLine(
    `[SharpSense] activated (Phase 1.x Accept-Handler) ${JSON.stringify({
      smartParens: settings.smartParens,
      smartGenerics: settings.smartGenerics,
      smartBackspace: settings.smartBackspace,
      smartSemicolon: settings.smartSemicolon
    })}`
  );
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
