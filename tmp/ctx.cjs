"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/context.ts
var context_exports = {};
__export(context_exports, {
  MODIFIERS: () => MODIFIERS,
  collapseGenericArgs: () => collapseGenericArgs,
  detectInvokeContext: () => detectInvokeContext,
  extractPostfixTarget: () => extractPostfixTarget,
  isBareModifierHead: () => isBareModifierHead,
  isGenericInferrable: () => isGenericInferrable,
  parseGenericArity: () => parseGenericArity,
  resolveBraceStyle: () => resolveBraceStyle,
  stripAttributeTrivia: () => stripAttributeTrivia,
  stripLeadingTrivia: () => stripLeadingTrivia
});
module.exports = __toCommonJS(context_exports);
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
  "void var object string int bool double float decimal char byte sbyte short ushort uint long ulong nint nuint dynamic".split(" ")
);
var MODIFIERS = "public|private|protected|internal|static|readonly|volatile|virtual|override|abstract|sealed|extern|unsafe|async|partial|required|file|scoped|event|const|record|class|struct|interface|enum|namespace|using|case|new|implicit|explicit|operator";
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
function collapseGenericArgs(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== "<") {
      out += c;
      i++;
      continue;
    }
    let depth = 0;
    let j = i;
    while (j < s.length) {
      if (s[j] === "<") {
        depth++;
      } else if (s[j] === ">") {
        depth--;
        if (depth === 0) {
          break;
        }
      }
      j++;
    }
    if (depth === 0) {
      out += "<>";
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
function stripLeadingTrivia(s) {
  return s.replace(/^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*)+/, "");
}
function stripAttributeTrivia(s) {
  return s.replace(/^\s*(?:\[[^\]]*\]\s*)*/, "");
}
function isDeclarationHead(head) {
  const withoutAttrs = stripAttributeTrivia(head);
  const { hadModifier, rest } = stripModifiers(withoutAttrs.trimStart());
  const trimmed = rest.trimEnd();
  const collapsed = collapseGenericArgs(trimmed);
  const twoWord = collapsed.match(/((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*(?:<>)?(?:\[\])*\??)\s+([A-Za-z_]\w*(?:<>)?)$/);
  if (twoWord && isTypeLike(twoWord[1])) {
    return true;
  }
  if (hadModifier && /^[A-Z][A-Za-z0-9_]*$/.test(trimmed)) {
    return true;
  }
  const single = collapsed.match(new RegExp(`^(?:(?:${MODIFIERS})\\s+)*((?:[A-Za-z_]\\w*\\.)*[A-Za-z_]\\w*(?:<>)?(?:\\[\\])*\\??)$`, "i"));
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
  if (/^\s*\(/.test(stripLeadingTrivia(suffix))) {
    const dupName = prefix.match(/([A-Za-z_]\w*)(<[^<>]*>)?$/)?.[1] ?? "";
    return { kind: "existing-parens", name: dupName };
  }
  const genericNew = prefix.match(/\bnew\s+([A-Za-z_][\w.]*<[^<>]*>)$/) ?? collapseGenericArgs(prefix).match(/\bnew\s+([A-Za-z_][\w.]*<>)$/);
  if (genericNew) {
    return { kind: "object-creation", name: genericNew[1] };
  }
  const nameMatch = prefix.match(/([A-Za-z_]\w*)(<[^<>]*>)?$/);
  const name = nameMatch ? nameMatch[1] : "";
  if (!name) {
    return { kind: "other", name: "" };
  }
  const nameofIdx = prefix.search(/\bnameof\s*\(/);
  if (nameofIdx !== -1) {
    let depth = 0;
    for (let i = nameofIdx; i < prefix.length; i++) {
      if (prefix[i] === "(") {
        depth++;
      } else if (prefix[i] === ")") {
        depth--;
      }
    }
    if (depth > 0) {
      return { kind: "suppress-nameof", name };
    }
  }
  if (/[+-]=\s*(?:[\w.]+\.)?[A-Za-z_]\w*$/.test(prefix)) {
    return { kind: "suppress-plus-equals", name };
  }
  if (/(?:^|[\s(,=])\[[^\[\]]*?[A-Za-z_]\w*$/.test(prefix)) {
    return { kind: "attribute", name };
  }
  if (/\bnew\s+[A-Za-z_][\w.]*$/.test(prefix)) {
    return { kind: "object-creation", name };
  }
  const rawName = nameMatch?.[0] ?? name;
  const head = prefix.slice(0, prefix.length - rawName.length);
  {
    const lastScope = Math.max(prefix.lastIndexOf("{"), prefix.lastIndexOf("}"), prefix.lastIndexOf(";"));
    const afterScope = lastScope >= 0 ? prefix.slice(lastScope + 1) : prefix;
    if (new RegExp(`^\\s*(?:(?:${MODIFIERS})\\s+)*~[A-Za-z_]\\w*\\s*$`).test(afterScope)) {
      return { kind: "definition", name };
    }
  }
  const headOnly = stripModifiers(stripAttributeTrivia(head).trimStart());
  if (headOnly.hadModifier && headOnly.rest.trim() === "" && /^[A-Z]/.test(name)) {
    return { kind: "definition", name };
  }
  {
    const qm = prefix.match(/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)(?:<[^<>]*>)?$/);
    if (qm) {
      const qualified = qm[1];
      const lastDot = qualified.lastIndexOf(".");
      const ifacePart = qualified.slice(0, lastDot);
      const memberPart = qualified.slice(lastDot + 1);
      const ifaceBase = ifacePart.split(".").pop() ?? "";
      if (/^[A-Z]/.test(ifaceBase) && memberPart === name) {
        const beforeQualified = prefix.slice(0, prefix.length - qm[0].length);
        const bt = beforeQualified.trimEnd();
        const lastChar = bt.slice(-1);
        const looksLikeInvocationChar = /[=(\[,;]/.test(lastChar);
        if (!looksLikeInvocationChar) {
          const lastToken = (bt.split(/\s+/).pop() ?? "").replace(/<.*>$/, "");
          const probe = bt.trim() !== "" && (isDeclarationHead(bt) || isBareModifierHead(bt) || isTypeLike(lastToken));
          if (probe) return { kind: "definition", name };
        }
      }
    }
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MODIFIERS,
  collapseGenericArgs,
  detectInvokeContext,
  extractPostfixTarget,
  isBareModifierHead,
  isGenericInferrable,
  parseGenericArity,
  resolveBraceStyle,
  stripAttributeTrivia,
  stripLeadingTrivia
});
