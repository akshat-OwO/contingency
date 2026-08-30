# External agents receive a bounded Teaching Feed

The external compiler agent receives a **Teaching Feed**, not the full Demonstration Trace. The feed contains user instructions, captured browser actions, Browser Snapshots, URL transitions, and screenshots with known sensitive fields masked. Known secret values become Variable references. The full Trace and video remain local, and MCP never returns cookies, authorization headers, or network bodies as Teaching input.

This boundary is best-effort rather than a claim of complete redaction: ordinary visible page content may still be sensitive, so Agent View tells the user that Teaching Feed content goes to the selected external agent. Returning the raw Trace was rejected because it includes unredacted DOM and network payloads; prompting before every observation was rejected because it would make interactive Teaching unusable.
