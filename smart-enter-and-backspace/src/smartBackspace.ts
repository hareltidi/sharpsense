// Smart Backspace — language-agnostic.
//
// Interior: cursor inside `(   |   )` collapses to `(|)` on the first press.
// Unindent: backspacing within leading whitespace collapses to a tab stop, the
//           previous non-blank line's indent, or deletes the blank line and
//           rejoins it (`toProper`).
//
// Indentation-based languages (Python, YAML, F#, ...) use "nearest indent"
// instead: the caret snaps to the closest enclosing indentation level, and the
// brace-oriented modes are bypassed entirely.

import * as vscode from 'vscode';
import type { Settings, UnindentMode } from './settings';
import type { LanguageProfile } from './languages';
import { getTabSize } from './util';

const PAIRS: Record<string, string> = { '(': ')', '{': '}', '[': ']', '<': '>' };

export async function tryCollapseInteriorWhitespace(ed: vscode.TextEditor): Promise<boolean> {
  for (const sel of ed.selections) {
    if (!sel.isEmpty) return false;
  }
  const ranges: { line: number; start: number; end: number }[] = [];
  for (const sel of ed.selections) {
    const doc = ed.document;
    const line = doc.lineAt(sel.active.line).text;
    const pos = sel.active.character;
    let i = pos;
    while (i > 0 && line[i - 1] === ' ') i--;
    const opener = i > 0 ? line[i - 1] : '';
    let j = pos;
    while (j < line.length && line[j] === ' ') j++;
    const closer = j < line.length ? line[j] : '';
    if (!(opener in PAIRS) || PAIRS[opener] !== closer) return false;
    if (pos - i + (j - pos) === 0) return false;
    ranges.push({ line: sel.active.line, start: i, end: j });
  }
  await ed.edit((builder) => {
    for (const r of ranges) {
      builder.delete(new vscode.Range(r.line, r.start, r.line, r.end));
    }
  });
  ed.selections = ranges.map((r) => {
    const p = new vscode.Position(r.line, r.start + 1);
    return new vscode.Selection(p, p);
  });
  return true;
}

/** Leading-whitespace width of a line in visual columns. */
function indentColumn(line: string, tabSize: number): number {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') col += 1;
    else if (c === '\t') col += tabSize - (col % tabSize);
    else break;
  }
  return col;
}

/** Convert a visual column back to a character offset within leading whitespace. */
function charCountForColumn(line: string, targetCol: number, tabSize: number): number {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') col += 1;
    else if (c === '\t') col += tabSize - (col % tabSize);
    else return i;
    if (col >= targetCol) return i + 1;
  }
  return line.length;
}

function leadingWsEnd(text: string): number {
  let i = 0;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

/**
 * Nearest enclosing indent: the largest indentation level among the preceding
 * non-blank lines that is strictly smaller than the caret's column.
 */
function nearestIndentColumn(
  doc: vscode.TextDocument,
  lineNo: number,
  col: number,
  tabSize: number,
): number {
  let best = 0;
  let seen = 0;
  for (let l = lineNo - 1; l >= 0 && seen < 200; l--) {
    const text = doc.lineAt(l).text;
    if (text.trim() === '') continue;
    seen++;
    const indent = indentColumn(text, tabSize);
    if (indent > best && indent < col) best = indent;
  }
  return best;
}

export async function trySmartUnindent(
  ed: vscode.TextEditor,
  settings: Settings,
  profile: LanguageProfile,
): Promise<boolean> {
  if (!settings.smartBackspace) return false;

  const useNearestIndent =
    profile.family === 'indented' && settings.indentedLanguagesUseNearestIndent;
  const mode: UnindentMode = settings.backspaceUnindentMode;
  if (!useNearestIndent && mode === 'none') return false;

  const tabSize = getTabSize(ed.document);

  for (const sel of ed.selections) {
    if (!sel.isEmpty) return false;
  }

  const collapses: { line: number; start: number; end: number }[] = [];
  const merges: { line: number; targetLine: number; deleteEnd: number; cursorPos: number }[] = [];

  for (const sel of ed.selections) {
    const doc = ed.document;
    const lineNo = sel.active.line;
    const line = doc.lineAt(lineNo).text;
    const col = sel.active.character;
    const before = line.slice(0, col);

    if (useNearestIndent) {
      // Only act inside leading whitespace; otherwise native Backspace is right.
      if (col > 0 && !/^\s*$/.test(before)) return false;
      if (col === 0) return false;
      const targetCol = nearestIndentColumn(doc, lineNo, col, tabSize);
      const target = charCountForColumn(line, targetCol, tabSize);
      if (target >= col) return false;
      collapses.push({ line: lineNo, start: target, end: col });
      continue;
    }

    const isWsOnlyLine = line.trim() === '';
    if (col === 0) {
      if (!(mode === 'toProper' && isWsOnlyLine)) return false;
    } else if (!/^\s*$/.test(before)) {
      return false;
    }

    if (mode === 'toTabstop') {
      const rem = col % tabSize;
      const target = rem === 0 ? col - tabSize : col - rem;
      if (target < 0 || target >= col) return false;
      collapses.push({ line: lineNo, start: target, end: col });
    } else if (mode === 'toUnindent') {
      let prevCol = 0;
      for (let l = lineNo - 1; l >= 0; l--) {
        const t = doc.lineAt(l).text;
        if (t.trim() !== '') {
          prevCol = indentColumn(t, tabSize);
          break;
        }
      }
      let target = charCountForColumn(line, prevCol, tabSize);
      if (target >= col) {
        const rem = col % tabSize;
        target = rem === 0 ? col - tabSize : col - rem;
      }
      if (target < 0) target = 0;
      if (target >= col) return false;
      collapses.push({ line: lineNo, start: target, end: col });
    } else if (mode === 'toProper') {
      if (lineNo === 0) {
        collapses.push({ line: lineNo, start: 0, end: col });
        continue;
      }
      const prevText = doc.lineAt(lineNo - 1).text;
      if (prevText.trim() !== '') {
        merges.push({
          line: lineNo,
          targetLine: lineNo - 1,
          deleteEnd: prevText.length,
          cursorPos: prevText.length,
        });
      } else {
        const currentIndentChars = charCountForColumn(line, indentColumn(line, tabSize), tabSize);
        merges.push({
          line: lineNo,
          targetLine: lineNo - 1,
          deleteEnd: prevText.length,
          cursorPos: currentIndentChars,
        });
      }
    }
  }

  if (collapses.length === 0 && merges.length === 0) return false;

  const originalLines = ed.selections.map((s) => s.active.line);

  await ed.edit((builder) => {
    for (const r of collapses) {
      builder.delete(new vscode.Range(r.line, r.start, r.line, r.end));
    }
    for (const m of merges) {
      const wsEnd = leadingWsEnd(ed.document.lineAt(m.line).text);
      builder.delete(
        new vscode.Range(
          new vscode.Position(m.targetLine, m.deleteEnd),
          new vscode.Position(m.line, wsEnd),
        ),
      );
      const targetText = ed.document.lineAt(m.targetLine).text;
      if (m.cursorPos > 0 && targetText.trim() === '' && m.cursorPos > targetText.length) {
        builder.insert(
          new vscode.Position(m.targetLine, m.deleteEnd),
          ' '.repeat(m.cursorPos - targetText.length),
        );
      }
    }
  });

  ed.selections = ed.selections.map((sel, k) => {
    const idx = originalLines[k];
    for (const r of collapses) {
      if (r.line === idx) {
        const p = new vscode.Position(r.line, r.start);
        return new vscode.Selection(p, p);
      }
    }
    for (const m of merges) {
      if (m.line === idx) {
        const p = new vscode.Position(m.targetLine, m.cursorPos);
        return new vscode.Selection(p, p);
      }
    }
    return sel;
  });
  return true;
}
