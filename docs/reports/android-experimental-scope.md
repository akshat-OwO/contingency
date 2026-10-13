# Experimental Android with stock agent-device

Start with the unmodified, pinned agent-device package behind Contingency's Effect services. Do not make custom text transport, a helper fork, or upstream extension acceptance prerequisites for this experiment. The purpose is to make Android sessions useful and learn which missing capabilities prevent real journeys. This is a proposed implementation scope, not shipped support.

## First milestone

Support a user-selected, prepared local emulator, starting with the evaluated Pixel_9 API 36 configuration. Open an experimental Android Agent Session, observe its UI, capture screenshots, and perform basic semantic taps, navigation, and ordinary non-secret text entry through the public Node API. Use the API's current target references and failure information. Keep the agent-device package and bundled helper unmodified.

Support the complete Contingency journey for those capabilities: teach through the mirrored Workspace screen, learn an Android Flow Skill, execute a Dry Run, inspect its evidence, and let the user verify or reject the Flow Skill. Use non-secret fixture inputs for the first journey. Experimental describes the supported platforms and capabilities; it does not remove Teaching or verification from the product.

Contingency owns its adapter state and lifecycle through Effect and Effect Atom. It binds the session to the selected host and serial, obtains helper installation or replacement consent before any operation that can install a helper, and closes only its owned session resources. A disconnect pauses the session. Recovery revalidates that same device and takes a fresh observation; it never chooses another device or blindly repeats an uncertain failed command.

Request known app launches only within the session's declared app scope. Check available foreground and window evidence before and after input; pause on an unexpected app or ambiguous ownership. Record these checks as host-side experimental checks. The stock backend does not supply Contingency's atomic observation-bound device-dispatch contract. Do not advertise the web Execution Boundary or equivalent guarantees for this mode. Restrict exposed commands to the evaluated operations; do not expose arbitrary ADB, package-management, batch, replay, or hub input routes.

Record forwarded Workspace actions with before-and-after observations during the Teaching interval. Start all retained sources at Start recording and stop them at Stop. Treat screenshots and raw observations as sensitive local data. Preserve the existing verify-then-purge Cleanup lifecycle for Teaching and Dry Run evidence. Ordinary text entry does not claim the private Variable guarantee. Do not offer secret Variable requests or route a secret Variable through ordinary text entry. A journey requiring one is unsupported in this milestone.

A Dry Run must establish its declared starting state on the selected emulator, using one supported baseline or an explicit reproducible setup procedure. Preparation failure blocks the Run. Capture loss makes Teaching incomplete; an unobservable or uncertain outcome cannot pass verification. Those requirements are Contingency integration work, not reasons to require private text customization upstream.

## Features to defer

- Private Variables and private-input comparison. Public fixture values can exercise text entry; secret inputs remain unavailable until a safe path is verified.
- Observation-bound coordinate actions. Add them only with a truthful supported contract and proof. Basic semantic actions still have the stock backend's documented limitations.
- Broad emulator configuration support, physical-device qualification, and cross-app or necessary-system-dialog authorization. Support one proved preparation path for the initial emulator and pause when the declared app scope is left.
- Web feature parity. Missing Android capabilities must be explicit in startup, UI, and agent responses rather than silently ignored.

These are staging choices. If a later milestone needs one of them, reassess that requirement then. Do not begin a broad upstream contribution or a helper fork solely to complete a checklist before the experiment is useful.

## Shipping proof

Before exposing the experiment, verify selection, installation consent, observation, semantic input, non-secret field readback, unexpected-app pause, disconnect, fresh recovery, and owned cleanup through the live Contingency entry point. Capture isolated command journals and second observations. Test browser behavior for regressions and keep Android support opt-in and visibly experimental. The earlier backend-only Pixel_9 receipt does not satisfy this product integration proof.

Also prove the complete non-secret checkout journey through Workspace Teaching, Flow Skill learning, preparation of a fresh Dry Run, user verification, saved-skill execution, and evidence Cleanup. A changed successful app build and a deliberately broken build must exercise both success and failed-outcome detection. Verify capture intervals and loss handling. Evaluate expo-device-hub separately as the stream implementation, but ship a working mirrored Teaching path in this milestone; semantic backend proof alone is insufficient.

Pin the package version and helper identities used by the adapter. The evaluation exercised 0.21.25; 0.21.27 received source inspection only. An upgrade needs its own applicable integration proof. Prefer public exports and avoid private source imports or runtime package patches.

## Relation to the full Android design

[ADR 0058](../adr/0058-android-is-the-next-platform-runtime.md) remains the target for the full Android capability set, including private login. The experimental release keeps its Teaching and verification journey while using non-secret inputs and a narrower device and action set. Android Verified Flow Skills apply only to the tested Android environment and supported capabilities; they do not claim web parity or verification of unsupported secret-input journeys. The proposed [ADR 0060](../adr/0060-use-stock-agent-device-for-an-experimental-android-runtime.md) records the staged private-input and dispatch guarantees; issue 457 remains the completion tracker.

The [upstream investigation](android-upstream-extension-investigation.md) records possible improvements when a deferred capability becomes necessary. It is not a shipping dependency for the experimental milestone. Reconsider a small contribution or helper fork only against a concrete blocked feature and its maintenance cost.
