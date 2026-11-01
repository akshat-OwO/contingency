# Writing

Choose a primary document mode using Diátaxis. A tutorial teaches by doing: say what the reader will build, use commands, and show a visible result at each step. A how-to solves a task for a competent reader; allow relevant conditions and choices without teaching the background. A reference describes facts, options, limits, and errors for lookup, following the structure of the thing described. An explanation answers a bounded why question with context, constraints, and trade-offs. Keep modes distinct; put interrupting background or detailed lookup material elsewhere. PR descriptions and commit messages are briefings, not document sets. Product UI copy follows its own needs.

Address the reader as "you" and use present tense. Prefer active voice and name the actor: "The compiler checks the schema." Use passive voice when the actor is unknown or immaterial. Write instructions as commands, with the condition or warning first and the common case before exceptions. Avoid "please", "simply", and promises about future behavior in procedures.

Give each instruction its own sentence and each other sentence one thought. Review instructions over about 20 words and other sentences over about 25 for splitting; these are prompts, not quotas. Keep a longer sentence when it carries one thought clearly. Cut words that do no work, but retain the small words that make meaning clear.

When editing, preserve the task's meaning, scope, conditions, required evidence, and factual uncertainty. Improve the wording without inventing facts or adding work. A command mentioned as a source of information is not automatically an instruction to run it.

Place modifiers such as "only" beside what they modify. Give pronouns one obvious referent, repeating the noun if needed. Keep articles and verbs where omission creates ambiguity. Break up long noun strings and make the scope of "and" and "or" explicit. Use one name for each thing and one word for each action. Write actual symbols, paths, flags, commands, and UI labels rather than invented synonyms. Check examples and claims against their sources. Verify counts and trees at the revision that lands them, and include the command that regenerates them. Avoid rewriting unchanged prose without a reason.

Use descriptive sentence-case headings, a single top-level heading, and a consistent hierarchy. Use numbered lists for sequences and bullets for unordered items. Introduce lists with a complete sentence and keep items parallel. Use descriptive link text, code formatting for code, and bold for UI labels. Use serial commas and identify partial lists instead of adding "etc."

## Edit for natural voice

Read the draft aloud in the intended voice. Mix short and longer sentences. Be specific: "A column rename fails the build" tells the reader more than "Schema changes can cause issues." Explanation can weigh trade-offs and express an opinion; reference stays factual. Use first person when it fits the audience and purpose. Do not make every sentence clipped or every section mechanically symmetrical.

Replace filler and fancy synonyms with plain words: "use" for "utilize", "because" for "due to the fact that". Prefer a strong verb or a measured result to an adverb. Name the source behind a claim instead of saying "experts believe". Remove puffery, promotional claims, formulaic challenges, unsupported hedging, and abstract metaphors such as "substrate" or "ratchet" when a concrete name or mechanism will do.

Check for patterns that obscure the point: false "from X to Y" ranges, forced groups of three, synonym cycling, "not just X, but Y" contrasts, and substitutions such as "serves as" for "is". Delete superficial trailing phrases such as "highlighting" or "ensuring", or explain the actual consequence. Remove canned chatbot praise, filler, and generic conclusions. State the fact, action, or specific next step instead.

Use straight quotes and sentence case. Avoid em dashes and dash substitutes; use a period or comma. Use colons for lists or examples, not as a habitual connector. Avoid decorative emoji, excessive bold, and bold labels that merely repeat the following sentence. Keep formatting useful to the reader.

## Write for agents

Write direct, positive actions and retain necessary guardrails. For each step, state a checkable completion condition that covers all required work and evidence. A demanding criterion such as "account for every modified model" prompts more legwork than "produce a list". Apply the same exhaustiveness to reference rules when there is no sequence.

Give each numbered agent step its own completion line, rather than one condition for the whole procedure. For example: "Done when: every modified model has its affected caller and verification evidence recorded." Preserve every required part in the condition; listing models alone does not establish caller coverage or verification.

Separate ordered steps from material consulted on demand, and keep each concept's definition, rules, and caveats together. Inline what every branch needs. Place branch-specific detail behind a concise pointer that names the material and gives a distinct trigger for each branch. Collapse synonymous triggers. If a pointer fails to reach necessary material, sharpen it before inlining the material.

Balance context load against human effort: always-loaded text consumes attention on every run, while material behind a pointer requires someone to know when to find it. Split or disclose material when a branch or sequence earns that cost, not merely to shorten a file. If a step is rushed, first sharpen its completion condition. Split the sequence only when the condition remains fuzzy and rushing is observed; hiding later steps works only across a real context boundary, such as a hand-off, not an inline call.

Use established, meaningful terms consistently in pointers and bodies so they cue the intended behavior. Define a term when needed; do not invent jargon to save words. Keep one authoritative source for each rule. Treat configuration, scripts, directory layout, and command help as sources of truth, and document the conventions and reasons they cannot reveal. Remove stale, duplicated, and irrelevant material. Test suspected no-op instructions against actual agent behavior, since whether a line changes the default depends on the model.
