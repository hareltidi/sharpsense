# Unity Message Completions — Why SharpSense Does NOT Implement These

**Status:** Decision record — feature deliberately **not** built.
**Decided:** 2026-09-15 (during planning, before any implementation).

---

## Decision

SharpSense will **not** implement Unity "magic message" completions (`Start`, `Update`,
`OnCollisionEnter`, `OnStateEnter`, etc.) as its own feature. The scope-aware detection,
base-type filtering, and message catalog that such a feature requires are **already provided
by the official Unity extension for Visual Studio Code**, which SharpSense runs on top of.

## Why (the evidence)

The Unity extension for VS Code — built on the C# Dev Kit and C# extensions, the same base
SharpSense depends on — lists among its features:

> *"Intellisense for Unity API Messages."*

[Unity extension for VS Code](https://marketplace.visualstudio.com/items?itemName=Unity.unity-vscode) — *"Intellisense for Unity API Messages"* is a first-class, shipped capability. It is
scope-aware (it knows the enclosing class derives from `MonoBehaviour` / `ScriptableObject` /
`Editor` / etc.) and backed by the real Unity type model, including cross-file/partial-class
awareness that a supplemental provider in SharpSense could only approximate.

## Why building it would violate SharpSense's own architecture law

From `CLAUDE.md` / `Docs/sharp-sense-spec.md`, SharpSense is a **companion** to C# Dev Kit + C#,
not a replacement:

- It contributes **zero plain-symbol rows**; it shadows/extends, never duplicates, Roslyn.
- **Roslyn is the sole semantic source** — no fork, no second type model.
- Features are meant to fill gaps the base tooling leaves, not re-implement what it already does.

A custom Unity-message provider would:
1. **Duplicate** the Unity extension's message IntelliSense (which is the harder, scope-aware part).
2. **Re-implement Unity base-type detection** that the Unity extension already does correctly —
   including the cross-file/partial-class cases our design flagged as unsolvable in Phase 1.
3. Ship a worse copy of a feature the platform owns, increasing maintenance with no user benefit.

## What we explored (and set aside)

During planning we produced a full design (taxonomy of ~80 messages across `MonoBehaviour`,
`ScriptableObject`, `Editor`, `EditorWindow`, `StateMachineBehaviour`, `NetworkBehaviour`;
a tiered detection model TIER 0/1/2 for "knowing for sure it's a Unity class"; a
`registerUnityMessagesProvider` mirroring `registerLiveTemplateProvider`; duplicate
suppression; ghost-free single-stop insertion). The design was sound — but the *entire premise*
(a VS Code gap) was invalidated by the Unity extension's shipped capability, so the work is not
carried forward.

## Possible triggers to revisit

Reopen this only if a concrete, verified gap appears:
- The Unity extension **removes** "Intellisense for Unity API Messages," or stops being scope-aware.
- A confirmed absence of **already-defined-message suppression** or **ghost-free insertion** in the
  Unity extension, where a *thin* SharpSense layer (not a full reimplementation) would add value.
- A Unity-class scenario the base tooling provably mishandles (then fix narrowly, not broadly).

Until then: rely on the Unity extension for message completions; SharpSense stays focused on the
gaps it was built for (JIT `new`/class/struct/record templates, postfix, ghost-free generics,
bracket lifecycle).
