# Bundled onboarding examples

Status: accepted with [the onboarding design](./agent-onboarding.md). Implementation has not started.

## A store gives the examples one setting

A small local hardware shop demonstrates several capabilities without real accounts or purchases. It is called Ridgeline Hardware. Its pages cover products, a delivery-area picker, a cart, demo sign-in, and orders. Each page identifies the site as a demo.

The default example is adding a product, choosing a delivery location, and inspecting the cart. It demonstrates the core claim: Teaching produces instructions that work with different inputs. The other examples are optional choices.

| Example | What the user watches | Variation the user teaches | Observable result |
| --- | --- | --- | --- |
| Add a product for delivery | The agent chooses a product and delivery area, then opens the cart. | Another product, city, or area. | The cart names the chosen product and delivery location. |
| Complete a signed-in task | The agent requests a synthetic password through Workspace, signs in, and starts a return. | Another demo order or return reason. | The return confirmation identifies the selected order. The Flow Skill declares its private input. |
| Check a journey with a scan | The agent runs the cart journey and performs a required accessibility scan. A performance scan is an optional variant. | A different cart journey with a scan required at the chosen outcome. | The Run includes a completed Scan Report. Documented accessibility findings can remain while the journey passes. |
| Identify a broken journey | A deliberate add-to-cart fault leaves the cart unchanged. The agent reports the failed outcome with browser evidence. | The healthy cart journey after reset. | The failure report cites observed behavior; the learned variation passes on the healthy site. |

The demo should keep these tasks small. Every visible control in the shipped journeys works. The developer fixtures' inert controls, test telemetry, delayed-rendering cases, and secret echoes are outside this proposal.

## Prepared skills need an explicit origin

The current [requested skill resolver](../../packages/cli/src/services/requested-flow-skills.ts) accepts verified catalog skills. [Run-time private inputs and scans](../../packages/cli/src/services/mcp-agent-run.ts) require a `flowSkillName`; scans also require a declared `requirementId`. A plain task Run can demonstrate the core journey and a visible failure, but cannot demonstrate all the selected capabilities during the watch phase.

Contingency ships read-only Example Flow Skills with an explicit bundled origin, an Example label, and authority limited to the demo site. They remain outside the user's catalog and never claim user verification. The user then teaches a variation, which becomes an ordinary drafted Flow Skill and follows the existing Dry Run and explicit verification lifecycle. This extends the resolver deliberately rather than manufacturing verification files for bundled content. See [ADR 0050](../adr/0050-bundled-example-skills-have-distinct-authority.md).

The rejected alternative was a plain task demonstration for the core and failure examples, with private inputs and scans shown only after the user teaches. It reduced implementation scope but weakened the agreed watch-then-teach experience for those examples.

The user's learned demo variations and demo Run evidence stay clearly identified in the current catalog. Bundled source examples stay outside that catalog. Return visits recognize demo work as existing work and offer to continue, try another example, or teach on the user's website.

## Failure is a controlled example condition

An explicit demo URL activates a fault in that browser context. A visible banner identifies the fault and offers a healthy-state reset. The agent still proves failure through actual cart behavior and Snapshot or attempt references. The banner alone does not prove the journey failed.

The next Teaching session opens the healthy URL in a fresh context. Fault state stays in browser storage, so one session cannot break another session's example. The failed prepared Run is an expected demonstration result, not an onboarding failure. The user's variation still needs a passing Dry Run and explicit verification.

After verification, the agent offers to run the user's learned skill against an applicable deliberate fault. This optional Interactive Run demonstrates the user's own skill detecting a failure. The agent reports observed evidence and restores the healthy state afterward. It offers this action only when the available fault affects that learned journey. The Run does not undo verification or make onboarding incomplete.

## Local hosting must preserve scope and reuse

[Domain Scope](../../packages/cli/src/services/domain-scope.ts) compares hostnames rather than ports. Serving the demo under a distinct loopback hostname can separate demo skills from other local applications. The proposed `ridgeline.localhost` hostname requires browser resolution and routing verification before shipping; its availability is not established by this proposal.

Demo URLs use the port actually acquired by the process. Saved demo skills need a declared URL input or supported Run URL override that uses the current launch's origin. Reuse must not depend on the previous launch's port still being available. Browser contexts start clean for the prepared Run, Teaching, and Dry Run.

## Connect the example to the user's work

After verification, the agent offers the applicable failure rerun, another example, or a similar journey on the user's website. It can make the invitation concrete: a purchase or sign-up path, a task behind sign-in, a page that needs a scan, or a journey whose failure matters to the user.

The demo skill retains its taught hosts. Applying the idea to another website requires new Teaching on that website.

## Proof before shipping

Every example must support its watch, Teaching variation, automatic Dry Run, and explicit verification path. The scan and private-input examples must use the normal capability contracts with the bundled origin supported explicitly. The optional failure rerun must report a real observed failure and restore the demo without changing the user's verification.

The dedicated loopback hostname, runtime URL resolution, clear demo identification in the catalog and reports, and state isolation between concurrent sessions need end-to-end verification. These are implementation requirements, not established behavior of today's CLI.
