// Input interception: `type`, `deleteLeft`, and the Enter keybinding command.
//
// Everything here is language-agnostic — behavior differences come from the
// LanguageProfile (braced / indented / generic) handed to the helpers.

import * as vscode from 'vscode';
import type { Settings } from './settings';
import { profileFor } from './languages';
import { tryCollapseInteriorWhitespace, trySmartUnindent } from './smartBackspace';
import { trySmartEnter } from './smartEnter';
import {
  trySmartBraceSurround,
  trySmartBraceSurroundSelection,
} from './smartBraceSurround';

const PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '<': '>',
  '"': '"',
  "'": "'",
};
const CLOSES = new Set([')', ']', '}', '>', '"', "'"]);
const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

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

function isWhitespaceLine(doc: vscode.TextDocument, line: number): boolean {
  return doc.lineAt(line).text.trim() === '';
}

let output: vscode.OutputChannel | undefined;
let getSettings: () => Settings;

function log(message: string): void {
  if (output && getSettings().verbose) output.appendLine(`[SmartEnterAndBackspace] ${message}`);
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

async function doDeletePair(ed: vscode.TextEditor): Promise<void> {
  await ed.edit((builder) => {
    for (const sel of ed.selections) {
      if (!sel.isEmpty || !isEmptyPair(ed.document, sel.active)) continue;
      builder.delete(new vscode.Range(sel.active.translate(0, -1), sel.active.translate(0, 1)));
    }
  });
}

/** Removes a blank/whitespace-only line, keeping the caret on the joined line. */
async function doDeleteWhitespaceLine(ed: vscode.TextEditor): Promise<void> {
  const doc = ed.document;
  const target = ed.selections.find(
    (sel) => sel.isEmpty && isWhitespaceLine(doc, sel.active.line),
  )?.active.line;
  if (target === undefined) return;

  const text = doc.lineAt(target).text;
  const cursorCol = text.length;

  if (target < doc.lineCount - 1) {
    await ed.edit((builder) => {
      builder.delete(
        new vscode.Range(new vscode.Position(target, 0), new vscode.Position(target + 1, 0)),
      );
    });
    const p = new vscode.Position(target, cursorCol);
    ed.selection = new vscode.Selection(p, p);
  } else if (target > 0) {
    const prev = doc.lineAt(target - 1);
    await ed.edit((builder) => {
      builder.delete(
        new vscode.Range(
          new vscode.Position(target - 1, prev.text.length),
          new vscode.Position(target, text.length),
        ),
      );
    });
    const p = new vscode.Position(target - 1, prev.text.length);
    ed.selection = new vscode.Selection(p, p);
  }
  log(`whitespace line delete @${target}`);
}

async function interceptDeleteLeft(): Promise<unknown> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return undefined;
  const settings = getSettings();
  const profile = profileFor(ed.document.languageId);
  log(`deleteLeft ${profile.family} ${ed.selection.active.line}:${ed.selection.active.character}`);

  if (!settings.smartBackspace) {
    return doDefaultBackspace(ed);
  }
  if (!ed.selections.every((sel) => sel.isEmpty)) {
    return doDefaultBackspace(ed);
  }

  if (await tryCollapseInteriorWhitespace(ed)) return undefined;
  if (await trySmartUnindent(ed, settings, profile)) return undefined;

  // Blank-line erasing is a braced/C-style expectation; in indented languages a
  // blank line is structural, so Backspace there keeps native behavior.
  if (
    profile.family !== 'indented' &&
    ed.selections.every(
      (sel) =>
        sel.isEmpty &&
        sel.active.character === 0 &&
        isWhitespaceLine(ed.document, sel.active.line),
    )
  ) {
    return doDeleteWhitespaceLine(ed);
  }

  if (ed.selections.every((sel) => isEmptyPair(ed.document, sel.active))) {
    return doDeletePair(ed);
  }
  return doDefaultBackspace(ed);
}

async function interceptType(args: { text?: string }): Promise<unknown> {
  const forward = () =>
    vscode.commands.executeCommand('default:type', args).then(
      () => undefined,
      (err) => log(`type forward failed: ${String(err)}`),
    );

  const ed = vscode.window.activeTextEditor;
  const ch = args?.text;
  if (!ed || typeof ch !== 'string') return forward();

  const settings = getSettings();
  const profile = profileFor(ed.document.languageId);

  // Smart brace surround — only meaningful where braces form blocks.
  if (ch === '{' && profile.family === 'braced') {
    if (!ed.selection.isEmpty) {
      if (await trySmartBraceSurroundSelection(ed, settings, profile)) return undefined;
      return forward();
    }
    if (await trySmartBraceSurround(ed, settings, profile)) return undefined;
  }

  if (!ed.selections.every((sel) => sel.isEmpty)) return forward();

  // Overtype a closer already sitting after the caret.
  if (CLOSES.has(ch) && settings.overtype) {
    if (ed.selections.every((sel) => charAfter(ed.document, sel.active) === ch)) {
      ed.selections = ed.selections.map((sel) => {
        const next = sel.active.translate(0, 1);
        return new vscode.Selection(next, next);
      });
      return Promise.resolve();
    }
    return forward();
  }

  // Habit guard: typing an opener right before its own empty pair steps inside.
  const expectedClose = OPENERS[ch];
  if (expectedClose && settings.overtype) {
    if (
      ed.selections.every((sel) => {
        const line = ed.document.lineAt(sel.active.line).text;
        return line.slice(sel.active.character, sel.active.character + 2) === ch + expectedClose;
      })
    ) {
      ed.selections = ed.selections.map((sel) => {
        const next = sel.active.translate(0, 1);
        return new vscode.Selection(next, next);
      });
      return Promise.resolve();
    }
  }

  // Chaining after an auto-inserted `;`: `GetUsers()|;` + `.` replaces the `;`.
  if (ch === '.' && profile.semicolons) {
    const chain = ed.selections.every(
      (sel) =>
        charAfter(ed.document, sel.active) === ';' && charBefore(ed.document, sel.active) === ')',
    );
    if (chain) {
      await ed.edit((builder) => {
        for (const sel of ed.selections) {
          builder.delete(new vscode.Range(sel.active, sel.active.translate(0, 1)));
          builder.insert(sel.active, '.');
        }
      });
      ed.selections = ed.selections.map((sel) => {
        const p = sel.active.translate(0, 1);
        return new vscode.Selection(p, p);
      });
      return Promise.resolve();
    }
  }

  // Semicolon jump: `foo(|);` + `;` moves past both without duplicating.
  if (ch === ';' && profile.semicolons) {
    const insideWithSemi = ed.selections.every((sel) => {
      if (charAfter(ed.document, sel.active) !== ')') return false;
      const afterParen = sel.active.translate(0, 1);
      const line = ed.document.lineAt(afterParen.line).text;
      return afterParen.character < line.length && line[afterParen.character] === ';';
    });
    if (insideWithSemi) {
      ed.selections = ed.selections.map((sel) => {
        const p = sel.active.translate(0, 2);
        return new vscode.Selection(p, p);
      });
      return Promise.resolve();
    }
    if (ed.selections.every((sel) => charAfter(ed.document, sel.active) === ')')) {
      ed.selections = ed.selections.map((sel) => {
        const p = sel.active.translate(0, 1);
        return new vscode.Selection(p, p);
      });
      if (ed.selections.every((sel) => charAfter(ed.document, sel.active) === ';')) {
        ed.selections = ed.selections.map((sel) => {
          const p = sel.active.translate(0, 1);
          return new vscode.Selection(p, p);
        });
        return Promise.resolve();
      }
      return forward();
    }
  }

  return forward();
}

/** Enter keybinding target — Smart Enter, falling back to a plain newline. */
async function runSmartEnter(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    await vscode.commands.executeCommand('default:type', { text: '\n' });
    return;
  }
  const settings = getSettings();
  const profile = profileFor(ed.document.languageId);
  if (await trySmartEnter(ed, settings, profile)) {
    log(`smart enter handled (${profile.family})`);
    return;
  }
  await vscode.commands.executeCommand('default:type', { text: '\n' });
}

export function registerBracketHandlers(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  settingsReader: () => Settings,
): void {
  output = channel;
  getSettings = settingsReader;

  context.subscriptions.push(
    vscode.commands.registerCommand('smartEnterAndBackspace.smartEnter', () => runSmartEnter()),
    vscode.commands.registerCommand('type', (args: { text?: string }) => interceptType(args)),
    vscode.commands.registerCommand('deleteLeft', () => interceptDeleteLeft()),
  );
}
