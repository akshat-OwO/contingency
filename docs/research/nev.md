# Nev benchmark results

Nev-0.8B is a small decision model that picks the next browser action for a Flow Skill step. It is published at [akshat-OwO/nev-0.8b](https://huggingface.co/akshat-OwO/nev-0.8b). Its test data and the scripts that rebuild every number below are at [akshat-OwO/nev-bench](https://huggingface.co/datasets/akshat-OwO/nev-bench). The live Flow Skill benchmark and the crawler are in [`packages/cli/tests/benchmarks`](../../packages/cli/tests/benchmarks).

## Steps fully right

A step counts only when its operation and its target element are both correct. "Explicit" steps name the element, as Flow Skill steps do. "Goal only" steps give only the task. Every test set uses websites, or whole domains, that never appear in training. Numbers in brackets are steps scored.

| Test set | Nev-0.8B | Jev | Kev-0.8B | Laya |
| --- | --- | --- | --- | --- |
| Mind2Web, unseen websites, explicit | **91.0** (289) | 87.8 (400, Zen free) | 6.7 (386) | 2.7 (300) |
| Mind2Web, unseen domains, explicit | **92.3** (299) | **92.3** (300, paid) | 6.8 (399) | 5.7 (300) |
| Mind2Web, unseen websites, goal only | 39.7 (287) | **53.5** (400, Zen free) | 0.0 (384) | 2.0 (300) |
| Mind2Web, unseen domains, goal only | 34.0 (297) | **52.0** (300, paid) | 1.0 (397) | – |
| nev-bench `heldout/test` | **76.9** (297) | 74.0 (300, paid) | – | 19.7 (300) |

- **Jev sources.** "Zen free" is OpenCode Zen's `jev-1.13-free`. "Paid" is TypeSafe's `jev-latest`. The free tier returns HTTP 429 after about 1,200 requests.
- **Laya** shows its better result of the English checkpoint at 512 tokens and the multilingual checkpoint at 8,192 tokens. These requests run 2,000 to 5,000 tokens with up to 120 options, outside the setting Laya was trained for.
- **Samples.** Each Mind2Web row scores a prefix of the ID lists in nev-bench. Smaller samples are prefixes of larger ones.

## General decisions

On 491 questions from Kev's `decision-v7` development set, Nev scores 82.3% and Kev-0.8B scores 83.3%. The difference is within the standard error of about 1.7 points. The fine-tune mixed in 1,000 of Kev's own training records to keep these skills.

## Live Flow Skill runs

Measured with `jev-fast-loop.ts` on an Apple M5, with Nev running locally through MLX.

| Flow | Nev-0.8B | Jev (Zen free) |
| --- | --- | --- |
| Demo `example-delivery-cart`, 9 runs | 9 passed, 7.7 to 8.9 s per run | 9 passed, median 8.6 s |
| Demo `example-broken-cart`, 3 runs | 0 passed | 0 passed |

Both models fail `example-broken-cart` at the step that must confirm a banner is gone.

The loop treats a step with no action yet as done only at a `done` probability of 0.9 or higher, and at 0.5 after its first action. A literal reading of a `Done when:` condition can hold before the step's work happens, for example a search box that is visible before its city is chosen.

## Pursuits

Measured with `pursuit-loop.ts`, which hands a Flow Skill's steps to `agent_browser_pursue` ([ADR 0057](../adr/0057-system-one-pursues-delegated-sub-goals.md)) in one call, and with the 1mg manual-location Flow Skill driven by Claude as the external agent. Nev ran locally on an Apple M5.

| Flow | Jev (TypeSafe paid) | Nev-0.8B |
| --- | --- | --- |
| Demo `example-delivery-cart`, one call per run | 3 of 3 passed, 6.9 to 7.1 s per run | 9 of 9 passed, 7.6 to 7.8 s per run |
| Demo `example-broken-cart` | 0 passed, `blocked` at the banner step | 0 passed, `unsure` at the banner step |
| 1mg manual location, one call | stops at step 3 | all 5 steps done |

On 1mg the external agent took 68.3 s and 15 tool calls acting alone. One Pursuit on Nev took 32.1 s from the Run's start and 2 tool calls, including closing two popups. One Pursuit per step took 71 to 75 s, because each step still cost an agent turn.

Both models judge outcomes worse than they choose controls. Nev called the delivery step done at 0.62 before saving the location, and a 1mg step done at 0.93 before confirming it. Jev never selects a 1mg search result a second time when the first click leaves it unchanged; Nev does. A Pursuit therefore reads quoted outcome text and covering popups in code, and gives System One only the controls the agent could reach. Neither model can tell that the demo's banner is gone unless `doneWhen` quotes its text.

A Jev request takes 0.34 s at the median and a Nev request 0.31 s. In a Pursuit, acting and waiting for the Page to settle take most of the time: about 0.85 s per action on the demo store.

## Latency per request

| Model                        | Time          |
| ---------------------------- | ------------- |
| Nev-0.8B on an Apple M5, MLX | 0.35 to 0.6 s |
| Jev, TypeSafe paid           | about 0.4 s   |
| Jev, Zen free tier           | 0.65 to 1.2 s |

## Run the live benchmark

With Nev running on port 8009 (see the model card), run this from the repository root:

```sh
JEV_PROVIDER=local JEV_BENCHMARK_REPEATS=3 nub packages/cli/tests/benchmarks/jev-fast-loop.ts
```

The script starts the bundled demo store and drives its Example Flow Skills through Contingency's MCP tools. Results go to `.cursor/skills/verify-contingency/artifacts/jev-fast-loop/`. To run Jev instead, set `JEV_PROVIDER=typesafe` and `TYPESAFE_API_KEY`.

To measure Pursuits, point Contingency at the endpoint the way `contingency mcp` reads it. `PURSUIT_MODE=steps` makes one call per step instead of one per run:

```sh
CONTINGENCY_SYSTEM_ONE_URL=http://127.0.0.1:8009 PURSUIT_BENCHMARK_REPEATS=3 nub packages/cli/tests/benchmarks/pursuit-loop.ts
```

For Jev, use `CONTINGENCY_SYSTEM_ONE_URL=https://api.typesafe.ai` and set `CONTINGENCY_SYSTEM_ONE_API_KEY`. Results go to `.cursor/skills/verify-contingency/artifacts/pursuit-loop/`.
