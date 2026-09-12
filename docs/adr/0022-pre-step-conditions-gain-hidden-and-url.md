# Pre-step conditions gain selectorHidden and urlMatches

> Superseded by [ADR 0038](./0038-contingency-is-an-agent-sanity-monitor.md) for new work: this decision belongs to the removed deterministic Flow and Audit View stack.

`PreStep.when` accepts `selectorHidden` and `urlMatches` alongside the original `selectorVisible`. The same condition machinery backs the `waitFor` Step introduced in [ADR 0011](./0011-flow-is-a-native-format.md).

## Consequences

- **`selectorHidden` is the missing half of the case Pre-steps exist for.** "Click Accept if the cookie banner is visible" needs `selectorVisible`; "wait until the banner is gone before auditing" needs `selectorHidden`. Without it, an accessibility Audit can run over a modal overlay and report the overlay's problems instead of the page's — a Finding about the wrong document entirely.
- **`urlMatches` answers only whether the current URL matches.** It does not add a page-load barrier after the match. A Flow that needs the next Step to observe particular DOM content waits for that content with `selectorVisible`; keeping readiness separate makes the condition mean the same thing in a Pre-step and a `waitFor` Step.
- **A condition expression language was rejected.** Conditions stay a closed set of named types. A general expression language turns a Flow field into a product surface with its own parser, semantics, and errors, for cases nobody has yet.
- **Pre-step semantics are untouched.** A condition that cannot be evaluated at all remains distinct from one that evaluates false ([ADR 0009](./0009-run-execution-semantics.md)): an unanswerable condition is not evidence that the interference was absent.
