// Smart Brace Surround — language-agnostic, braced languages only.
//
// Typing `{` with a selection wraps the selection in a brace block honoring the
// resolved brace style. Typing `{` on a statement line that sits under an
// unbraced control header merges the block into that header instead of leaving
// an orphan. Indentation-based and generic languages never reach this module.

import * as vscode from 'vscode';
import type { Settings } from './settings';
import { resolveBraceStyle } from './settings';
import type { LanguageProfile } from './languages';
import { getIndentUnit, leadingIndent, sampleText, stripLeadingTrivia } from './util';

const CONTROL_KEYWORDS = new Set([
  'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'try', 'catch',
  'finally', 'lock', 'using', 'with', 'loop', 'match', 'when', 'unsafe',
]);

function isControlHeaderLine(text: string): boolean {
  const m = text.trimStart().match(/^([A-Za-z_]\w*)/);
  return m !== null && CONTROL_KEYWORDS.has(m[1]);
}

function detectHeaderWrapContext(
  editor: vscode.TextEditor,
  pos: vscode.Position,
): boolean {
  const lineText = editor.document.lineAt(pos.line).text;
  const prefix = lineText.slice(0, pos.character);
  const suffix = lineText.slice(pos.character);
  if (stripLeadingTrivia(suffix).length > 0) return false;
  const trimmedPrefix = prefix.trimEnd();
  if (!/\)$/.test(trimmedPrefix) && !/^do\s*$/.test(trimmedPrefix)) return false;
  if (!isControlHeaderLine(trimmedPrefix)) return false;
  return !(lineText.includes('{') || lineText.includes('}'));
}

function detectParentControlHeader(
  lines: string[],
  currentLineIdx: number,
): string | null {
  let idx = currentLineIdx - 1;
  while (idx >= 0 && lines[idx].trim() === '') idx--;
  if (idx < 0) return null;
  const parent = lines[idx];
  if (!isControlHeaderLine(parent)) return null;
  const trimmed = parent.trimEnd();
  if (!(/\)\s*$/.test(trimmed) || /^do\s*$/.test(trimmed))) return null;
  if (parent.includes('{') || parent.includes('}')) return null;
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
  return hasOpen && depth === 0 ? parent : null;
}

export async function trySmartBraceSurround(
  editor: vscode.TextEditor,
  settings: Settings,
  profile: LanguageProfile,
): Promise<boolean> {
  if (!settings.smartSurroundWithBraces) return false;
  if (profile.family !== 'braced') return false;
  if (!editor.selection.isEmpty) return false;

  const doc = editor.document;
  const pos = editor.selection.active;

  // Header lines defer to native `{}`; Smart Enter expands them later.
  if (detectHeaderWrapContext(editor, pos)) return false;

  const docLines = doc.getText().split('\n');
  const parentHeader = detectParentControlHeader(docLines, pos.line);
  if (!parentHeader) return false;

  const statementLine = doc.lineAt(pos.line);
  const statementText = statementLine.text.trim();

  let parentLineIdx = pos.line - 1;
  while (parentLineIdx >= 0 && docLines[parentLineIdx].trim() === '') parentLineIdx--;
  if (parentLineIdx < 0) return false;

  const resolved = resolveBraceStyle(settings.braceStyle, sampleText(doc));
  const headerIndent = leadingIndent(parentHeader);
  const innerIndent = headerIndent + getIndentUnit(doc);

  await editor.edit((builder) => {
    const headerEnd = new vscode.Range(
      parentLineIdx,
      parentHeader.length,
      parentLineIdx,
      parentHeader.length,
    );
    if (resolved === 'k&r') {
      builder.replace(headerEnd, ' {');
    } else {
      builder.replace(headerEnd, '\n' + headerIndent + '{');
    }
    builder.replace(
      new vscode.Range(pos.line, 0, pos.line, statementLine.text.length),
      innerIndent + statementText,
    );
    builder.insert(new vscode.Position(pos.line + 1, 0), headerIndent + '}');
  });

  const cursorLine = resolved === 'allman' ? pos.line + 1 : pos.line;
  const cursorCol = innerIndent.length + statementText.length;
  editor.selection = new vscode.Selection(
    new vscode.Position(cursorLine, cursorCol),
    new vscode.Position(cursorLine, cursorCol),
  );
  return true;
}

export async function trySmartBraceSurroundSelection(
  editor: vscode.TextEditor,
  settings: Settings,
  profile: LanguageProfile,
): Promise<boolean> {
  if (!settings.smartSurroundWithBraces) return false;
  if (profile.family !== 'braced') return false;

  const doc = editor.document;
  const sel = editor.selection;
  if (sel.isEmpty) return false;

  const startLine = doc.lineAt(sel.start.line);
  const prefixBeforeSel = startLine.text.slice(0, sel.start.character);
  const replaceSel =
    prefixBeforeSel.trim() === ''
      ? new vscode.Range(new vscode.Position(sel.start.line, 0), sel.end)
      : sel;
  const selectionText = doc.getText(replaceSel);

  const resolved = resolveBraceStyle(settings.braceStyle, sampleText(doc));
  const docLines = doc.getText().split('\n');
  const parentHeader = detectParentControlHeader(docLines, sel.start.line);
  const statementIndent = leadingIndent(startLine.text);

  const braceIndent = parentHeader !== null ? leadingIndent(parentHeader) : statementIndent;
  const innerIndent = braceIndent + getIndentUnit(doc);

  const indentedText = selectionText
    .split('\n')
    .map((ln) => (ln.trim() === '' ? '' : innerIndent + ln.trimStart()))
    .join('\n');

  let parentLineIdx = sel.start.line - 1;
  while (parentLineIdx >= 0 && docLines[parentLineIdx].trim() === '') parentLineIdx--;

  const applied = await editor.edit((builder) => {
    if (resolved === 'k&r') {
      if (parentHeader !== null) {
        const headerFullLine = docLines[parentLineIdx];
        builder.replace(
          new vscode.Range(parentLineIdx, headerFullLine.length, parentLineIdx, headerFullLine.length),
          ' {',
        );
        builder.replace(replaceSel, indentedText + '\n' + braceIndent + '}');
      } else {
        builder.replace(replaceSel, '{\n' + indentedText + '\n' + braceIndent + '}');
      }
    } else if (parentHeader !== null) {
      const headerFullLine = docLines[parentLineIdx];
      builder.replace(
        new vscode.Range(parentLineIdx, headerFullLine.length, parentLineIdx, headerFullLine.length),
        '\n' + braceIndent + '{',
      );
      builder.replace(replaceSel, indentedText + '\n' + braceIndent + '}');
    } else {
      builder.replace(replaceSel, '\n' + braceIndent + '{\n' + indentedText + '\n' + braceIndent + '}');
    }
  });
  if (!applied) return false;

  const cursorLine =
    resolved === 'k&r'
      ? sel.start.line + (parentHeader !== null ? 0 : 1)
      : sel.start.line + (parentHeader !== null ? 1 : 2);
  editor.selection = new vscode.Selection(
    new vscode.Position(cursorLine, innerIndent.length),
    new vscode.Position(cursorLine, innerIndent.length),
  );
  return true;
}
