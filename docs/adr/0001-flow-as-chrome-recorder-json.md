# Flow is Chrome DevTools Recorder JSON plus Contingency extensions

> Superseded by [ADR 0011](./0011-flow-is-a-native-format.md): Chrome's action model proved to be the constraint this ADR anticipated, and import compatibility was not worth its price.

Contingency's durable artifact is a **Flow**. Rather than invent a parallel recording format, a Flow is Chrome DevTools Recorder–compatible JSON with Contingency-specific fields (Pre-steps with explicit conditions, Audit custom Steps, and related metadata). Plain Chrome Recorder exports are valid Flows that simply omit Contingency fields. This maximizes import compatibility and keeps Create View's recorder aligned with a format users already know, at the cost of carrying Chrome's action model as a long-term constraint.

## Considered Options

- **Import-only conversion** into a proprietary Flow model — cleaner internal types, permanent dual format and conversion bugs.
- **Peer formats forever** — Contingency Flow and Chrome JSON both first-class — doubles Runner and UI surface.
- **Native Chrome-compatible JSON (chosen)** — one artifact shape; Contingency extends what Chrome ignores.
