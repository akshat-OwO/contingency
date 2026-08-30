# Suite Setup seeds isolated member contexts

A **Suite** may declare one **Suite Setup** Agent Flow, typically login. The Runner executes it once, captures the resulting browser storage state in memory, and seeds a fresh isolated browser context for every Suite member. Members run sequentially in Suite order. The setup state is scoped to that Suite Run and discarded during cleanup. If setup is `not-working` or `inconclusive`, the Runner does not execute members and reports Suite coverage incomplete.

Running every member in one browser context was rejected because earlier sanity journeys would contaminate later ones and make results depend on order. Repeating login in every isolated member was rejected because MFA and other human intervention would make broad sanity Runs needlessly expensive. Suite Setup pays that cost once without turning a browser profile into persistent catalog data.
