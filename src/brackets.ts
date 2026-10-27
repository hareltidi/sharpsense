// SharpSense Phases 1.3 / 1.5 — bracket lifecycle: smart backspace,
// structural tab-out, overtype, smart `;`.

import * as vscode from 'vscode';
import type { SharpSenseSettings } from './context';
import { tryCollapseInteriorWhitespace, trySmartUnindent, getIndentationColumn, charColumnToCount } from './commands/smartBackspace';
import { trySmartEnter } from './commands/smartEnter';
import { trySmartBraceSurround, trySmartBraceSurroundSelection } from './commands/smartBraceSurround';

const PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '<': '>',
  '"': '"',
  "'": "'",
};
const CLOSES = new Set([')', ']', '}', '>', '"', "'"]);

function charAfter(doc: vscode.TextDocument, pos: vscode.Position): string {
  const line = doc.lineAt(pos.line).text;
  return pos.character < line.length ? line[pos.character] : '';
}

function charBefore(doc: vscode.TextDocument, pos: vscode.Position): string {
  const line = doc.lineAt(pos.line).text;
  return pos.character > 0 ? line[pos.character - 1] : '';
}

function isEmptyPair(doc: vscode.TextDocument, pos: vscode.Position): boolean {
  const before = charBefore(doc, pos);
  return before !== '' && PAIRS[before] === charAfter(doc, pos);
}

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

// Importers: src/completions.ts (STRATEGY_MATRIX ghost-free `<$0>()` plain edit)
// Affected API: vscode.commands.registerCommand `sharpsense.tabOut`, context `sharpsense.tabOutAvailable`, TextEditor.selections
// User verbatim: "You can still easily see it." — screenshots: `GetComponent<int>();` with `<int>` ghost at `()` and `public class TestClass { | }` ghost at `${0}` inside braces
/** Tab jumps past a closer/`;`, into `()` or `>()` in one Tab (generic ghost-free `> |()` -> `>(|)`). */
function isTabOutAvailable(doc: vscode.TextDocument, pos: vscode.Position): boolean {
  const after = charAfter(doc, pos);
  if (CLOSES.has(after) || after === ';') return true;
  const slice2 = doc.lineAt(pos.line).text.slice(pos.character, pos.character + 2);
  if (slice2 === '()') return true;
  // Ghost-free generic: `GetComponent<int|>()` — Tab from inside `<int|>` should
  // land directly inside `()` in one press, i.e. `>|()` -> `>(|)` (2-char jump).
  // We report available when at `<int|>` and ahead is `>()`.
  const slice3 = doc.lineAt(pos.line).text.slice(pos.character, pos.character + 3);
  if (slice3 === '>()') return true;
  if (after === '>' && slice2 === '()') return true;
  return false;
}

function isWhitespaceLine(doc: vscode.TextDocument, line: number): boolean {
  return doc.lineAt(line).text.trim() === '';
}

let lastTabOut: boolean | undefined;
let lastPair: boolean | undefined;

function updateContextKeys(
  ed: vscode.TextEditor,
  getSettings: () => SharpSenseSettings,
  output?: vscode.OutputChannel,
): void {
  const s = getSettings();
  let tab = false;
  let pair = false;
  if (ed.document.languageId === 'csharp') {
    const allEmpty = ed.selections.every((sel) => sel.isEmpty);
    if (allEmpty) {
      tab =
        s.tabOut &&
        ed.selections.every((sel) => isTabOutAvailable(ed.document, sel.active));
      pair =
        s.smartBackspace &&
        ed.selections.every((sel) => isEmptyPair(ed.document, sel.active));
    }
  }
  if (tab !== lastTabOut) {
    lastTabOut = tab;
    void vscode.commands.executeCommand('setContext', 'sharpsense.tabOutAvailable', tab);
    if (output && getSettings().verbose) {
      output.appendLine(`[SharpSense] tabOutAvailable -> ${tab}`);
    }
  }
  if (pair !== lastPair) {
    lastPair = pair;
    void vscode.commands.executeCommand('setContext', 'sharpsense.pairBackspaceAvailable', pair);
    if (output) {
      const msg = `[SharpSense] pairBackspaceAvailable -> ${pair} at ${ed.document.lineAt(ed.selection.active.line).text.slice(Math.max(0, ed.selection.active.character - 2), ed.selection.active.character + 2)} (pos ${ed.selection.active.line}:${ed.selection.active.character})`;
      if (getSettings().verbose || pair) {
        output.appendLine(msg);
      }
    }
  }
}

async function doTabOut(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'csharp') {
    return;
  }
  let didGenericJump = false;
  ed.selections = ed.selections.map((sel) => {
    if (!sel.isEmpty) return sel;
    if (!isTabOutAvailable(ed.document, sel.active)) return sel;
    const line = ed.document.lineAt(sel.active.line).text;
    const after = line[sel.active.character] ?? '';
    const slice3 = line.slice(sel.active.character, sel.active.character + 3);
    const slice2 = line.slice(sel.active.character, sel.active.character + 2);
    // Ghost-free generic one-Tab: `<int|>()` -> `<int>(|)` (jump 2: past `>` and `(`)
    if (after === '>' && slice2 === '()') {
      didGenericJump = true;
      const next = sel.active.translate(0, 2);
      return new vscode.Selection(next, next);
    }
    if (slice3 === '>()') {
      didGenericJump = true;
      const next = sel.active.translate(0, 2);
      return new vscode.Selection(next, next);
    }
    const next = sel.active.translate(0, 1);
    return new vscode.Selection(next, next);
  });
  // If we jumped `>()` -> `>(|)`, exit any active snippet (e.g. `<$0>` hover
  // upgrade) so the faint ghost between `>` and `(` never appears.
  if (didGenericJump) {
    try { await vscode.commands.executeCommand('leaveSnippet'); } catch { }
    try { await vscode.commands.executeCommand('editor.action.leaveSnippet'); } catch { }
  }
}

async function doDeletePair(output?: vscode.OutputChannel): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (output) {
    output.appendLine(`[SharpSense] deletePair invoked at ${ed?.selection.active.line}:${ed?.selection.active.character} lang=${ed?.document.languageId} sel=${JSON.stringify(ed?.selections.map(s => s.active.character))} line="${ed ? ed.document.lineAt(ed.selection.active.line).text : ''}"`);
  }
  if (!ed || ed.document.languageId !== 'csharp') {
    if (output) output.appendLine('[SharpSense] deletePair abort: not csharp');
    return;
  }
  const ok = ed.selections.every((sel) => sel.isEmpty && isEmptyPair(ed.document, sel.active));
  if (!ok) {
    if (output) output.appendLine('[SharpSense] deletePair abort: not empty pair at exec time');
    return;
  }
  await ed.edit((builder) => {
    for (const sel of ed.selections) {
      if (!sel.isEmpty || !isEmptyPair(ed.document, sel.active)) {
        continue;
      }
      builder.delete(
        new vscode.Range(sel.active.translate(0, -1), sel.active.translate(0, 1)),
      );
    }
  });
  if (output) {
    output.appendLine('[SharpSense] deletePair edit applied');
  }
}

async function doDefaultBackspace(ed: vscode.TextEditor): Promise<void> {
  await ed.edit((builder) => {
    for (const sel of ed.selections) {
      if (!sel.isEmpty) {
        builder.delete(new vscode.Range(sel.start, sel.end));
      } else if (sel.active.character > 0) {
        builder.delete(new vscode.Range(sel.active.translate(0, -1), sel.active));
      } else if (sel.active.line > 0) {
        const prevLine = ed.document.lineAt(sel.active.line - 1);
        const prevEnd = new vscode.Position(sel.active.line - 1, prevLine.text.length);
        builder.delete(new vscode.Range(prevEnd, sel.active));
      }
    }
  });
}

async function doDeleteWhitespaceLine(ed: vscode.TextEditor, output?: vscode.OutputChannel, mode: string = 'toTabstop'): Promise<void> {
  const tabSize = vscode.workspace.getConfiguration('editor').get<number>('tabSize', 4) || 4;
  const linesToDelete = new Set<number>();
  for (const sel of ed.selections) {
    if (!sel.isEmpty) continue;
    if (isWhitespaceLine(ed.document, sel.active.line)) {
      linesToDelete.add(sel.active.line);
    }
  }
  if (linesToDelete.size === 0) return;
  const sorted = Array.from(linesToDelete).sort((a, b) => b - a);
  if (output) output.appendLine(`[SharpSense] whitespace line delete @${sorted.join(',')} mode=${mode}`);
  // Snapshot original selection lines before the edit — VS Code shifts selections
  // after deletes that span lines.
  const originalLines = ed.selections.map((s) => s.active.line);
  const newPositions: vscode.Position[] = ed.selections.map((sel) => sel.active);
  await ed.edit((builder) => {
    for (let k = 0; k < ed.selections.length; k++) {
      const origLine = originalLines[k];
      if (!ed.selections[k].isEmpty) continue;
      if (!isWhitespaceLine(ed.document, origLine)) continue;
      const origLineText = ed.document.lineAt(origLine).text;
      const origIndentCol = getIndentationColumn(origLineText, tabSize);
      const origIndentChars = charColumnToCount(origLineText, origIndentCol, tabSize);
      if (origLine < ed.document.lineCount - 1) {
        // Delete from start of this line through start of next line (removes newline).
        builder.delete(new vscode.Range(new vscode.Position(origLine, 0), new vscode.Position(origLine + 1, 0)));
        const prevLine = ed.document.lineAt(origLine - 1);
        if (prevLine.text.trim() === '') {
          // Prev line also ws-only — keep the deleted line's indentation.
          // Insert spaces so the cursor has real content to land on.
          if (origIndentChars > prevLine.text.length) {
            const spaceCount = origIndentChars - prevLine.text.length;
            builder.insert(new vscode.Position(origLine - 1, prevLine.text.length), ' '.repeat(spaceCount));
          }
          newPositions[k] = new vscode.Position(origLine - 1, origIndentChars);
        } else {
          // Prev line has content — cursor at end of its content.
          newPositions[k] = new vscode.Position(origLine - 1, prevLine.text.length);
        }
      } else if (origLine > 0) {
        const prevLine = ed.document.lineAt(origLine - 1);
        builder.delete(new vscode.Range(new vscode.Position(origLine - 1, prevLine.text.length), new vscode.Position(origLine, origLineText.length)));
        if (prevLine.text.trim() === '') {
          if (origIndentChars > prevLine.text.length) {
            const spaceCount = origIndentChars - prevLine.text.length;
            builder.insert(new vscode.Position(origLine - 1, prevLine.text.length), ' '.repeat(spaceCount));
          }
          newPositions[k] = new vscode.Position(origLine - 1, origIndentChars);
        } else {
          newPositions[k] = new vscode.Position(origLine - 1, prevLine.text.length);
        }
      } else {
        builder.delete(new vscode.Range(new vscode.Position(origLine, 0), new vscode.Position(origLine, origLineText.length)));
        newPositions[k] = new vscode.Position(origLine, 0);
      }
    }
  });
  ed.selections = newPositions.map((p) => new vscode.Selection(p, p));
  if (output) output.appendLine('[SharpSense] whitespace line delete applied');
}

async function interceptDeleteLeft(
  output: vscode.OutputChannel,
  getSettings: () => SharpSenseSettings,
): Promise<unknown> {
  const ed = vscode.window.activeTextEditor;
  if (output && getSettings().verbose) {
    output.appendLine(`[SharpSense] deleteLeft intercept at ${ed?.selection.active.line}:${ed?.selection.active.character} lang=${ed?.document.languageId} line="${ed ? ed.document.lineAt(ed.selection.active.line).text : ''}"`);
  }
  if (!ed || ed.document.languageId !== 'csharp') {
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
  // Interior whitespace/pair collapse takes priority
  const smartCollapsed = await tryCollapseInteriorWhitespace(ed);
  if (smartCollapsed) { return undefined; }
  // Smart unindent: collapses leading whitespace per backspace.unindentMode.
  const mode = getSettings().backspaceUnindentMode;
  const smartUnindented = await trySmartUnindent(ed, mode);
  if (smartUnindented) { return undefined; }
  // Whitespace line erasing — single backspace deletes blank/space-only line.
  // Only when cursor is at col 0 (trySmartUnindent returned false for col===0).
  if (ed.selections.every((sel) => sel.isEmpty && sel.active.character === 0 && isWhitespaceLine(ed.document, sel.active.line))) {
    return doDeleteWhitespaceLine(ed, output, mode);
  }

  if (ed.selections.every((sel) => isEmptyPair(ed.document, sel.active))) {
    if (output) output.appendLine('[SharpSense] deleteLeft pair intercept -> deletePair');
    return doDeletePair(output);
  }
  return doDefaultBackspace(ed);
}

async function interceptType(
  args: { text?: string },
  output: vscode.OutputChannel,
  getSettings: () => SharpSenseSettings,
): Promise<unknown> {
  const forward = () =>
    vscode.commands.executeCommand('default:type', args).then(
      () => undefined,
      (err) => {
        output.appendLine(`[SharpSense] type forward failed: ${String(err)}`);
      },
    );
  const ed = vscode.window.activeTextEditor;
  const ch = args?.text;
  if (!ed || ed.document.languageId !== 'csharp' || typeof ch !== 'string' || ch.length !== 1) {
    return forward();
  }
  const s = getSettings();

  // Smart brace surround: `{` typed with a selection wraps it in a brace block,
  // or `{` typed on a control-flow header line wraps the rest of the line.
  // This must happen BEFORE the empty-selection check and BEFORE the habit guard.
  if (ch === '{') {
    // Case 1: Selection wrapping — `{` typed with selected text.
    if (!ed.selection.isEmpty) {
      const handled = await trySmartBraceSurroundSelection(ed, getSettings);
      if (handled) return undefined;
      // Fall through to default if not handled (e.g., setting disabled).
      return forward();
    }
    // Case 2: Header wrapping — `{` typed on a control-flow header line.
    if (ed.selection.isEmpty) {
      const handled = await trySmartBraceSurround(ed, getSettings);
      if (handled) return undefined;
    }
  }

  if (!ed.selections.every((sel) => sel.isEmpty)) {
    return forward();
  }
  if (ch === String.fromCharCode(10) || ch === String.fromCharCode(13)) {
    if (ed.document.languageId === 'csharp') {
      // When the suggestion widget is visible, Enter should accept the suggestion
      // via the sharpsense keybinding (acceptDecoratedInsert/accceptDecoratedReplace).
      // The type interception only fires for the newline insert; if the widget is
      // visible, VS Code's keybinding resolver should have intercepted Enter before
      // reaching type(). If we still get here, let the default type() insert the
      // newline — the acceptDecorated keybinding handles the widget accept.
      // Only do Smart Enter when the widget is NOT visible.
      const handled = await trySmartEnter(ed, s.braceStyle);
      if (handled) { return undefined; }
    }
    return forward();
  }
  if (CLOSES.has(ch) && s.overtype) {
    if (ed.selections.every((sel) => charAfter(ed.document, sel.active) === ch)) {
      ed.selections = ed.selections.map((sel) => {
        const next = sel.active.translate(0, 1);
        return new vscode.Selection(next, next);
      });
      return Promise.resolve();
    }
    return forward();
  }
  // Habit guard: typing `(`, `[` or `{` directly before the same empty pair
  // (ours after an accept, or native auto-close) steps inside instead of
  // producing `(())`. Gated on overtype — it is overtype behavior.
  const expectedClose = OPENERS[ch];
  if (expectedClose && s.overtype) {
    if (ed.selections.every((sel) => {
      const line = ed.document.lineAt(sel.active.line).text;
      return line.slice(sel.active.character, sel.active.character + 2) === ch + expectedClose;
    })) {
      ed.selections = ed.selections.map((sel) => {
        const next = sel.active.translate(0, 1);
        return new vscode.Selection(next, next);
      });
      return Promise.resolve();
    }
  }
  if (ch === '.') {
    // Chaining after auto-; : GetUsers()|;  -> typing . should replace ; with .
    const chain = ed.selections.every((sel) => charAfter(ed.document, sel.active) === ';' && charBefore(ed.document, sel.active) === ')');
    if (chain) {
      await ed.edit((builder) => {
        for (const sel of ed.selections) {
          builder.delete(new vscode.Range(sel.active, sel.active.translate(0, 1)));
          builder.insert(sel.active, '.');
        }
      });
      ed.selections = ed.selections.map((sel) => new vscode.Selection(sel.active.translate(0, 1), sel.active.translate(0, 1)));
      return Promise.resolve();
    }
  }
  if (ch === ';' && s.smartParens) {
    // Bail guard: if the cursor is inside parentheses of a control-flow header
    // (e.g. `for (int i = 0|)`), let the semicolon insert normally.
    // Check if any unclosed `(` exists to the left of the cursor on this line.
    const lineText = ed.document.lineAt(ed.selection.active.line).text;
    const cursorIdx = ed.selection.active.character;
    let parenDepth = 0;
    for (let i = 0; i < cursorIdx && i < lineText.length; i++) {
      if (lineText[i] === '(') parenDepth++;
      else if (lineText[i] === ')') parenDepth--;
    }
    if (parenDepth > 0) {
      return forward();
    }
    // Inside (|); with ; already after ) -> jump past both without duplicating
    const insideWithSemi = ed.selections.every((sel) => {
      if (charAfter(ed.document, sel.active) !== ')') return false;
      const afterParen = sel.active.translate(0, 1);
      const line = ed.document.lineAt(afterParen.line).text;
      return afterParen.character < line.length && line[afterParen.character] === ';';
    });
    if (insideWithSemi) {
      ed.selections = ed.selections.map((sel) => new vscode.Selection(sel.active.translate(0, 2), sel.active.translate(0, 2)));
      return Promise.resolve();
    }
    if (ed.selections.every((sel) => charAfter(ed.document, sel.active) === ')')) {
      ed.selections = ed.selections.map((sel) => {
        const next = sel.active.translate(0, 1);
        return new vscode.Selection(next, next);
      });
      // if ; already there after ), don't duplicate
      if (ed.selections.every((sel) => charAfter(ed.document, sel.active) === ';')) {
        ed.selections = ed.selections.map((sel) => new vscode.Selection(sel.active.translate(0, 1), sel.active.translate(0, 1)));
        return Promise.resolve();
      }
      return forward();
    }
    if (ed.selections.every((sel) => charAfter(ed.document, sel.active) === ';')) {
      ed.selections = ed.selections.map((sel) => {
        const next = sel.active.translate(0, 1);
        return new vscode.Selection(next, next);
      });
      return Promise.resolve();
    }
  }
  return forward();
}

export function registerBracketHandlers(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  getSettings: () => SharpSenseSettings,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sharpsense.tabOut', () => doTabOut()),
    vscode.commands.registerCommand('sharpsense.deletePair', () => doDeletePair(output)),
    vscode.window.onDidChangeTextEditorSelection((e) => updateContextKeys(e.textEditor, getSettings, output)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === e.document) {
        updateContextKeys(ed, getSettings, output);
      }
    }),
    vscode.commands.registerCommand('type', (args) => interceptType(args, output, getSettings)),
    vscode.commands.registerCommand('deleteLeft', () => interceptDeleteLeft(output, getSettings)),
  );
  if (vscode.window.activeTextEditor) {
    updateContextKeys(vscode.window.activeTextEditor, getSettings, output);
  }
}
