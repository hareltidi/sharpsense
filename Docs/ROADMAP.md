# SharpSense ROADMAP — v2 Provider-Wrapper

Source vision: [sharp-sense-spec.md](sharp-sense-spec.md) — pivoted 2026-09-13 to Provider-Wrapper
Date: 2026-09-13
Status: Phase 1 legacy post-accept bridge **implemented** but **to be refactored** to Provider-Wrapper per this plan. Phase 2/3 not started.

## Goal

One lightweight VS Code extension that runs well on both a high-end desktop and a school laptop, sitting on top of the **official Microsoft C# + C# Dev Kit + Unity extensions (no fork)**, adding:

1. Rider-style context-aware completions (single-undo, zero-latency)
2. A real Solution Explorer (Dev Kit–backed)
3. A Unity-aware explorer view (optional, peer-activated)

Non-goals: forking Roslyn, replacing the debugger, decompiling beyond F12, or re-implementing what Roslyn already does.

## Architecture — Provider-Wrapper (replaces Companion Bridge)

```
VS Code (C# document)
  └─ SharpSense CompletionItemProvider (wrapper, primary)
       └─ inside provideCompletionItems: await vscode.executeCompletionItemProvider(uri, pos)
            └─ Roslyn (ms-dotnettools.csharp) returns raw items
       └─ decorates insertText as SnippetString for each item that warrants it
       └─ returns decorated list → VS Code commits a SINGLE snippet transaction
  └─ SharpSense Postfix provider ('.' trigger) — independent
  └─ Bracket handlers (pair-delete, tab-out, overtype, smart ;) — independent
```

**Why this replaces Phase 1.0's `onDidChangeTextDocument` bridge:**

- **Undo:** one native edit = one `Ctrl+Z`. No second edit → no 5-step fragmentation, no `get` → `get()` ghost on undo.
- **Latency:** classification runs **inside** `provideCompletionItems` while the widget is populating, not after `Enter`. `Enter` cost is zero extra IPC.
- **Simplicity:** no active-editor guard, no output-panel filter, no 8–20 ms settle, no warm cache, no undo chaining. The document hasn't changed yet when we decide, so none of those hazards exist.
- **Microsoft owns the list:** we still never re-rank or hide items; we only set `insertText`/`insertTextFormat`. If the wrapper throws, VS Code falls back to Roslyn's items.

## Dependency Mandate (package.json)

```json
"extensionDependencies": [
  "ms-dotnettools.csharp",
  "ms-dotnettools.csdevkit"
]
```

- Installing SharpSense **auto-installs and activates** `C#` + `C# Dev Kit`. Both are required; the wrapper has nothing to wrap without Roslyn, and the explorer has nothing to query without Dev Kit's workspace.
- **Optional peer:** `visualstudiocode-unity.unity` (or current Unity publisher id) — if present, Phase 3 Unity view is offered; if absent, the explorer runs in Standard/File-System mode only. SharpSense never hard-depends on Unity so non-Unity users aren't forced to install it.

## Performance & Latency (Critical — unchanged target, simpler path)

Must feel instant on both machines. `Enter`/`Tab` commit must have **no perceivable delay**.

- Fast startup & small bundle: lazy `onLanguage:csharp`, `esbuild` bundle, zero runtime deps — unchanged.
- **Zero async blocking on the commit path:** hot-path checks (`nameof`, `+=`, trailing `()`, line prefix/suffix) stay as local string/regex scans, but they now run **before** commit (inside `provideCompletionItems`), not after. The only IPC in the wrapper is the single `executeCompletionItemProvider` call that the wrapper itself initiates — the same call VS Code would have made anyway. No second IPC after `Enter`.
- Explorer (Phase 2): cache parsed `.sln` / `.slnx` / `.csproj` trees; watch via `FileSystemWatcher`; debounce; never re-parse on every keystroke.

## Settings & Defaults (approved)

Core smart completions ON by default: `sharpsense.smartParens`, `sharpsense.smartGenerics`, `sharpsense.smartBackspace`. Every sub-behavior individually switchable; disabling SharpSense restores vanilla. `sharpsense.braceStyle` (`allman` / `k&r` / `inherit`) honoured in every block-generating snippet (postfix `.if` etc.).

---

## Phase 1: Completion Engine — Provider-Wrapper Refactor (ship first)

> This phase **replaces** the implemented `registerAcceptTracking` + `registerParenInsertion` + `onDidChangeTextDocument` + settle/cache/undo-chain logic in `src/completions.ts` and the `sharpsense.acceptEnter`/`acceptTab` keybindings in `package.json`. `src/context.ts` (pure scans) and `src/brackets.ts` (bracket lifecycle) are kept, with the backspace redesign below.

### 1.0 Test harness (keep, extend)

- [x] 1.0.1 `package.json` activation `onLanguage:csharp`, `extensionDependencies` for `csharp` + `csdevkit` (add `csdevkit`)
- [x] 1.0.2 Local test workspace (`test-workspace/`) with cases: plain method, generic inferrable/non-inferrable, constructor (`new List<>` / `new List<string>`), `+=` delegate, `nameof`, attribute, trailing `()` exists, Unity `Start`/`Update` definitions
- [ ] 1.0.3 **New:** Add undo/latency harness cases — `get` → `getUser` accept → `;` → `Ctrl+Z` chain expects `;` removed, then **one** `Ctrl+Z` removes `getUser()` + word together; verify no `get()` ghost
- [ ] 1.0.4 **New:** Manual latency check — `getUser` must show `()` already in the widget's detail/preview, not popping after `Enter`; no `20–50 ms` flash
- Acceptance: `npm run build` clean, `F5` Extension Host, vanilla behavior when SharpSense disabled, both extension dependencies auto-install

### 1.1 Context detection (keep, no migration)

Pure sync predicates in `src/context.ts` — already correct, reused verbatim by the wrapper:

- [x] 1.1.1 `detectInvokeContext` — `invocation` vs `definition` vs `unity-message-definition` vs `object-creation` vs `attribute` vs `suppress-plus-equals` vs `suppress-nameof` vs `existing-parens`
- [x] 1.1.2 `parseGenericArity` + `isGenericInferrable` (detail string → arity + inferrability heuristic)
- [x] 1.1.3 `resolveBraceStyle` + `extractPostfixTarget` (postfix)
- Acceptance: unit tests/logContext show correct `kind` for every harness line; zero edits

### 1.2 Provider-Wrapper (the pivot) — replaces 1.2 + 1.5 + 1.6 post-accept glue

**File to refactor:** `src/completions.ts` → new shape:

```
registerWrapperProvider(context, output, getSettings)
  provider.provideCompletionItems(document, position, token, ctx)
    if (doc.languageId !== 'csharp') return
    const raw = await vscode.commands.executeCommand<CompletionList|CompletionItem[]>(
      'vscode.executeCompletionItemProvider', doc.uri, position, ctx.triggerCharacter)
    if (!raw) return
    for each item in list:
      label = string label
      if (NEVER_PAREN_KEYWORDS has label) → return bare
      context = detectInvokeContext(prefixAtPos, suffixAtPos)
      if (context not invocation/object-creation) → bare (nameof, +=, attribute, definition, existing-parens)
      wordClass/detail = from item.kind + item.detail  (no extra IPC — already have raw)
      if (wordClass === 'other' → bare)   // property/field/namespace
      if (wordClass === 'type' && context !== 'object-creation' → bare)
      generic = smartGenerics && !alreadyGeneric && invocation && arity>0 && !inferrable
      if (!smartParens) → bare
      // decorate
      item.insertText = generic ? new SnippetString(`${label}<\${1}>(\${0})`)
                                : new SnippetString(`${label}(\${0})`)
      item.insertTextFormat = Snippet
      item.command = { command: 'editor.action.triggerParameterHints', title: '' }  // hints
    return decorated list
  vscode.languages.registerCompletionItemProvider('csharp', provider, '.', ...triggers)
```

**Tasks:**

- [ ] 1.2.1 **Remove** from `package.json`: `sharpsense.acceptEnter`/`acceptTab` commands + `enter`/`tab` keybindings + `sharpsense.enabled` context key. Remove from `src/extension.ts`: `setContext('sharpsense.enabled', true)` arm. Remove from `src/completions.ts`: `registerAcceptTracking`, `runAccept` (zero-diff path), `registerParenInsertion`/`handleChange`, `computeFinalPos`, `REASON_UNDO`/`REASON_REDO`, `COMPLETION_CACHE`/`warmCache`/`scheduleWarm`, `lastParenInsert` chaining, `SELECTION_SETTLE_MS`.
- [ ] 1.2.2 **Implement** `registerWrapperProvider(context, output, getSettings)` as above. Preserve `registerPostfixProvider` unchanged (it coexists).
- [ ] 1.2.3 Wire in `src/extension.ts`: replace `registerAcceptTracking` + `registerParenInsertion` with `registerWrapperProvider(context, output, getSettings)`. Keep `updateContextKeys` bracket wiring.
- [ ] 1.2.4 Keep `NEVER_PAREN_KEYWORDS`, `WordClass`, `parseGenericArity`/`isGenericInferrable` reuse. Verify `alreadyGeneric` derived from `label`'s trailing `<...>` slice (`m[2]`), not from document text (document hasn't selected yet).
- [ ] 1.2.5 Trigger chars: register with `...` (or no explicit triggers + let VS Code invoke on demand) and `.` for postfix coexistence. Verify Roslyn still provides items for the wrapper to delegate to (delegate to `executeCompletionItemProvider` with `triggerCharacter`).
- [ ] 1.2.6 `package.json` → `extensionDependencies`: add `"ms-dotnettools.csdevkit"` alongside `"ms-dotnettools.csharp"`.
- Acceptance: `DoSomething` accept produces `DoSomething(|)` + hints in ONE undo stop; `nameof(DoSomething)` and `+= OnChanged` produce bare identifiers; `GetComponent` with non-inferrable `T` produces `GetComponent<$1>($2)`; existing `Foo()` never becomes `Foo()()`; single `Ctrl+Z` removes word+parens together; no visual pop.

### 1.3 Smart backspace — synchronous redesign (replaces 1.3.1)

**File to refactor:** `src/brackets.ts` — `updateContextKeys` + `registerBracketHandlers`.

- [ ] 1.3.1 Move `updateContextKeys`' driver to **selection-first**: `vscode.window.onDidChangeTextEditorSelection` is the primary updater; `workspace.onDidChangeTextDocument` (guarded `ed.document === e.document`) is secondary for typing that doesn't fire selection. Both call `updateContextKeys(ed, getSettings)` which computes:

  ```
  pair = smartBackspace && every sel.isEmpty && isEmptyPair(doc, sel.active) // PAIRS[before]===after
  tab  = tabOut        && every sel.isEmpty && CLOSES.has(charAfter(doc, sel.active))
  ```

  and does `setContext('sharpsense.pairBackspaceAvailable', pair)` / `tabOutAvailable` **only on change**. Add verbose logging: `[SharpSense] pairBackspaceAvailable -> true at () (pos l:c)` when enabled/verbose.

- [ ] 1.3.2 Keep `when` from previous fix:

  ```json
  { "command": "sharpsense.deletePair", "key": "backspace",
    "when": "editorTextFocus && editorLangId == csharp && sharpsense.pairBackspaceAvailable && !suggestWidgetVisible" }
  ```

  `!suggestWidgetVisible` ensures the widget, not the pair, owns Backspace.

- [ ] 1.3.3 `doDeletePair` stays as single `ed.edit` deleting `Range(pos-1, pos+1)` per selection — atomic, single undo. No change.

- [ ] 1.3.4 (Unchanged) Tab-out + overtype + smart `;` keep their `tabOutAvailable` / `type` interceptor design.

- Acceptance: cursor in `(|)`/`<|>`/`[|]`/`{|}`/`"|"`/`'|'` → `pairBackspaceAvailable` becomes `true` immediately on moving there; `Backspace` deletes the pair in one stroke, one undo; not active outside pairs; not active when widget is visible.

### 1.4 Postfix templates (keep)

- [x] 1.4.1 Core set: `.var` `.if` `.null`/`.notnull` `.for`/`.foreach` `.return` `.await`
- [x] 1.4.2 Second set: `.using` `.try` `.throw` `.cast`/`.as` `.switch`
- [x] 1.4.3 `.` trigger inside completion box, `extractPostfixTarget` depth counting
- [x] 1.4.4 `braceStyle` inheritance (`allman`/`k&r`/`inherit`) in every block expansion
- Acceptance: no change; coexistence with wrapper verified (`.` still triggers postfix, wrapper still decorates methods)

### 1.5 Commit keys & sorting (simplify)

- [ ] 1.5.1 **Remove** Enter/Tab accept interceptors — native wrapper commit is now the commit. Verify Tab still works with `!inSnippetMode` where VS Code expects it and `tabOut` (`tab` → jump past `)`) still has `!suggestWidgetVisible && !inSnippetMode`.
- [x] 1.5.2 `;` / `.` / overtype handlers in `brackets.ts:interceptType` stay (smart `;` jumps past `)`, overtype moves past duplicate closer).
- Acceptance: no double-commit, no lost keystrokes, sorting stays Roslyn's (wrapper never re-ranks).

### 1.6 Hardening + compatibility gate

- [ ] 1.6.1 Verify with `ms-dotnettools.csharp` + `ms-dotnettools.csdevkit` (+ optional Unity extension) enabled, Unity and non-Unity projects, both machines. Replacing post-accept path means re-running every `MANUAL_CHECKLIST.md` case top-to-bottom (especially `get` → `getUser` undo chain and latency cases that previously had harness gaps).
- [x] 1.6.2 Unity message methods (`Start`/`Update` definitions) do not get call-site parens — still suppressed via `unity-message-definition` from `detectInvokeContext`.
- [ ] 1.6.3 Performance — laptop: no typing lag. Wrapper adds at most one extra `executeCompletionItemProvider` per provider invocation, which VS Code already issues — net zero extra IPC on commit.
- [x] 1.6.4 Settings defaults ON (`smartParens`, `smartGenerics`, `smartBackspace` + `braceStyle` + postfix toggles) — individually switchable off; no telemetry.

Dropped per review 2026-09-13 — still dropped: unimported-type auto-import / `override` / interface scaffolding (Roslyn native), decompiler/IL view (F12 native). No change.

---

## Phase 2: Base Solution Explorer — Dev Kit–backed

Depends on: Phase 1 (no code dependency, but ships second for review cadence).

> **Pivot note:** Phase 2 no longer rolls its own `.sln`/`.slnx`/`.csproj` XML parser as the sole source of truth. With `ms-dotnettools.csdevkit` as a hard dependency, the explorer can be backed by **C# Dev Kit's Roslyn workspace** via its VS Code commands, while still tolerating a lightweight XML fallback for offline/open-folder scenarios.

- [ ] 2.1 **Workspace model:**
  - Primary: `vscode.commands.executeCommand('roslyn.client.getSolution')` / Dev Kit workspace commands (exact ids to confirm at implementation against the installed Dev Kit) to obtain solution, projects, project references, package references, target frameworks, and file lists. This gives us the same graph Dev Kit's own Solution Explorer uses, without re-parsing.
  - Fallback: minimal `.sln` + `.slnx` (XML) + SDK-style `.csproj` reader for the case the workspace isn't loaded yet (open-folder before restore). Validated against a 3-project `.sln` + `.slnx`.
  - Mapping: solution → solution folders → projects → dependencies/files; project GUID → `TreeItem`. Live invalidation via `FileSystemWatcher` on `.sln*` / `*.csproj` / `Directory.*.props`.

- [ ] 2.2 `TreeView` (`TreeDataProvider<ExplorerNode>`) — solution node, projects, files, solution folders, icons, `revealInExplorer`, fuzzy search provider, Pending Changes (Git) filter (via `vscode.git` extension API), show/hide symbols under `.cs` files (via `vscode.executeDocumentSymbolProvider`).

- [ ] 2.3 View options: Solution view, Show All Files overlay (fs scan vs. `<Compile>`), Pending Changes filter, show/hide symbols — same spec (§2.1), now toggling which source feeds the TreeData.

- [ ] 2.4 Dependencies node — **backed by Dev Kit where possible:**
  - NuGet (version + transitive + audit/Copilot vulnerability flag) from Dev Kit's Package/Restore model; fall back to parsing `obj/project.assets.json` / `PackageReference` if not exposed.
  - `<ProjectReference>` add/remove via `dotnet` CLI or Dev Kit commands; reflect in `TreeView`.
  - Assembly/DLL `<Reference>` + COM + `.projitems` shared projects — direct `.csproj` edit + Dev Kit reload.
  - Analyzers/source generators node — from workspace/project data.

- [ ] 2.5 Lifecycle ops — Add New Item template picker (`dotnet new` under the hood) with namespace calc; Add Existing (copy vs `Link`); safe rename (file ↔ class ↔ references via `vscode.executeDocumentRenameProvider`); `DependentUpon` nesting rules.

- [ ] 2.6 Config — property pages GUI (TFM, output type, nullable, implicit usings, lang version) via editing `.csproj` + reloading workspace; side-by-side `.csproj` XML editor; Debug/Release + platform switcher (leveraging Dev Kit launch/config if exposed).

- [ ] 2.7 Rider extras — namespace-aware drag-move (`FileSystem` + `workspace.applyEdit` for namespace `using` fixes), folder/project rename, safe delete (usage via `vscode.executeReferenceProvider`), `Directory.Packages.props` / `Directory.Build.props` first-class nodes.

- Acceptance: opens a 3-project `.sln` + `.slnx` via the Dev Kit workspace when available; falls back to the lightweight parser when not; add/remove/reference flows round-trip to disk and refresh the tree; search/filter toggles work; disabling Dev Kit clearly explains the Explorer is degraded/offline.

Dropped — still dropped: decompiler/IL view, Source Link fetching (F12).

---

## Phase 3: Unity Explorer View & `.meta` Sync

Depends on: Phase 2 tree + commands. **No hard dependency on Unity** — presence of `visualstudiocode-unity.unity` (or Unity's current publisher id) is detected at activation; only when present is the Unity view offered.

- [ ] 3.1 Unity detection (`Assets/` + `ProjectSettings/` + `Packages/manifest.json`) + default-view selection (Unity view when Unity detected + provider present, else Standard/File-System).
- [ ] 3.2 3-way toolbar switcher: Unity view / Standard Solution view / File System view; Unity view hides `Temp/`/`Library/`/`Logs/`/generated `.csproj`/`.sln`.
- [ ] 3.3 `.asmdef` / `.asmref` first-class nodes + reference editor (visually group files under their defining `.asmdef`, as Rider does).
- [ ] 3.4 Packages node (embedded vs manifest, immutable vs local) + Project Settings display.
- [ ] 3.5 `.meta` sync: `FileSystemWatcher` + `workspace.onDidCreate/Delete/Rename` — move/rename/delete of `.cs` / `.asmdef` / asset auto-applies to `.meta` to preserve GUID, with undo-safe `WorkspaceEdit`.
- [ ] 3.6 Unity scaffolding: MonoBehaviour, ScriptableObject, Editor Window, Custom Inspector, Property Drawer, `.asmdef`, HLSL/Shader.
- [ ] 3.7 Template table (spec §5): `dotnet new` wrappers + Unity package/manifest palette entries.
- Acceptance: open Unity project → defaults to Unity view when Unity extension present; toolbar toggle works; rename of a script renames its `.meta`; `.asmdef` grouping matches Rider; project still opens normally when Unity extension absent.

---

## Execution Order (on Go, after this doc review)

1. **Phase 1 refactor** — scaffold → 1.1 keep → **1.2 wrapper pivot** → **1.3 backspace redesign** → 1.4/1.5 polish → 1.6 gate → demo + review (full `MANUAL_CHECKLIST.md` top-to-bottom).
2. Phase 2.1 → 2.7 (Dev Kit–backed explorer) → demo + review.
3. Phase 3.1 → 3.7 (Unity, peer-activated) → demo + review.

Each phase ends with a pause for review before the next begins. No phase starts without an explicit Go.

## Open Questions for Review (updated 2026-09-13 pivot)

1. ~~Auto-import / `override` / interface scaffolding~~ — RESOLVED: still dropped, Roslyn handles natively.
2. ~~Decompiler/IL view~~ — RESOLVED: still dropped, F12 native.
3. Settings defaults — RESOLVED: core ON, granular off-switches, no telemetry in Phase 1.
4. **NEW — Wrapper fisheye:** Does decorating `insertText` as a `SnippetString` risk double-tabstop interaction with snippet mode or signature help? Plan keeps `insertTextFormat = Snippet` and `command: triggerParameterHints`; needs F5 verification that `Tab` doesn't trap, hints still show, and undo stays single.
5. **NEW — Dev Kit command shape:** `roslyn.client.getSolution` / workspace ids are not yet pinned against the installed `ms-dotnettools.csdevkit` bundle in this workspace. Phase 2.1 must confirm the exact command ids and payload shapes in an Exploration spike before locking the `TreeDataProvider` contract.
6. **NEW — Trigger characters:** Should the wrapper register with an explicit trigger set (`,`, `(`, `.`, `<`, ` `) or with none and rely on VS Code's invocation? Will be validated against `CompletionCases.cs` so passive typing (`obj.`) and explicit `Ctrl+Space` both decorate.
