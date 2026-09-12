# Scroll targets a container and waits for bounded readiness

> Superseded by [ADR 0038](./0038-contingency-is-an-agent-sanity-monitor.md) for new work: this decision belongs to the removed deterministic Flow and Audit View stack.

A Scroll Step names the element it scrolls, omitting the target only for the document, and retains the relative wheel distance rather than an absolute scroll position. Replay moves the pointer onto the resolved target and dispatches a real wheel action. The Runner then waits for the scroll position to stabilize, for DOM mutations to stay quiet for 250 milliseconds, and for finite requests begun by the scroll to finish. The wait uses at most the smaller of two seconds and the Step's remaining timeout. If readiness cannot be proven, the Step succeeds with a structured diagnostic instead of hanging an infinite page or failing an otherwise valid Flow.

## Consequences

- Recording a container scroll must retain a locator for that container. Recorded pointer coordinates are not durable across responsive layouts, and Replay no longer depends on wherever the mouse happened to land after an earlier Step. The relative delta reproduces the author's gesture when preceding content has changed height, while a real wheel action still reaches virtual scrollers that listen for wheel input.
- Requests already in flight and long-lived connections do not hold the Scroll Step. Observation starts before the scroll so finite work triggered by it is not missed.
- Ordinary Steps and Pre-steps use the same Scroll contract.
- A readiness timeout is persisted only when it happens, with the wait duration and the remaining evidence that prevented settlement. It is not a Finding, cannot breach a Gate, and does not change the Run outcome.
- This is page readiness, not video pacing. The Runner waits for evidence that the action it just performed has taken effect; it does not sleep between arbitrary Steps.
