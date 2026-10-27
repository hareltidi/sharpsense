# Phase 1.x Manual Verification Checklist

Goal: Rider-style context completions on top of Microsoft C# + Unity extensions,
with zero typing lag on both machines.

## Setup

- [ ] `npm install` succeeds with zero runtime dependencies (`dependencies: {}`)
- [ ] `npm run compile` produces `dist/extension.js` via esbuild (minified, sourcemap)
- [ ] `./node_modules/.bin/tsc --noEmit` passes with no errors (TS2584 `console` fix: `lib` includes `DOM`, no `console.*` left in `src/`)
- [ ] Press F5 (Run SharpSense Extension) — dev host opens with `test-workspace` folder
- [ ] Microsoft C# + C# Dev Kit (+ Unity extension if testing Unity) are enabled in dev host (C# co-installs via `extensionPack`, non-blocking)
- [ ] Output panel → SharpSense shows `[SharpSense] activated (Phase 1.x)`

## 1.1 Context detection (no-edit cases + log command)

- [ ] Place cursor in each spot, run `SharpSense: Log Context Here`, check the Output label:
  - `DoSome|` call site → `invocation`
  - `void DefinitionShouldNotExpand|` → `definition`
  - `Changed += OnChanged|` → `suppress-plus-equals`
  - `nameof(DoSomething|)` → `suppress-nameof`
  - `[MyAttr|]` → `attribute`
  - `DoSomething(|)` / `DoSomething|()` → `existing-parens`
  - `new List<string>|` → `object-creation`
  - `void Start|` (Unity) → `unity-message-definition`

## 1.2 Insertion — v3 shadow (`()` / `<>` routing, kind-gated, single undo)

Shadow rule (SSCE matrix, evaluated at commit from Roslyn's own kind + a 1-line slot lookback): R1 generic callable → `Name<|>()`; R2 callable → `Name(|)`; R3 generic TYPE → `List<|>` (no parens — a type reference is not a call); R4 definitions stay bare; R5 (keywords, properties, fields, variables, enums, unknown) stays bare. Roslyn shows the ONLY list (exactly one row per symbol — verify NO duplicates).

- [ ] Type `getUser`, accept with Enter → `getUser(|)` + parameter hints, ONE undo (Ctrl+Z) removes word+parens together
- [ ] Accept same with Tab → same result, no lost keystrokes
- [ ] Type `publ`, accept `public` → bare keyword, NO parens
- [ ] Declare `List myList` — accept `List` → `List<|>` with cursor inside `<>` (R3); type `int`, Tab → `List<int>|`
- [ ] Field `public List items` — accept `List` → `List<|>` (R3 field-type carve-out, NOT a ctor definition)
- [ ] Accept `Dictionary` → `Dictionary<|>`; accept `Console` / `DateTime` → bare (non-generic types take nothing)
- [ ] Accept `List` when `<>` already typed ahead → NO doubled `<>` (C2 guard)
- [ ] Type `GetComp`, accept `GetComponent` → `GetComponent<|>()` with cursor inside `<>` first (non-inferrable `T`); Tab moves into `()`
- [ ] Generic method with non-generic overloads (`GetComponent` over `GetComponent(Type)`) → STILL `GetComponent<|>()` (overload-aggregated R1)
- [ ] Run "SharpSense: Log Context Here" on a generic method → Output lists the raw Roslyn rows with per-row needsAngles flags
- [ ] Accept where trailing `()` already exists → never `Foo()()`
- [ ] `Changed += OnChanged` accept → bare identifier, NO parens
- [ ] `nameof(DoSomething)` accept → bare identifier, NO parens
- [ ] `new Foo` accept → `new Foo(|)`, NO trailing `;` (initializers/terminator stay manual)
- [ ] `new List` accept → `new List<|>()` (construction suffix; still NO `;`)
- [ ] Statement-end call (`var x = GetUsers|`) → `GetUsers();` when `sharpsense.smartSemicolon` is on
- [ ] Field/property/parameter assignment target-typing (`numbers = new `) → offers `new List<int>()` at Index 0 from LHS type
- [ ] Property/field accept (e.g. `user.Length`) → NO parens
- [ ] Enum type accept (e.g. `DayOfWeek`) → bare, NO parens and NO `<>`
- [ ] `void Start|` (Unity) → NO parens
- [ ] Unimported-namespace method (accept adds a `using` above) → STILL decorated with `()`, not left bare
- [ ] Dropdown shows each symbol EXACTLY once (no duplicate rows) — the fix this build exists for
- [ ] Plain Enter with NO widget open inserts a newline (shadow never fires, never injects parens)
- [ ] Postfix still safe: `LoadAsync().await` + Tab/Enter → `await LoadAsync();` with NO extra `()` appended
- [ ] Output channel shows `accept: "getUser" R2 => decorated getUser R2 at L:C` per accept (rule tag R1–R5 on every verdict, always on)

## 1.3 Bracket lifecycle

- [ ] Type `()` then Left-arrow inside → `(|)`; Backspace deletes BOTH parens
- [ ] Same for `[]`, `{}`, `""` (and `<>` from a generic snippet)
- [ ] Backspace on a normal char still deletes one char (no hijack)
- [ ] Inside `Foo(a|)` press Tab → cursor jumps past `)` (no spaces added)
- [ ] Tab at normal indent position still indents (no hijack)
- [ ] Type `)` directly before `)` → cursor moves past, no duplicate `))`
- [ ] Same overtype for `]`, `}`, `>`, `"`
- [ ] Smart Backspace: `(   |   )` → first Backspace collapses to `(|)`; next deletes both
- [ ] Smart Backspace: leading-whitespace backspace collapses to previous tabstop (`backspace.unindentMode` defaults to `toProper`; verify `toTabstop` mode too)
- [ ] `backspace.unindentMode` = `toUnindent` aligns to previous non-blank line's indent
- [ ] `backspace.unindentMode` = `toProper` collapses to tabstop, then jumps to previous line's indent if applicable (JetBrains-style)
- [ ] `backspace.unindentMode` = `none` uses default one-char backspace
- [ ] Backspace on empty whitespace-only line deletes the line and cursor jumps to previous line at correct indent (all modes preserve deleted line's indentation)
- [ ] Smart Enter: `{|}` → expands to multiline block with cursor indented inside
- [ ] Smart Enter: single undo restores `{}`
- [ ] Smart Enter: `void Foo()|` (no brace on line) → expands to `{` next line (Allman) / same line (K&R) with cursor indented inside; respects `sharpsense.braceStyle`
- [ ] Smart Enter: `public Foo(string x)|` → same brace expansion, cursor inside block
- [ ] Smart Enter Option B: `void Foo() {|}` → does NOT duplicate `{`; just opens new line and indents
- [ ] Smart Enter: `var x = GetUsers|` (unclosed statement) → inserts `;` then Enter, cursor indented on next line
- [ ] Smart Enter: `DoSomething()` + Enter → `DoSomething();` with semicolon
- [ ] Smart Enter: line ending with `{` → does NOT add semicolon (let brace expansion handle it)
- [ ] Smart Enter: `class Foo|` (declaration) → does NOT add semicolon
- [ ] Smart Enter: `void Start|` (Unity) → does NOT add semicolon
- [ ] Smart Enter: `for (...)|` (cursor at end of header) → newline only, no brace inserted, cursor indented +1 tab stop from header; no rogue `{`
- [ ] Smart Enter: `if (cond)|`, `while (cond)|`, `foreach (...)|` → same as above
- [ ] Smart Enter: `for (...) {|` → opens new line indented inside block (Option B)
- [ ] Smart Surround selection: select `i += 5;` under `for (...)`, type `{` with K&R → `for (...) {` appended, statement indented +1 tab, closing `}` aligned with header
- [ ] Smart Surround selection: same with Allman → `for (...)` then `{` on next line aligned with header, statement indented, `}` aligned
- [ ] Smart Surround single `{`: type `{` on `i += 5;` line below `for (...)` (no selection) → merges into brace block aligned with header

## 1.4 Postfix templates + brace style

- [ ] `user.var` → `var name = user;` with `name` selected
- [ ] `user.if` → `if` block, cursor inside; honors `sharpsense.braceStyle`
- [ ] `user.null` / `user.notnull` → correct null-check blocks
- [ ] `users.foreach` / `users.for` → loops with placeholders
- [ ] `user.return`, `LoadAsync().await`, `user.throw`, `expr.as`, `expr.cast`, `x.switch`, `x.try`, `x.using`
- [ ] Set braceStyle `k&r` → `if (x) {`; `allman` → brace on next line; `inherit` follows the file
- [ ] `foo.Bar` normal member access still shows Microsoft members (postfix doesn't hide them)

## 1.5 Commit keys

- [ ] `Foo(|)` + `;` → `Foo();` (semicolon jumps past parens)
- [ ] `.` after an accept reopens the member list
- [ ] Enter/Tab commits from sections above all behave, no double-commit
- [ ] Enter commit: `sharpsense.completion.enterBehavior` = `insert` (default) → text to the right is preserved, suffix inserted at cursor
- [ ] Enter commit: `sharpsense.completion.enterBehavior` = `replace` → text to the right of cursor is overwritten, suffix replaces stale word remainder
- [ ] Tab commit: `sharpsense.completion.tabBehavior` = `replace` (default) → Tab overwrites trailing word chars before inserting suffix (e.g. `FooBar|` → `Foo()`)
- [ ] Tab commit: `sharpsense.completion.tabBehavior` = `insert` → Tab inserts suffix at cursor, preserving trailing text
- [ ] Output channel shows `accept: "getUser" R2 => decorated getUser R2 at L:C (replace=true/false)` per accept

## 1.6 Hardening + compatibility gate

- [ ] Unity message definitions (`Start`, `Update`) never get call-site parens
- [ ] Disable SharpSense in dev host, reload → vanilla Microsoft behavior everywhere
- [ ] Re-enable → Phase 1.x behavior returns, no errors in Extension Host output
- [ ] No perceivable typing latency on BOTH machines (desktop + school laptop)

Pass = all boxes ticked on both machines.
Next: Phase 2 (Base Solution Explorer) after review.
