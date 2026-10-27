// SharpSense — Smart Brace Surround
//
// When the user types `{` with a selection OR on a single-line unbraced
// statement header (if/else/for/foreach/while), wraps the selection
// (or the rest of the line) in a multi-line brace block honoring braceStyle.
// The entire transformation is a single atomic edit (one undo step).
//
// These functions are called from brackets.ts `interceptType` when `{` is typed,
// so there is no second `type` command registration.

import * as vscode from 'vscode';
import { resolveBraceStyle, type SharpSenseSettings } from '../context';

// Control-flow keywords that introduce a condition block when followed by a line.
const CONTROL_KEYWORDS = new Set(['if', 'else', 'for', 'foreach', 'while', 'do', 'lock', 'using', 'switch']);

function isControlKeyword(line: string): boolean {
  const trimmed = line.trimStart();
  const m = trimmed.match(/^([A-Za-z_]\w*)/);
  if (!m) return false;
  return CONTROL_KEYWORDS.has(m[1]);
}

function stripLeadingTrivia(s: string): string {
  return s.replace(/^\s+/, '');
}

/**
 * Detect whether the current line (with cursor at `pos`) is a single-line
 * control-flow header without braces, e.g. `if (cond) return;` or `for (;;)`
 * at end of line.
 */
function detectHeaderWrapContext(
  editor: vscode.TextEditor,
  pos: vscode.Position,
): { headerPrefix: string; restOfLine: string; lineText: string; line: number } | null {
  const doc = editor.document;
  const line = doc.lineAt(pos.line);
  const lineText = line.text;
  const prefix = lineText.slice(0, pos.character);
  const suffix = lineText.slice(pos.character);

  // Only trigger when the suffix is empty or whitespace (typing `{` at end of line).
  if (stripLeadingTrivia(suffix).length > 0 && !/^\s*$/.test(suffix)) return null;

  const trimmedPrefix = prefix.trimEnd();

  // Must end with `)` or `do` keyword — i.e. the control condition just closed.
  if (!/\)$/.test(trimmedPrefix) && !/^do\s*$/.test(trimmedPrefix)) return null;

  // Must start with a control keyword.
  if (!isControlKeyword(trimmedPrefix)) return null;

  // Must NOT already have braces on this line.
  if (lineText.includes('{') || lineText.includes('}')) return null;

  return { headerPrefix: prefix, restOfLine: suffix, lineText, line: pos.line };
}

/**
 * Checks if the immediately preceding non-empty line is an unbraced control-flow
 * header (for/if/while/foreach/else/etc.) ending with `)` or `do` and no `{`.
 * Returns the line text if it is, or null if not.
 */
function detectParentControlHeader(lines: string[], currentLineIdx: number): string | null {
  let idx = currentLineIdx - 1;
  while (idx >= 0) {
    if (lines[idx].trim() === '') { idx--; continue; }
    break;
  }
  if (idx < 0) return null;
  const parentLine = lines[idx];
  if (!isControlKeyword(parentLine.trimStart())) return null;
  const trimmed = parentLine.trimEnd();
  if (/\)\s*$/.test(trimmed) || /^do\s*$/.test(trimmed)) {
    if (parentLine.includes('{') || parentLine.includes('}')) return null;
    let depth = 0;
    let hasOpen = false;
    for (const c of trimmed) {
      if (c === '(') { depth++; hasOpen = true; }
      else if (c === ')') depth--;
    }
    if (!hasOpen || depth !== 0) return null;
    return parentLine;
  }
  return null;
}

/**
 * Smart braces on a control-flow header line (no selection).
 *
 * Defers to native `{}` insertion for bare header lines (`for (...)`, `if (cond)`)
 * and headers with trailing statements (`if (cond) return;`). The full multi-line
 * block expansion is triggered by Smart Enter when the user presses Enter inside
 * the empty braces.
 *
 * Still handles the "orphan block" case: typing `{` on a simple statement line
 * that sits directly below an unbraced control-flow header merges the block
 * to the parent header instead of creating a standalone orphan.
 */
export async function trySmartBraceSurround(
  editor: vscode.TextEditor,
  getSettings: () => SharpSenseSettings,
): Promise<boolean> {
  const s = getSettings();
  if (!s.smartSurroundWithBraces) return false;

  const doc = editor.document;
  const pos = editor.selection.active;
  if (!editor.selection.isEmpty) return false;

  if (doc.languageId !== 'csharp') return false;

  const ctx = detectHeaderWrapContext(editor, pos);

  // When `{` is typed on a control-flow header line, defer to native behavior
  // (insert `{}`, cursor inside braces). Smart Enter handles full block expansion.
  if (ctx) return false;

  // Orphan block case: typing `{` on a simple statement line that sits below
  // an unbraced control-flow header. Merge the block to the parent header.
  if (!ctx) {
    const docLines = doc.getText().split('\n');
    const parentHeader = detectParentControlHeader(docLines, pos.line);
    if (!parentHeader) return false;

    // The current line (already fetched above) holds the statement to wrap (may be empty).
    const statementLine = doc.lineAt(pos.line);
    const isEmptyLine = statementLine.text.trim() === '';

    // Find which line the parent header is on.
    let parentLineIdx = pos.line - 1;
    while (parentLineIdx >= 0 && docLines[parentLineIdx].trim() === '') {
      parentLineIdx--;
    }
    if (parentLineIdx < 0) return false;

    const resolved = resolveBraceStyle(s.braceStyle, doc.getText());
    const tabSize = vscode.workspace.getConfiguration('editor').get<number>('tabSize', 4) || 4;
    const headerIndent = parentHeader.slice(0, parentHeader.length - parentHeader.trimStart().length);
    const innerIndent = headerIndent + ' '.repeat(tabSize);

    const statementText = statementLine.text.trim();

  
  await editor.edit((builder) => {
      if (isEmptyLine) {
        // Empty body: create an empty block aligned with the header (no rogue indented {}).
        if (resolved === 'k&r') {
          // for (...) {  → append to header line
          builder.replace(
            new vscode.Range(parentLineIdx, parentHeader.length, parentLineIdx, parentHeader.length),
            ' {',
          );
          builder.replace(
            new vscode.Range(pos.line, 0, pos.line, statementLine.text.length),
            innerIndent,
          );
          builder.insert(new vscode.Position(pos.line + 1, 0), headerIndent + '}');
        } else {
          // Allman: for (...)\n  {\n  (cursor)\n  }
          builder.insert(new vscode.Position(parentLineIdx, parentHeader.length), '\n' + headerIndent + '{');
          builder.replace(
            new vscode.Range(pos.line, 0, pos.line, statementLine.text.length),
            innerIndent,
          );
          builder.insert(new vscode.Position(pos.line + 1, 0), headerIndent + '}');
        }
      } else {
        if (resolved === 'k&r') {
          // for (cond) {  → append to header line
          builder.replace(
            new vscode.Range(parentLineIdx, parentHeader.length, parentLineIdx, parentHeader.length),
            ' {',
          );
          // statement;  → indented
          builder.replace(
            new vscode.Range(pos.line, 0, pos.line, statementLine.text.length),
            innerIndent + statementText,
          );
          // closing brace on the line after the statement
          builder.insert(new vscode.Position(pos.line + 1, 0), headerIndent + '}');
        } else {
          // Allman: for (cond)\n{\n    statement;\n}
          // Append nothing to parent header; insert `{\n` after it.
          builder.insert(new vscode.Position(parentLineIdx, parentHeader.length), '\n' + headerIndent + '{');
          // Indent the statement
          builder.replace(
            new vscode.Range(pos.line, 0, pos.line, statementLine.text.length),
            innerIndent + statementText,
          );
          builder.insert(new vscode.Position(pos.line + 1, 0), headerIndent + '}');
        }
      }
    });

    // Position cursor inside the block. In Allman style an extra brace line is
    // inserted above the body, shifting it down by one line.
    const cursorLine = resolved === 'allman' ? pos.line + 1 : pos.line;
    const cursorCol = isEmptyLine ? innerIndent.length : (innerIndent.length + statementText.length);
    const afterStmtPos = new vscode.Position(cursorLine, cursorCol);
    editor.selection = new vscode.Selection(afterStmtPos, afterStmtPos);
    return true;
  }

  // Header lines (for/if/while/...) defer to native `{}` insertion.
  // Smart Enter handles the full block expansion when Enter is pressed inside the braces.
  return false;
}

/**
 * Wrap selected text in a brace block. Called when `{` is typed with a selection.
 * Returns true if handled.
 */
export async function trySmartBraceSurroundSelection(
  editor: vscode.TextEditor,
  getSettings: () => SharpSenseSettings,
): Promise<boolean> {
  const s = getSettings();
  if (!s.smartSurroundWithBraces) return false;

  const doc = editor.document;
  if (doc.languageId !== 'csharp') return false;

  const sel = editor.selection;
  if (sel.isEmpty) return false;

  try {

  // If the selection starts after leading whitespace on its first line, expand
  // the replaced range to the start of that line so the original indentation is
  // consumed instead of being stacked on top of the re-indented body.
  const startLine = doc.lineAt(sel.start.line);
  const prefixBeforeSel = startLine.text.slice(0, sel.start.character);
  const replaceSel = (prefixBeforeSel.trim() === '')
    ? new vscode.Range(new vscode.Position(sel.start.line, 0), sel.end)
    : sel;
  const selectionText = doc.getText(replaceSel);

  const resolved = resolveBraceStyle(s.braceStyle, doc.getText());
  const tabSize = vscode.workspace.getConfiguration('editor').get<number>('tabSize', 4) || 4;

  // Determine the brace indent level: if the selection sits under an unbraced
  // control-flow header (e.g. statement below `for (...)`), braces align with
  // the header, not the statement's own indentation.
  const docLines = doc.getText().split('\n');
  const parentHeader = detectParentControlHeader(docLines, sel.start.line);
  const statementIndent = startLine.text.slice(0, startLine.firstNonWhitespaceCharacterIndex);

  let braceIndent: string;
  if (parentHeader !== null) {
    // Align { } with the parent header line's indentation.
    braceIndent = parentHeader.slice(0, parentHeader.length - parentHeader.trimStart().length);
  } else {
    braceIndent = statementIndent;
  }
  const innerIndent = braceIndent + ' '.repeat(tabSize);

  const lines = selectionText.split('\n');
  const indentedText = lines.map((ln) => {
    if (ln.trim() === '') return '';
    return innerIndent + ln.trimStart();
  }).join('\n');

  // Find the parent header line index for brace attachment (K&R) or brace alignment (Allman).
  let parentLineIdx = sel.start.line - 1;
  while (parentLineIdx >= 0 && docLines[parentLineIdx].trim() === '') {
    parentLineIdx--;
  }

  const editApplied = await editor.edit((builder) => {
    if (resolved === 'k&r') {
      if (parentHeader !== null) {
        // Parent header exists: append ` {` to header line, replace selection with indented body + closing brace.
        const headerFullLine = docLines[parentLineIdx];
        builder.replace(
          new vscode.Range(parentLineIdx, headerFullLine.length, parentLineIdx, headerFullLine.length),
          ' {',
        );
        builder.replace(replaceSel, indentedText + '\n' + braceIndent + '}');
      } else {
        // No parent header: K&R inline — { at selection start.
        builder.replace(replaceSel, '{\n' + indentedText + '\n' + braceIndent + '}');
      }
    } else {
      if (parentHeader !== null) {
        // Allman: insert `{` on newline after header, aligned with header.
        const headerFullLine = docLines[parentLineIdx];
        builder.replace(
          new vscode.Range(parentLineIdx, headerFullLine.length, parentLineIdx, headerFullLine.length),
          '\n' + braceIndent + '{',
        );
        builder.replace(replaceSel, indentedText + '\n' + braceIndent + '}');
      } else {
        builder.replace(replaceSel, '\n' + braceIndent + '{\n' + indentedText + '\n' + braceIndent + '}');
      }
    }
  });
  if (!editApplied) return false;

  // Position cursor inside the block.
  const cursorLine = resolved === 'k&r'
    ? sel.start.line + (parentHeader !== null ? 0 : 1)
    : sel.start.line + (parentHeader !== null ? 1 : 2);
  editor.selection = new vscode.Selection(
    new vscode.Position(cursorLine, innerIndent.length),
    new vscode.Position(cursorLine, innerIndent.length),
  );

  return true;
  } catch (e) {
    return false;
  }
}
