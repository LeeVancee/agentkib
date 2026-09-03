# Domain Docs

This repo uses a single-context layout.

## Before exploring, read these

- `CONTEXT.md` at the repository root, if it exists.
- Relevant decisions under `docs/adr/`, if that directory exists.

If these files do not exist, proceed silently. Create them lazily when domain terms or architectural decisions are actually established.

## File structure

- `CONTEXT.md` — shared project domain language and concepts.
- `docs/adr/` — system-wide architectural decision records.

## Use the glossary vocabulary

When naming domain concepts, use the terminology defined in `CONTEXT.md`. If a needed concept is missing, record that as a domain-modeling gap.

## Flag ADR conflicts

If proposed work conflicts with an existing ADR, surface the conflict explicitly instead of silently overriding it.
