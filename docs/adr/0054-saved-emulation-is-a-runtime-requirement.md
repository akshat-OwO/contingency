---
status: accepted
---

# Saved emulation is a runtime requirement

Flow Skill emulation determines the environment before a Run's first request and document. The runtime reads it from the saved package. Agents do not supply copied environment arguments to skill-backed startup.

A skill with no declared emulation imposes no environment requirement. A task without any declared environment uses the default browser. A declared environment requires a valid viewport, a supported identity, coherent permission decisions, and valid optional fields. Malformed scalars, duplicate fields, unknown fields, invalid locale or timezone, and retired identities return an explicit error. They never silently select a different device or drop a location. This replaces the previous fallback for retired identities and incomplete declarations.

Starting skills with declared environments must agree. Startup chooses the first declared environment, even when an earlier legacy skill has none, and rejects conflicting requirements before opening a browser. Permission ordering does not change the environment. Snapshots and persisted task Run evidence retain the effective starting emulation and its source: default, a Flow Skill, or the Teaching Recording for a Dry Run. Historical records remain readable without invented provenance.

Under ADR 0044, later skills share the existing browser, tabs, authentication, and environment. Adding a different skill records its differing fields and a recovery instruction in the Run. Compact responses expose that evidence too. The agent can continue the requested composed task where that environment is acceptable, or start a separate Run to reproduce the later skill's environment. The runtime never resets a composed browser to resolve a mismatch.

Browser identity and language travel together in the CDP user-agent override. Otherwise installing a mobile identity resets `navigator.language` despite the browser context's locale. The saved language accompanies every page's identity before navigation, preserving the first request's Accept-Language and the first document's language alongside touch and mobile signals.

The verification fixture reports signals captured in its first document and its actual geolocation permission result. Coverage checks mobile viewport and scale, identity headers, touch, locale, timezone, color scheme, coordinates, grant and denial, saved provenance after reopening evidence, and conflicting composed skills.
