# Manual Checklist — Smart Enter And Backspace

Run with **F5** (`Run Smart Enter And Backspace Extension`). Use `smartEnterAndBackspace.verboseLogging`
to see decisions in the **Smart Enter And Backspace** output channel.

## Braced languages (C#, Java, TypeScript, Go, Rust, …)

- [ ] `void Foo() { | }` + Enter → block expanded, cursor indented one level inside.
- [ ] `void Foo()|` + Enter → Allman: `{` on next line; K&R: ` {` appended.
- [ ] `for (int i = 0; i < 5; i++)|` + Enter → new line indented one level, **no `{` inserted**.
- [ ] `if (x)|` + Enter → same; typing `{` afterwards produces a normal block.
- [ ] `DoThing()|` + Enter → `;` appended, new line at the same indent.
- [ ] `int x = y` (missing `;`) + Enter → `;` inserted.
- [ ] Type `)` when `)` already follows → no duplicate.
- [ ] Type `(` directly before `()` → steps inside, no `(())`.
- [ ] `Get()|;` then type `.` → `.` replaces the `;`.
- [ ] Select two lines, type `{` → both wrapped, braces aligned, cursor inside.
- [ ] Statement under an unbraced `for (...)` header, type `{` → merged into header block (K&R and Allman).

## Backspace — braced

- [ ] `(   |   )` + Backspace → `(|)`; again → deleted pair.
- [ ] Backspace at 8 spaces of indentation with `toTabstop` → 4 spaces remain.
- [ ] Backspace inside leading whitespace with `toUnindent` → previous non-blank line's indent.
- [ ] Backspace at start of a whitespace-only line with `toProper` → line removed, joined above.
- [ ] Backspace at col 0 of a blank line → line removed in one stroke.

## Indented languages (Python, YAML, Ruby, F#)

- [ ] Enter after `def foo():` → native auto-indent only, no braces, no semicolon.
- [ ] Enter after `if x:` → native auto-indent, no brace block.
- [ ] Typing `{` → native insert only (no surround).
- [ ] Backspace inside an over-indented line → snaps to the nearest enclosing indent
      (e.g. col 8 → 4 when the parent is at 4, not a fixed tab stop).
- [ ] Backspace at col 0 of a blank line → native line join (not erased).
- [ ] `smartEnterAndBackspace.backspace.indentedLanguagesUseNearestIndent` = `false` →
      falls back to the configured unindent mode.

## Generic languages (Markdown, plaintext)

- [ ] Enter → native newline only.
- [ ] Backspace pair/interior helpers still work.

## Settings

- [ ] Each `smartEnterAndBackspace.*` switch disables its behavior when turned off.
- [ ] `braceStyle` = `allman` / `k&r` / `inherit` behaves consistently across the file.
