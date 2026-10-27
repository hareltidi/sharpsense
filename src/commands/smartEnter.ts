// SharpSense — Smart Enter: brace expansion, method-header brace expansion
// (Option B: don't duplicate if `{` already exists), and semicolon insertion
// for unclosed statements.

import * as vscode from 'vscode';
import { resolveBraceStyle, detectInvokeContext, stripAttributeTrivia, stripLeadingTrivia, MODIFIERS, collapseGenericArgs, type SharpSenseSettings } from '../context';

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
 * True when the cursor sits at the end of a complete method/constructor/operator
 * header line, e.g. `void Foo()` or `public Foo(string x)` — the cursor is past
 * the closing `)` and nothing meaningful follows on the line except trivia.
 * Does NOT require `{` to be absent — the caller checks Option B.
 */
function isMethodHeader(prefix: string, suffix: string): boolean {
  const strippedSuffix = stripLeadingTrivia(suffix);
  // Allow only empty suffix, `{`, `;`, or `)` (e.g. `void Foo();`) after the header
  if (strippedSuffix.length > 0 && !/^(?:\{|;|\))/.test(strippedSuffix)) return false;
  // Must end with a closing paren of the signature
  if (!/\)\s*$/.test(prefix)) return false;
  // Must have balanced parens (all `(` closed)
  let depth = 0;
  let hasOpen = false;
  for (const c of prefix) {
    if (c === '(') { depth++; hasOpen = true; }
    else if (c === ')') depth--;
  }
  if (!hasOpen || depth !== 0) return false;
  // The text before the last `)` must look like a declaration head:
  // `Type MemberName(...)` or `ConstructorName(...)`, or a bare constructor
  // name after modifiers. We find the matching `(` for the last `)` and check
  // the identifier just before that `(`.
  const strippedPrefix = stripAttributeTrivia(stripLeadingTrivia(prefix));
  // Exclude control-flow keywords — `for`, `while`, `if`, etc. are NOT method headers.
  // Without this, `for (...)` matches the bare-constructor pattern (`Foo()`),
  // causing section 2 to fire instead of section 3 (control header).
  const firstWord = strippedPrefix.match(/^([A-Za-z_]\w*)/);
  if (firstWord && CONTROL_KEYWORDS.has(firstWord[1])) return false;
  // Find the opening `(` matching the last `)` — scan backward.
  // Each `)` increments; each `(` that brings depth from 1→0 is the opener.
  let scanDepth = 0;
  let openParenIdx = -1;
  for (let i = strippedPrefix.length - 1; i >= 0; i--) {
    if (strippedPrefix[i] === ')') {
      scanDepth++;
    } else if (strippedPrefix[i] === '(') {
      if (scanDepth === 0) { /* unmatched opening paren */ break; }
      scanDepth--;
      if (scanDepth === 0) { openParenIdx = i; break; }
    }
  }
  if (openParenIdx < 0) return false;
  // Everything before the opening `(` — should be `Type MemberName` or modifiers+Type MemberName
  const beforeParams = strippedPrefix.slice(0, openParenIdx);
  const beforeParamsTrimmed = beforeParams.trimEnd();
  if (beforeParamsTrimmed.length === 0) return false;
  // `beforeParamsTrimmed` should end with the member name (identifier, possibly <>),
  // preceded by an optional return type and/or modifiers.
  // Try: `Type MemberName` or `modifiers Type MemberName`
  const nameMatch = beforeParamsTrimmed.match(/^(.*?)\s+([\w<>]+(?:\s*<[^<>]*>)?)\s*$/);
  if (!nameMatch) {
    // No space — just a bare identifier (implicit constructor like `Foo()`).
    if (beforeParamsTrimmed.match(/^[\w<>]+(?:\s*<[^<>]*>)?$/)) return true;
    return false;
  }
  const rest = nameMatch[1];
  const memberNamePart = nameMatch[2];
  if (rest.length === 0) return true; // implicit ctor like `Foo()`
  // Check it's a type keyword or PascalCase identifier ending, or modifiers + type
  const restCollapsed = collapseGenericArgs(rest);
  // Type pattern: `Type`, `Type.Type`, `Type<int>`, `Type?`, `Type[]` etc.
  // Modifiers pattern: `private void`, `public async Task`, etc.
  const typePattern = /^(?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*(?:<>|\[\])*\??$/i;
  // First try: rest is just a type (e.g. `void`, `int`, `string`, `Task<int>`)
  if (typePattern.test(restCollapsed)) return true;
  // Then try: rest starts with modifiers, followed by a type
  const modMatch = restCollapsed.match(new RegExp(`^(?:${MODIFIERS}\\s+)+(.+)$`, 'i'));
  if (modMatch && typePattern.test(modMatch[1].trim())) return true;
  return false;
}

/**
 * True when the cursor is at the end of a control-flow header line — the line
 * starts with `if`, `else`, `for`, `foreach`, `while`, `do`, `switch`, `lock`,
 * or `using` and ends with `)` or `do` (with nothing meaningful after).
 * Does NOT fire if braces already exist on the line.
 */
const CONTROL_KEYWORDS = new Set(['if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'lock', 'using']);

function isControlHeader(prefix: string, suffix: string): boolean {
  const strippedSuffix = stripLeadingTrivia(suffix);
  // Allow only empty suffix or `{` after the header
  if (strippedSuffix.length > 0 && !/^(?:\{)/.test(strippedSuffix)) return false;

  const trimmedPrefix = prefix.trimEnd();
  // Must not already have braces
  if (prefix.includes('{') || prefix.includes('}')) return false;

  // Check for `do` keyword (no parens)
  if (/^do\s*$/.test(trimmedPrefix)) return true;

  // Must end with `)` (the closing paren of the condition)
  if (!/\)\s*$/.test(trimmedPrefix)) return false;

  // Must start with a control keyword
  const strippedPrefix = stripAttributeTrivia(stripLeadingTrivia(prefix));
  const kwMatch = strippedPrefix.match(/^([A-Za-z_]\w*)/);
  if (!kwMatch) return false;
  if (!CONTROL_KEYWORDS.has(kwMatch[1])) return false;

  // Parens must be balanced
  let depth = 0;
  let hasOpen = false;
  for (const c of trimmedPrefix) {
    if (c === '(') { depth++; hasOpen = true; }
    else if (c === ')') depth--;
  }
  if (!hasOpen || depth !== 0) return false;

  return true;
}

/**
 * True when the current line is an unclosed statement that should get a
 * semicolon on Enter — e.g. `var x = GetUsers` or `DoSomething()`.
 * Does NOT fire on declaration lines (class, method, property) or lines that
 * already end with `{`, `;`, `}`, or `)`.
 */
function isUnclosedStatement(prefix: string, suffix: string): boolean {
  const codeSuffix = stripLeadingTrivia(suffix);
  if (codeSuffix.startsWith('{')) return false;
  if (codeSuffix.startsWith(';')) return false;
  if (codeSuffix.startsWith('}')) return false;
  const codePrefix = stripAttributeTrivia(stripLeadingTrivia(prefix));
  if (codePrefix.length === 0) return false;
  const ctx = detectInvokeContext(prefix, suffix);
  if (ctx.kind === 'definition' || ctx.kind === 'unity-message-definition') return false;
  // Don't add semicolons to method definition headers (detectInvokeContext returns
  // 'other' for method headers ending in `)`, so check explicitly).
  if (isMethodHeader(prefix, suffix)) return false;
  const trimmedPrefix = prefix.replace(/\s+$/, '');
  if (!/[)\]"\d\w]$/.test(trimmedPrefix)) return false;
  const clean = codePrefix.replace(/\/\/.*$/, '');
  if (clean.trim() === '' || clean.trim() === '{') return false;
  return true;
}

export async function trySmartEnter(
  ed: vscode.TextEditor,
  braceStyle: SharpSenseSettings['braceStyle'],
): Promise<boolean> {
  const sel = ed.selections[0];
  if (!sel.isEmpty) return false;
  const doc = ed.document;
  const line = doc.lineAt(sel.active.line);
  const prefix = line.text.slice(0, sel.active.character);
  const suffix = line.text.slice(sel.active.character);

  // 1. {|} brace expansion — respects brace style for Allman (move { to its own line)
  const r = detectBraceAt(ed, sel);
  if (r) {
    const resolved = resolveBraceStyle(braceStyle, doc.getText());
    const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
    const tabSize = vscode.workspace.getConfiguration('editor').get<number>('tabSize', 4) || 4;
    const innerIndent = indent + ' '.repeat(tabSize);
    const innerContent = innerIndent + '\n';
    if (resolved === 'k&r') {
      // K&R: { stays on the signature line, } on its own line indented back
      const block = '{\n' + innerContent + indent + '}';
      const range = new vscode.Range(
        new vscode.Position(r.openLine, r.openCol),
        new vscode.Position(r.openLine, r.closeCol + 1),
      );
      await ed.edit((b) => b.replace(range, block));
      const p = new vscode.Position(r.openLine + 1, innerIndent.length);
      ed.selections = [new vscode.Selection(p, p)];
      return true;
    } else {
      // Allman: { moves to its own line, } matches the { line's indent
      const block = '\n' + indent + '{\n' + innerContent + indent + '}';
      const range = new vscode.Range(
        new vscode.Position(r.openLine, r.openCol),
        new vscode.Position(r.openLine, r.closeCol + 1),
      );
      await ed.edit((b) => b.replace(range, block));
      // Cursor goes on the line after {, indented by one tabstop
      const cursorLine = r.openLine + 2;
      ed.selections = [new vscode.Selection(new vscode.Position(cursorLine, innerIndent.length), new vscode.Position(cursorLine, innerIndent.length))];
      return true;
    }
  }

  // 2. Method header brace expansion (Option B)
  //    `void Foo()|` → expand with { on next/same line per braceStyle
  //    `void Foo() {|}` → just indent next line (don't duplicate brace)
  const codeSuffixStr = stripLeadingTrivia(suffix);
  const hasBraceOnLine = codeSuffixStr.startsWith('{');

  if (isMethodHeader(prefix, suffix)) {
    const resolved = resolveBraceStyle(braceStyle, doc.getText());

    if (hasBraceOnLine) {
      // Option B: { already exists, just open a new line and indent
      const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
      const tabSize = vscode.workspace.getConfiguration('editor').get<number>('tabSize', 4) || 4;
      const newIndent = indent + ' '.repeat(tabSize);
      await ed.edit((b) => {
        b.insert(new vscode.Position(line.lineNumber, line.text.length), '\n');
      });
      const newPos = new vscode.Position(line.lineNumber + 1, newIndent.length);
      ed.selections = [new vscode.Selection(newPos, newPos)];
      return true;
    }

    // No brace yet — insert the block
    const nextLine = line.lineNumber + 1;
    const existingIndent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
    const indentSize = vscode.workspace.getConfiguration('editor').get<number>('tabSize', 4) || 4;
    const innerIndent = existingIndent + ' '.repeat(indentSize);

    await ed.edit((b) => {
      if (resolved === 'k&r') {
        b.insert(new vscode.Position(line.lineNumber, line.text.length), ' {\n');
      } else {
        b.insert(new vscode.Position(line.lineNumber, line.text.length), '\n');
        b.insert(new vscode.Position(nextLine, 0), existingIndent + '{\n');
      }
    });

    const cursorLine = resolved === 'k&r' ? nextLine : nextLine + 1;
    const cursorCol = innerIndent.length;
    const p = new vscode.Position(cursorLine, cursorCol);
    ed.selections = [new vscode.Selection(p, p)];
    return true;
  }

  // 3. Control-flow header: indent on Enter, defer brace expansion
  //    `for (...)|` → newline + 1 tab stop (no braces auto-inserted)
  //    `for (...) {|}` → indent next line inside the block
  if (isControlHeader(prefix, suffix)) {
    const existingIndent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
    const tabSize = vscode.workspace.getConfiguration('editor').get<number>('tabSize', 4) || 4;
    const innerIndent = existingIndent + ' '.repeat(tabSize);

    // Check if the header already has `{` at end (Option B: don't duplicate)
    const codeSuffixStr = stripLeadingTrivia(suffix);
    const hasBraceOnLine = codeSuffixStr.startsWith('{');

    if (hasBraceOnLine) {
      // `{` already exists — open a new line and indent (defer to {|}/block expansion on next Enter)
      await ed.edit((b) => {
        b.insert(new vscode.Position(line.lineNumber, line.text.length), '\n' + innerIndent);
      });
      const newPos = new vscode.Position(line.lineNumber + 1, innerIndent.length);
      ed.selections = [new vscode.Selection(newPos, newPos)];
      return true;
    }

    // No brace yet — just insert a newline with +1 tab stop indentation.
    // Brace expansion is deferred to when the user types `{` (native auto-close
    // produces `{}`, then Enter inside those braces triggers section 1 block expansion).
    await ed.edit((b) => {
      b.insert(new vscode.Position(line.lineNumber, line.text.length), '\n' + innerIndent);
    });
    const newPos = new vscode.Position(line.lineNumber + 1, innerIndent.length);
    ed.selections = [new vscode.Selection(newPos, newPos)];
    return true;
  }

  // 4. Semicolon insertion for unclosed statements
  if (isUnclosedStatement(prefix, suffix)) {
    const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
    await ed.edit((b) => {
      b.insert(new vscode.Position(line.lineNumber, line.text.length), ';');
      b.insert(new vscode.Position(line.lineNumber, line.text.length + 1), '\n');
    });
    const p = new vscode.Position(line.lineNumber + 1, indent.length);
    ed.selections = [new vscode.Selection(p, p)];
    return true;
  }

  return false;
}

function defaultEnter(): Thenable<unknown> {
  return vscode.commands.executeCommand('default:type', { text: '\n' });
}

export function registerSmartEnter(
  context: vscode.ExtensionContext,
  getSettings: () => SharpSenseSettings,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sharpsense.smartEnter', async () => {
      const ed = vscode.window.activeTextEditor;
      const handled = ed && ed.document.languageId === 'csharp'
        ? await trySmartEnter(ed, getSettings().braceStyle)
        : false;
      if (!handled) {
        await defaultEnter();
      }
    }),
  );
}
