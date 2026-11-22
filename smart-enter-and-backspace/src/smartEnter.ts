// Smart Enter — language-agnostic.
//
//   1. {|}           → multi-line block (Allman / K&R per setting)
//   2. block header  → `void Foo()|` gains its brace block
//   3. control header→ `for (...)|` newline + one indent, braces deliberately
//                      deferred until the user types `{`
//   4. unclosed stmt → append `;`, newline + one indent
//
// Indentation-based languages never reach this module: Enter is left to the
// editor's native auto-indent.

import * as vscode from 'vscode';
import type { Settings } from './settings';
import { resolveBraceStyle } from './settings';
import { isTypeLike, type LanguageProfile } from './languages';
import {
  getIndentUnit,
  leadingIndent,
  sampleText,
  stripAttributeTrivia,
  stripLeadingTrivia,
} from './util';

export interface BraceExpandResult {
  openLine: number;
  openCol: number;
  closeCol: number;
}

export function detectBraceAt(
  ed: vscode.TextEditor,
  sel: vscode.Selection,
): BraceExpandResult | null {
  if (!sel.isEmpty) return null;
  const doc = ed.document;
  const line = doc.lineAt(sel.active.line).text;
  const pos = sel.active.character;
  let i = pos;
  while (i > 0 && line[i - 1] === ' ') i--;
  const openIdx = i > 0 ? i - 1 : -1;
  if (openIdx < 0 || line[openIdx] !== '{') return null;
  let j = pos;
  while (j < line.length && line[j] === ' ') j++;
  const closeIdx = j < line.length ? j : -1;
  if (closeIdx < 0 || line[closeIdx] !== '}') return null;
  if (closeIdx <= openIdx) return null;
  return { openLine: sel.active.line, openCol: openIdx, closeCol: closeIdx };
}

/**
 * True when the cursor ends a member/type/function declaration header — the
 * line closes its parameter list and nothing meaningful follows. Control-flow
 * keywords are excluded (they are section 3's job). Call sites are rejected:
 * `foo()` is only a header when the language treats a bare capitalised name as
 * a constructor, or when the name itself is a declaration keyword.
 */
function isBlockHeader(prefix: string, suffix: string, profile: LanguageProfile): boolean {
  const ss = stripLeadingTrivia(suffix);
  if (ss.length > 0 && !/^(?:\{|;|\))/.test(ss)) return false;
  const trimmed = prefix.trimEnd();
  if (!/\)$/.test(trimmed)) return false;
  let depth = 0;
  let hasOpen = false;
  for (const c of trimmed) {
    if (c === '(') {
      depth++;
      hasOpen = true;
    } else if (c === ')') {
      depth--;
    }
  }
  if (!hasOpen || depth !== 0) return false;

  const s = stripAttributeTrivia(stripLeadingTrivia(prefix));
  const first = s.match(/^([A-Za-z_$]\w*)/)?.[1];
  if (!first) return false;
  if (profile.controlKeywords.has(first)) return false;

  // Opening paren matching the final `)`.
  let scan = 0;
  let openIdx = -1;
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i];
    if (c === ')') {
      scan++;
    } else if (c === '(') {
      if (scan === 0) break;
      scan--;
      if (scan === 0) {
        openIdx = i;
        break;
      }
    }
  }
  if (openIdx < 0) return false;

  const before = s.slice(0, openIdx).trimEnd();
  if (!before) return false;
  if (before.endsWith('.')) return false; // member / fluent call chain
  const tokens = before.split(/\s+/);
  const name = tokens[tokens.length - 1];
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false;
  const rest = tokens.slice(0, -1);

  if (rest.length === 0) {
    if (profile.declKeywords.has(name)) return true; // `constructor(`, `init(`
    return profile.bareNameIsConstructor && /^[A-Z]/.test(name);
  }
  if (rest.every((t) => profile.declKeywords.has(t))) return true;
  if (!profile.bareNameIsConstructor) return false;
  const last = rest[rest.length - 1];
  if (!isTypeLike(last)) return false;
  const beforeLast = rest.slice(0, -1);
  return beforeLast.length === 0 || beforeLast.every((t) => profile.declKeywords.has(t));
}

/** True when the cursor ends a control-flow condition (or bare `do`/`try`/`else`). */
function isControlHeader(prefix: string, suffix: string, profile: LanguageProfile): boolean {
  const ss = stripLeadingTrivia(suffix);
  if (ss.length > 0 && !ss.startsWith('{')) return false;
  const trimmed = prefix.trimEnd();
  if (prefix.includes('{') || prefix.includes('}')) return false;

  const s = stripAttributeTrivia(stripLeadingTrivia(prefix));
  const kw = s.match(/^([A-Za-z_]\w*)/)?.[1];
  if (!kw || !profile.controlKeywords.has(kw)) return false;

  if (/^(?:do|try|else|finally)$/.test(trimmed)) return true;
  if (!/\)$/.test(trimmed)) return false;

  let depth = 0;
  let hasOpen = false;
  for (const c of trimmed) {
    if (c === '(') {
      depth++;
      hasOpen = true;
    } else if (c === ')') {
      depth--;
    }
  }
  return hasOpen && depth === 0;
}

/** True when the line is a statement that still needs its terminating semicolon. */
function isUnclosedStatement(prefix: string, suffix: string, profile: LanguageProfile): boolean {
  const codeSuffix = stripLeadingTrivia(suffix);
  if (/^[{;}]/.test(codeSuffix)) return false;
  const code = stripLeadingTrivia(prefix);
  if (code === '') return false;
  if (code.startsWith('//') || code.startsWith('/*')) return false;
  const first = code.match(/^([A-Za-z_]\w*)/)?.[1];
  if (first && (profile.controlKeywords.has(first) || profile.nonStatementStarters.has(first))) {
    return false;
  }
  const trimmed = prefix.trimEnd();
  if (!/[)\]"'`\d\w]$/.test(trimmed)) return false;
  const tokens = code.split(/\s+/);
  const lastToken = tokens[tokens.length - 1];
  if (profile.declKeywords.has(lastToken)) return false;
  if (isBlockHeader(prefix, suffix, profile)) return false;
  return true;
}

export async function trySmartEnter(
  ed: vscode.TextEditor,
  settings: Settings,
  profile: LanguageProfile,
): Promise<boolean> {
  if (!settings.smartEnter) return false;
  // Indentation-based languages: native auto-indent is the correct behavior.
  if (profile.family !== 'braced') return false;

  const sel = ed.selections[0];
  if (!sel.isEmpty) return false;
  const doc = ed.document;
  const line = doc.lineAt(sel.active.line);
  const prefix = line.text.slice(0, sel.active.character);
  const suffix = line.text.slice(sel.active.character);
  const indent = leadingIndent(line.text);
  const unit = getIndentUnit(doc);
  const innerIndent = indent + unit;

  // 1. {|} brace expansion
  const r = settings.braceExpansion ? detectBraceAt(ed, sel) : null;
  if (r) {
    const resolved = resolveBraceStyle(settings.braceStyle, sampleText(doc));
    const range = new vscode.Range(
      new vscode.Position(r.openLine, r.openCol),
      new vscode.Position(r.openLine, r.closeCol + 1),
    );
    if (resolved === 'k&r') {
      const block = '{\n' + innerIndent + '\n' + indent + '}';
      await ed.edit((b) => b.replace(range, block));
      const p = new vscode.Position(r.openLine + 1, innerIndent.length);
      ed.selections = [new vscode.Selection(p, p)];
      return true;
    }
    const block = '\n' + indent + '{\n' + innerIndent + '\n' + indent + '}';
    await ed.edit((b) => b.replace(range, block));
    const p = new vscode.Position(r.openLine + 2, innerIndent.length);
    ed.selections = [new vscode.Selection(p, p)];
    return true;
  }

  const codeSuffix = stripLeadingTrivia(suffix);
  const hasBraceOnLine = codeSuffix.startsWith('{');

  // 2. Block header (`void Foo()|`, `function foo()|`, `func foo()|`)
  if (isBlockHeader(prefix, suffix, profile)) {
    const resolved = resolveBraceStyle(settings.braceStyle, sampleText(doc));
    const lineNo = line.lineNumber;
    if (hasBraceOnLine) {
      await ed.edit((b) => {
        b.insert(sel.active, '\n' + innerIndent);
      });
      const p = new vscode.Position(lineNo + 1, innerIndent.length);
      ed.selections = [new vscode.Selection(p, p)];
      return true;
    }
    if (resolved === 'k&r') {
      await ed.edit((b) => {
        b.insert(new vscode.Position(lineNo, line.text.length), ' {\n' + innerIndent);
      });
      const p = new vscode.Position(lineNo + 1, innerIndent.length);
      ed.selections = [new vscode.Selection(p, p)];
      return true;
    }
    await ed.edit((b) => {
      b.insert(new vscode.Position(lineNo, line.text.length), '\n' + indent + '{\n' + innerIndent);
    });
    const p = new vscode.Position(lineNo + 2, innerIndent.length);
    ed.selections = [new vscode.Selection(p, p)];
    return true;
  }

  // 3. Control-flow header: indent only, braces deferred to the user.
  if (isControlHeader(prefix, suffix, profile)) {
    const lineNo = line.lineNumber;
    if (hasBraceOnLine) {
      // Cursor sits right after `{` — open a line inside the existing block.
      await ed.edit((b) => {
        b.insert(sel.active, '\n' + innerIndent);
      });
      const p = new vscode.Position(lineNo + 1, innerIndent.length);
      ed.selections = [new vscode.Selection(p, p)];
      return true;
    }
    await ed.edit((b) => {
      b.insert(new vscode.Position(lineNo, line.text.length), '\n' + innerIndent);
    });
    const p = new vscode.Position(lineNo + 1, innerIndent.length);
    ed.selections = [new vscode.Selection(p, p)];
    return true;
  }

  // 4. Missing semicolon.
  if (settings.smartSemicolon && profile.semicolons && isUnclosedStatement(prefix, suffix, profile)) {
    const lineNo = line.lineNumber;
    const insertAt = prefix.trimEnd().length;
    await ed.edit((b) => {
      b.insert(new vscode.Position(lineNo, line.text.length), '\n' + indent);
      b.insert(new vscode.Position(lineNo, insertAt), ';');
    });
    const p = new vscode.Position(lineNo + 1, indent.length);
    ed.selections = [new vscode.Selection(p, p)];
    return true;
  }

  return false;
}
