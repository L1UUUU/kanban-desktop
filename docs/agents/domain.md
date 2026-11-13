# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root
- **`docs/adr/`**: read ADRs that touch the area you're about to work in

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## The planning flow doesn't write domain docs — route them yourself

`/design-feature` and its downstream `/to-spec` / `/to-tickets` produce spec + tickets only; they never write `GLOSSARY.md` or ADRs. But planning is exactly where terms and decisions get resolved. When the confirmed plan locks one in, don't leave it only inside the spec issue — capture it with `/domain-modeling`:

- A decision that changes state ownership or invariants, locks an external behavior contract, or reverses an `.out-of-scope/` entry → `docs/adr/`
- A term newly introduced or first agreed during planning (it will echo through spec, tickets, and code naming) → `GLOSSARY.md`

This stays lazy: write only what was actually resolved and confirmed, no placeholder ADRs or glossary stubs.

## File structure

This repo is **single-context**:

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
