---
status: accepted
---

# Dry Run prerequisites are fixed at startup

A Flow Skill may be taught after location selection or authentication has been prepared outside its Teaching Recording. A fresh Dry Run must prepare that state again. In [#336](https://github.com/akshat-OwO/contingency/issues/336), the maintainer chose to fix explicitly requested verified prerequisite Flow Skills at Dry Run startup. Adding, removing, or replacing prerequisites requires a fresh Dry Run. This keeps the setup contract reviewable before execution and prevents later Run updates from changing what the rehearsal depends on.

Prerequisite setup and the tested journey share one fresh browser context under the tested skill's saved Teaching Emulation and Teaching hosts. Referencing a prerequisite does not expand Domain Scope. Inputs belong to their declaring Flow Skill. Private inputs are supplied through Workspace when needed and entered by Variable reference. The tested skill's complete outcome remains the assessment target, and partial attempts or attempts with user Takeover cannot pass. User verification and Cleanup retain their existing meaning under ADR 0044 and ADR 0039.

This extends Dry Run setup without changing Interactive Run composition, Teaching Setup Variables, or Suite Setup.
