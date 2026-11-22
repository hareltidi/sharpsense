import * as vscode from 'vscode';

export type BraceStyleSetting = 'allman' | 'k&r' | 'inherit';
export type ResolvedBraceStyle = 'allman' | 'k&r';
export type UnindentMode = 'toUnindent' | 'toTabstop' | 'toProper' | 'none';

export interface Settings {
  smartEnter: boolean;
  smartBackspace: boolean;
  braceExpansion: boolean;
  braceStyle: BraceStyleSetting;
  smartSurroundWithBraces: boolean;
  smartSemicolon: boolean;
  overtype: boolean;
  backspaceUnindentMode: UnindentMode;
  indentedLanguagesUseNearestIndent: boolean;
  verbose: boolean;
}

export function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration('smartEnterAndBackspace');
  return {
    smartEnter: cfg.get<boolean>('smartEnter', true),
    smartBackspace: cfg.get<boolean>('smartBackspace', true),
    braceExpansion: cfg.get<boolean>('braceExpansion', true),
    braceStyle: cfg.get<BraceStyleSetting>('braceStyle', 'inherit'),
    smartSurroundWithBraces: cfg.get<boolean>('smartSurroundWithBraces', true),
    smartSemicolon: cfg.get<boolean>('smartSemicolon', true),
    overtype: cfg.get<boolean>('overtype', true),
    backspaceUnindentMode: cfg.get<UnindentMode>('backspace.unindentMode', 'toProper'),
    indentedLanguagesUseNearestIndent: cfg.get<boolean>(
      'backspace.indentedLanguagesUseNearestIndent',
      true,
    ),
    verbose: cfg.get<boolean>('verboseLogging', false),
  };
}

export function resolveBraceStyle(
  setting: BraceStyleSetting,
  documentText: string,
): ResolvedBraceStyle {
  if (setting === 'allman' || setting === 'k&r') {
    return setting;
  }
  // `inherit`: follow the file, Allman on ties.
  const sample = documentText.length > 100_000 ? documentText.slice(0, 100_000) : documentText;
  const allman = (sample.match(/\)[ \t]*\r?\n[ \t]*\{/g) ?? []).length;
  const sameLine = (sample.match(/\)[ \t]*\{/g) ?? []).length;
  if (allman === 0 && sameLine === 0) {
    return 'allman';
  }
  return allman >= sameLine ? 'allman' : 'k&r';
}
