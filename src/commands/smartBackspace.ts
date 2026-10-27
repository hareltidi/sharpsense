// SharpSense — Smart Backspace: interior-whitespace collapse + smart unindent.
// Interior: cursor in `(   |   )` -> first Backspace collapses to `(|)`;
//           then existing pair-delete removes `()`.
// Unindent: backspacing inside leading whitespace collapses to previous tabstop
// (toTabstop), previous non-blank line's indent (toUnindent), deletes the line
// and joins to previous line keeping the correct indentation (toProper), or
// default backspace (none).

import * as vscode from 'vscode';
import type { SharpSenseSettings } from '../context';

const PAIRS: Record<string, string> = { '(': ')', '{': '}', '[': ']', '<': '>' };

export async function tryCollapseInteriorWhitespace(
  ed: vscode.TextEditor,
): Promise<boolean> {
  for (const sel of ed.selections) {
    if (!sel.isEmpty) return false;
  }
  const edits: { start: number; end: number }[] = [];
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
    const leftSpaces = pos - i;
    const rightSpaces = j - pos;
    if (leftSpaces + rightSpaces === 0) return false; // empty pair handled elsewhere
    edits.push({ start: i, end: j }); // delete spaces between opener and closer (exclusive of both)
  }
  await ed.edit((builder) => {
    for (let k = 0; k < ed.selections.length; k++) {
      const sel = ed.selections[k];
      const e = edits[k];
      builder.delete(new vscode.Range(sel.active.line, e.start, sel.active.line, e.end));
    }
  });
  ed.selections = ed.selections.map((sel, k) => {
    const e = edits[k];
    const p = new vscode.Position(sel.active.line, e.start + 1);
    return new vscode.Selection(p, p);
  });
  return true;
}

/** Get indentation in actual character columns for setting cursor position. */
export function getIndentationColumn(line: string, tabSize: number): number {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') col += 1;
    else if (c === '\t') col += tabSize - (col % tabSize);
    else break;
  }
  return col;
}

/** Convert a visual column position back to character count (for mixed tabs/spaces). */
export function charColumnToCount(line: string, targetCol: number, tabSize: number): number {
  let col = 0;
  let i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') col += 1;
    else if (c === '\t') col += tabSize - (col % tabSize);
    else break;
    if (col >= targetCol) return i + 1;
  }
  return col >= targetCol ? i : i;
}

export async function trySmartUnindent(
  ed: vscode.TextEditor,
  mode: string,
): Promise<boolean> {
  if (mode === 'none') return false;
  const tabSize = vscode.workspace.getConfiguration('editor').get<number>('tabSize', 4) || 4;
  for (const sel of ed.selections) {
    if (!sel.isEmpty) return false;
  }
  let any = false;
  const tabstopCollapses: { line: number; start: number; end: number }[] = [];
  const unindentCollapses: { line: number; start: number; end: number }[] = [];
  const properMerges: { line: number; targetLine: number; deleteEnd: number; cursorPos: number }[] = [];
  for (const sel of ed.selections) {
    const doc = ed.document;
    const line = doc.lineAt(sel.active.line).text;
    const col = sel.active.character;
    const lineText = line.slice(0, col);
    // Must be inside leading whitespace (all whitespace before cursor).
    // For toProper on a whitespace-only line at col 0, we still want to proceed
    // (the line gets deleted entirely).
    const isWsOnlyLine = doc.lineAt(sel.active.line).text.trim() === '';
    if (col === 0 && (!(mode === 'toProper' && isWsOnlyLine) || !isWsOnlyLine)) return false;
    if (col > 0 && !/^\s*$/.test(lineText)) return false;

    if (mode === 'toTabstop') {
      // Collapse to previous tab stop. Cursor stays on the same line.
      // e.g. indentation of 8 -> col 4, indentation of 4 -> col 0.
      const rem = col % tabSize;
      const target = rem === 0 ? col - tabSize : col - rem;
      if (target < 0 || target >= col) return false;
      tabstopCollapses.push({ line: sel.active.line, start: target, end: col });
      any = true;
    } else if (mode === 'toUnindent') {
      // Collapse to previous non-blank line's indentation. Cursor stays on same line.
      let prevIndentCol = 0;
      for (let l = sel.active.line - 1; l >= 0; l--) {
        const t = doc.lineAt(l).text;
        if (t.trim() !== '') { prevIndentCol = getIndentationColumn(t, tabSize); break; }
      }
      // Convert column back to character count (approximate for spaces).
      let target = 0;
      let currentCol = 0;
      for (let i = 0; i < col; i++) {
        const c = line[i];
        if (c === ' ') currentCol += 1;
        else if (c === '\t') currentCol += tabSize - (currentCol % tabSize);
        else break;
        if (currentCol >= prevIndentCol) { target = i + 1; break; }
      }
      if (target >= col) {
        // Previous line indent is at or beyond current — fall back to tabstop.
        const rem = col % tabSize;
        target = rem === 0 ? col - tabSize : col - rem;
      }
      if (target < 0) target = 0;
      if (target >= col) return false;
      unindentCollapses.push({ line: sel.active.line, start: target, end: col });
      any = true;
    } else if (mode === 'toProper') {
      // Delete the whitespace-only line. Cursor jumps to the previous line
      // at the correct indentation:
      //   - If the previous line has content: cursor goes to end of that content.
      //   - If the previous line is also whitespace-only: cursor goes to the
      //     previous line at the indentation of the deleted line (keeping col).
      if (sel.active.line === 0) {
        // At first line — just collapse to col 0 (no previous line to join).
        tabstopCollapses.push({ line: sel.active.line, start: 0, end: col });
        any = true;
      } else {
        const prevLine = doc.lineAt(sel.active.line - 1);
        if (prevLine.text.trim() !== '') {
          // Previous line has content — merge and go to end of its content.
          const contentEnd = prevLine.text.length;
          properMerges.push({
            line: sel.active.line,
            targetLine: sel.active.line - 1,
            deleteEnd: contentEnd,
            cursorPos: contentEnd,
          });
          any = true;
        } else {
          // Previous line is also whitespace-only — delete this line and
          // position cursor on the previous line at the indentation of
          // the line we were on (this line).
          // Delete from end of prev line (full length, all whitespace) through
          // this line's leading whitespace. Cursor goes to this line's indent.
          const currentIndent = getIndentationColumn(line, tabSize);
          const currentIndentChars = charColumnToCount(line, currentIndent, tabSize);
          properMerges.push({
            line: sel.active.line,
            targetLine: sel.active.line - 1,
            deleteEnd: prevLine.text.length,
            cursorPos: currentIndentChars,
          });
          any = true;
        }
      }
    }
  }
  if (!any) return false;
  // Snapshot original selection lines before the edit — VS Code shifts selections
  // after multi-line deletes, so matching by post-edit sel.active.line fails.
  const originalLines = ed.selections.map((s) => s.active.line);
  await ed.edit((builder) => {
    // Tabstop collapses (toTabstop and first-line toProper).
    for (const r of tabstopCollapses) {
      builder.delete(new vscode.Range(r.line, r.start, r.line, r.end));
    }
    // Unindent collapses (toUnindent).
    for (const r of unindentCollapses) {
      builder.delete(new vscode.Range(r.line, r.start, r.line, r.end));
    }
    // Proper merges: delete the whitespace-only line + newline, and optionally
  // insert the deleted line's indentation on the previous line so the cursor
    // has actual content to land on (VS Code doesn't render virtual cursor
    // positions beyond an empty line's length).
    for (const m of properMerges) {
      const wsEnd = colOfLeadingWhitespace(ed.document, m.line);
      builder.delete(new vscode.Range(
        new vscode.Position(m.targetLine, m.deleteEnd),
        new vscode.Position(m.line, wsEnd),
      ));
      // If the target line is empty or whitespace-only, insert the deleted
      // line's indentation so the cursor lands on real content.
      const targetText = ed.document.lineAt(m.targetLine).text;
      if (m.cursorPos > 0 && targetText.trim() === '' && m.cursorPos > targetText.length) {
        const indent = ' '.repeat(m.cursorPos - targetText.length);
        builder.insert(new vscode.Position(m.targetLine, m.deleteEnd), indent);
      }
    }
  });
  // Set cursor positions using original (pre-edit) line numbers for matching.
  ed.selections = ed.selections.map((sel, k) => {
    const lineIdx = originalLines[k];
    for (const r of tabstopCollapses) {
      if (r.line === lineIdx) {
        const p = new vscode.Position(r.line, r.start);
        return new vscode.Selection(p, p);
      }
    }
    for (const r of unindentCollapses) {
      if (r.line === lineIdx) {
        const p = new vscode.Position(r.line, r.start);
        return new vscode.Selection(p, p);
      }
    }
    for (const m of properMerges) {
      if (m.line === lineIdx) {
        // Cursor goes to cursorPos on the previous (merged) line.
        const p = new vscode.Position(m.targetLine, m.cursorPos);
        return new vscode.Selection(p, p);
      }
    }
    return sel;
  });
  return true;
}

/** Count leading whitespace characters (spaces + tabs) on a line. */
function colOfLeadingWhitespace(doc: vscode.TextDocument, line: number): number {
  const text = doc.lineAt(line).text;
  let i = 0;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

export function registerSmartBackspace(
  _context: vscode.ExtensionContext,
  _output: vscode.OutputChannel,
  _getSettings: () => SharpSenseSettings,
): void {
  // Behavior is invoked from brackets.ts interceptDeleteLeft; nothing to register here.
}
