# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install deps (zero runtime dependencies; dev: typescript, esbuild, @types/node, @types/vscode)
- `npm run compile` / `npm run build` — bundle `src/extension.ts` → `dist/extension.js` via `esbuild.mjs` (cjs, node18, minified, sourcemap, external: vscode)
- `npm run watch` — esbuild watch mode
- `npx tsc --noEmit` — typecheck (`tsconfig.json`: strict, target ES2022, lib ES2022+DOM, rootDir src, outDir out)
- `npm run package` — `vsce package` (requires vsce)
- F5 / "Run SharpSense Extension" — launches Extension Host with `test-workspace`; preLaunchTask is `npm: compile`

No test runner is configured; verification is manual via `test-workspace/MANUAL_CHECKLIST.md`.

## Architecture

**SharpSense** is a Rider-style companion for `ms-dotnettools.csharp` + `ms-dotnettools.csdevkit` (co-installed via `extensionPack`, not `extensionDependencies` to avoid blocking activation). It never forks Roslyn — Roslyn is the sole semantic source via `vscode.executeCompletionItemProvider`. See `Docs/sharp-sense-spec.md` for the full spec and `Docs/ROADMAP.md` for the phased plan.

### Entry — `src/extension.ts`

Reads `sharpsense.*` settings into `SharpSenseSettings`, creates `SharpSense` output channel, and registers four subsystems with isolated try/catch + logging: `registerCommitShadow`, `registerLiveTemplateProvider`, `registerPostfixProvider`, `registerExpectedNewProvider`, `registerBracketHandlers`. Commands `sharpsense.showStatus` / `sharpsense.logContext` are registered here. Settings are re-read on `onDidChangeConfiguration`.

### Completion Engine — `src/completions.ts` (Phase 1 Final, commit-shadow model)

VS Code merges completion providers without deduping, so a second provider doubled every row. Current design contributes **zero** plain-symbol rows and shadows `acceptSelectedSuggestion` via `sharpsense.acceptDecorated` (bound to Enter/Tab in `package.json` when `editorLangId == csharp`):

1. On accept, `fetchShadowMap` does a single `executeCompletionItemProvider` fetch while the widget is open → `Map<baseName, ShadowEntry{kind,label,detail,doc,needsAngles}>`. Overloads are merged: `needsAngles` OR-ed, most informative `<...>(` signature kept.
2. Calls the built-in `acceptSelectedSuggestion`, then locates each committed word (`locateCommittedWord`) tolerating line shifts from auto-`using` inserts.
3. `planShadowSuffix` computes the suffix via a **strategy matrix** (`STRATEGY_MATRIX: Record<string, SuffixFormatter>`), keyed by `resolveStrategyKey(kind, hasGenerics, isAfterNew, isDeclaration)` = `Callable:Generic` (R1), `Callable:Standard` (R2), `Type:Generic:New/Decl` (R3), `Bare:PassThrough` (R5). No hardcoded type lists. One `insertSnippet(body, positions, {undoStopBefore:false, undoStopAfter:false})` per distinct body + `triggerParameterHints`.

Key helpers: `rowNeedsAngles` (generic detection from label/detail/doc + `parseGenericArity`/`isGenericInferrable`), `targetArgsForNew` (target-typed `new` prefill from LHS `List<int> x = new List|`), `shouldAddSemicolon` (statement-end `;` insertion), `slotOf`/`isInsideGenericArgs`/`deriveDeclaration`.

Supplemental providers (own `CompletionItemProvider`s, sortText `!0000`, `preselect` where needed):
- **Live Templates** (`registerLiveTemplateProvider`): `class`/`interface`/`struct`/`enum`/`record`/`prop` at member scope (`isLiveScope`).
- **Postfix** (`registerPostfixProvider`, trigger `.`): delegates to `src/postfix.ts` via `extractPostfixTarget`/`findPostfixTemplates`.
- **Expected-New** (`registerExpectedNewProvider`, triggers `space < > , . : " ' ( [ {`): `var x = new |` → `new TargetType(|);` from LHS type, guarded against `var`/abstract/interface targets.

### Context Detection — `src/context.ts` (pure, sync, line-local)

Hot-path predicates — no IPC. `detectInvokeContext(prefix, suffix) → InvokeContext{kind,name}` classifies the cursor as `invocation` | `definition` | `unity-message-definition` | `object-creation` | `attribute` | `suppress-plus-equals` | `suppress-nameof` | `existing-parens` | `other`. Uses `MODIFIERS` (single source of truth for C# modifiers), `isDeclarationHead`, `isInsideDeclarationParens`, `isBareModifierHead`, `UNITY_MESSAGE_NAMES`. Also exports `parseGenericArity`, `isGenericInferrable` (type-param inference heuristic), `resolveBraceStyle`/`ResolvedBraceStyle`, and `extractPostfixTarget` (depth-counting receiver/trigger split).

### Bracket Lifecycle — `src/brackets.ts` (+ `src/commands/smartBackspace.ts`, `src/commands/smartEnter.ts`)

- **Context keys** `sharpsense.tabOutAvailable` / `sharpsense.pairBackspaceAvailable` driven by `onDidChangeTextEditorSelection` (primary) + `onDidChangeTextDocument` (secondary), only on change. `isEmptyPair` checks `PAIRS[before] === after`; `isTabOutAvailable` checks `CLOSES`/`;`/`()`.
- **Commands** `sharpsense.tabOut` / `sharpsense.deletePair` / `sharpsense.smartEnter` with gated `when` clauses on `!suggestWidgetVisible`. `doDeletePair` deletes `Range(pos-1,pos+1)` atomically.
- **`type`/`deleteLeft` interception**: overtype of closers, opener habit guard (`((`→ step inside), chaining after auto-`;` (`.` replaces `;`), `;` jump past `)` without duplication, whitespace-line deletion, **Smart Backspace** interior-whitespace collapse + smart unindent, and **Smart Enter** brace expansion on newline.
- **Smart Backspace** (`src/commands/smartBackspace.ts`): `(   |   )` → first Backspace collapses to `(|)`, next deletes both; leading-whitespace backspace collapses to previous tabstop honoring `sharpsense.backspace.unindentMode` (`toTabstop` | `toUnindent` | `none`).
- **Smart Enter** (`src/commands/smartEnter.ts`): `{|}` → multiline block with cursor indented inside; Allman/K&R via `sharpsense.braceStyle`; single edit → single undo restores `{}`.

### Postfix Templates — `src/postfix.ts`

`POSTFIX_TEMPLATES: PostfixTemplate[]` — `.var` `.if` `.null`/`.notnull` `.for`/`.foreach` `.return` `.await` `.using` `.try` `.throw` `.cast`/`.as` `.switch`. Each `expand(expr, braceStyle) → {snippet, preview}` via `esc` (snippet-escape `$`/`}`) and `braced` (Allman vs K&R). `findPostfixTemplates(partial)` filters by prefix.

### Config

`package.json` contributes `sharpsense.smartParens`, `smartGenerics`, `smartBackspace`, `tabOut`, `overtype`, `postfixTemplates`, `verboseLogging`, `braceStyle` (allman/k&r/inherit), `smartSemicolon`. Brace style resolved via `resolveBraceStyle` with file-content sampling and `braceCache` (50-entry LRU by `doc.version`).

### Docs

- `Docs/sharp-sense-spec.md` — authoritative architecture (v2 provider-wrapper → v3 shadow commit), matrix rules R1–R5, C-guards, bracket/postfix details.
- `Docs/ROADMAP.md` — Phase 1 (completion engine) / Phase 2 (Dev Kit–backed Solution Explorer) / Phase 3 (Unity view) plan.
- `test-workspace/MANUAL_CHECKLIST.md` — manual verification checklist for F5 Extension Host.
