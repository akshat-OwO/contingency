# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Priority

Priority is separate from the triage role above: the role says what the issue needs next, the priority says how much it matters. An issue carries at most one.

| Label           | Meaning               |
| --------------- | --------------------- |
| `high-priority` | Needs attention first |
| `med-priority`  | Normal priority       |
| `low-priority`  | Default priority      |

**Every issue is low priority unless it says otherwise.** An unlabelled issue is low, so `low-priority` never has to be applied to mean "ordinary" — label an issue only when raising it to `med-priority` or `high-priority`. Nothing enforces this, which is why the default is the absence of a label rather than a label someone must remember.

Raise the priority for what the issue costs the user, not for how interesting it is:

- `high-priority` — a user-facing path is blocked or silently wrong: work is lost, a gesture cannot be performed, or a contract the product publishes is not the one it honours.
- `med-priority` — the path works but the user pays for it, in repeated effort or in a workaround they must remember.

Say why in the issue body rather than only in the label, so the priority survives a reader who disagrees with it.
