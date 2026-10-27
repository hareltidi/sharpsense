// SharpSense — Complete Statement / Brace-Wrap (Rider Ctrl+Shift+Enter parity).
//
// Wraps a single un-braced control-flow body in braces following the configured
// brace style, and completes the inner statement with `;`. Operates on the
// construct the cursor sits in or just finished:
//
//   if (condition) return;   ->   if (condition)
//                                  {
//                                      return;
//                                  }
//
// Pure syntactic analysis only (no Roslyn, no type awareness) — the "million
// edge cases" degrade to: any `if`/`else`/`while`/`for`/`foreach`/`using`/`lock`/
// `fixed`/`do`/`try` with a single un-braced body. Already-braced constructs are
// left untouched (never double-brace).

import * as vscode from 'vscode';
import { resolveBraceStyle, type BraceStyleSetting, type ResolvedBraceStyle, type SharpSenseSettings } from './context';

/** Re-indent every line after the first so it nests one level inside the block. */
function indent(t: string, s = '\t'): string {
  return t.split('\n').map((l, i) => (i ? s + l : l)).join('\n');
}

/** First control keyword at bracket-depth 0 in `line`, or null. */
function firstKeywordAtDepthZero(line: string): { index: number; keyword: string } | null {
  const tokens = line.match(/\b(if|else|while|for|foreach|using|lock|fixed|do|try)\b/g);
  if (!tokens) return null;
  let depth = 0;
  const re = /\b(if|else|while|for|foreach|using|lock|fixed|do|try)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const idx = m.index;
    let d = 0;
    for (let i = 0; i < idx; i++) {
      const c = line[i];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d = Math.max(0, d - 1);
    }
    if (d === 0) return { index: idx, keyword: m[1] };
  }
  return null;
}

/** True when `line` has a `;`/`{`/`}` at bracket-depth 0 before `index`. */
function hasBoundaryBefore(line: string, index: number): boolean {
  let d = 0;
  for (let i = 0; i < index; i++) {
    const c = line[i];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d = Math.max(0, d - 1);
    else if (d === 0 && (c === ';' || c === '{' || c === '}')) return true;
  }
  return false;
}

/** True when `line` terminates a statement at depth 0 (`;`/`{`/`}` anywhere). */
function hasStatementBoundary(line: string): boolean {
  return hasBoundaryBefore(line, line.length);
}

export interface ParsedConstruct {
  keyword: string;
  /** Index in `text` just after the keyword + its condition (the `)`). */
  headerEnd: number;
  /** Index where the single body statement starts. */
  bodyStart: number;
  /** Exclusive index where the body ends (at its `;`, or text end). */
  bodyEnd: number;
  /** The body text (trimmed of surrounding whitespace). */
  bodyText: string;
  /** Body was already `{ ... }` — caller should no-op. */
  alreadyBraced: boolean;
  /** `do ... while` shape: body precedes the `while (cond);` tail. */
  isDoWhile: boolean;
  /** Trailing ` while (cond);` portion (do-while only). */
  tail: string;
}

/**
 * Pure parse of a control-flow construct from `text`. `text` should be the
 * window of source containing exactly one construct (header + single body).
 * Returns null when no recognizable un-braced control statement is present.
 */
export function parseConstruct(text: string): ParsedConstruct | null {
  const kw = firstKeywordAtDepthZero(text);
  if (!kw) return null;

  let keyword = kw.keyword;
  let headerEnd = kw.index + keyword.length;
  let isDoWhile = false;

  if (keyword === 'else') {
    const rest = text.slice(kw.index + keyword.length);
    const m = rest.match(/^\s*if\b/);
    if (m) {
      const ifIdx = kw.index + keyword.length + m[0].length;
      keyword = 'if';
      headerEnd = ifIdx;
    } else {
      headerEnd = kw.index + keyword.length + (rest.match(/^\s*/)?.[0].length ?? 0);
    }
  }

  if (keyword === 'do') {
    isDoWhile = true;
    const rest = text.slice(kw.index + keyword.length);
    headerEnd = kw.index + keyword.length + (rest.match(/^\s*/)?.[0].length ?? 0);
  } else if (keyword === 'try') {
    const rest = text.slice(kw.index + keyword.length);
    headerEnd = kw.index + keyword.length + (rest.match(/^\s*/)?.[0].length ?? 0);
  } else {
    const open = text.indexOf('(', kw.index + keyword.length);
    if (open === -1) return null;
    let depth = 0;
    let close = -1;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close === -1) return null;
    headerEnd = close + 1;
  }

  let bodyStart = headerEnd;
  while (bodyStart < text.length && /\s/.test(text[bodyStart])) bodyStart++;
  if (bodyStart >= text.length) return null;

  const firstBodyChar = text[bodyStart];
  if (firstBodyChar === '{') {
    return {
      keyword,
      headerEnd,
      bodyStart,
      bodyEnd: text.length,
      bodyText: '',
      alreadyBraced: true,
      isDoWhile,
      tail: '',
    };
  }

  let bodyEnd: number;
  let tail = '';
  if (isDoWhile) {
    const wi = text.indexOf('while', bodyStart);
    if (wi === -1) return null;
    bodyEnd = wi;
    tail = text.slice(wi);
  } else {
    let depth = 0;
    let end = text.length;
    let found = false;
    for (let i = bodyStart; i < text.length; i++) {
      const c = text[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
      else if (c === ';' && depth === 0) { end = i + 1; found = true; break; }
    }
    bodyEnd = found ? end : text.length;
  }

  const bodyText = text.slice(bodyStart, bodyEnd).trim();
  if (bodyText.length === 0) return null;

  return {
    keyword,
    headerEnd,
    bodyStart,
    bodyEnd,
    bodyText,
    alreadyBraced: false,
    isDoWhile,
    tail,
  };
}

/** True when an expression statement needs a trailing `;` to be complete. */
function needsSemicolon(body: string): boolean {
  const t = body.trimEnd();
  if (t.length === 0) return false;
  const last = t.slice(-1);
  return ![';', '}', ')', ':'].includes(last);
}

function buildReplacement(text: string, parsed: ParsedConstruct, bs: ResolvedBraceStyle): string {
  const open = bs === 'allman' ? '\n{\n\t' : ' {\n\t';
  const close = '\n}';
  let inner = parsed.bodyText.trim();
  if (needsSemicolon(inner)) inner += ';';
  const prefix = text.slice(0, parsed.bodyStart);
  return prefix + open + indent(inner) + close + parsed.tail;
}

/**
 * Locate the enclosing control statement around `pos`, parse it, and return the
 * range + replacement that wraps its single body in braces. Null when there is
 * nothing to do (no construct, already braced, or parse failure).
 */
export function wrapControlStatement(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  braceSetting: BraceStyleSetting,
): { range: vscode.Range; replacement: string } | null {
  const bs = resolveBraceStyle(braceSetting, doc.getText());

  let startLine = pos.line;
  for (let l = pos.line; l >= Math.max(0, pos.line - 12); l--) {
    const line = doc.lineAt(l).text;
    const kw = firstKeywordAtDepthZero(line);
    if (kw && !hasBoundaryBefore(line, kw.index)) {
      startLine = l;
      break;
    }
    if (l < pos.line && hasStatementBoundary(line)) break;
  }

  const maxLines = 16;
  let text = '';
  let endLine = startLine;
  const lastLine = Math.min(doc.lineCount - 1, startLine + maxLines);
  for (let l = startLine; l <= lastLine; l++) {
    const lt = doc.lineAt(l).text;
    text = l === startLine ? lt : `${text}\n${lt}`;
    endLine = l;
  }

  const parsed = parseConstruct(text);
  if (!parsed || parsed.alreadyBraced) return null;

  const replacement = buildReplacement(text, parsed, bs);
  if (replacement === text) return null;

  const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
  return { range, replacement };
}

export function registerCompleteStatement(
  context: vscode.ExtensionContext,
  getSettings: () => SharpSenseSettings,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sharpsense.completeStatement', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.languageId !== 'csharp') return;
      const pos = ed.selection.active;
      const result = wrapControlStatement(ed.document, pos, getSettings().braceStyle);
      if (!result) return;
      void ed.edit(
        (b) => b.replace(result.range, result.replacement),
        { undoStopBefore: false, undoStopAfter: false },
      );
    }),
  );
}
