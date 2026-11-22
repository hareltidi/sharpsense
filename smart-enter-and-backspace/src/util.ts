import * as vscode from 'vscode';

/** Editor tab size for the given document. */
export function getTabSize(doc: vscode.TextDocument): number {
  const cfg = vscode.workspace.getConfiguration('editor', doc);
  const n = cfg.get<number>('tabSize', 4);
  return typeof n === 'number' && n > 0 ? n : 4;
}

/** One indentation unit: a tab when insertSpaces is off, otherwise tabSize spaces. */
export function getIndentUnit(doc: vscode.TextDocument): string {
  const cfg = vscode.workspace.getConfiguration('editor', doc);
  const insertSpaces = cfg.get<boolean>('insertSpaces', true);
  return insertSpaces === false ? '\t' : ' '.repeat(getTabSize(doc));
}

/** Leading whitespace of a line. */
export function leadingIndent(text: string): string {
  return text.slice(0, text.length - text.trimStart().length);
}

/** Strip leading whitespace and comments so syntactic lookaheads ignore trivia. */
export function stripLeadingTrivia(s: string): string {
  return s.replace(/^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*)+/, '');
}

/** Bounded document sample for brace-style inference — avoids copying large files. */
export function sampleText(doc: vscode.TextDocument, lineBudget = 400): string {
  const end = Math.min(doc.lineCount, lineBudget);
  return doc.getText(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(end, 0)));
}

/** Strip leading attribute lists / annotations (`[Attr]`, `@Anno(...)`). */
export function stripAttributeTrivia(s: string): string {
  return s
    .replace(/^\s*(?:\[[^\]]*\]\s*)*/, '')
    .replace(/^\s*(?:@[A-Za-z_][\w.]*(?:\s*\([^()]*\))?\s*)*/, '');
}
