# Targets

- role=textbox name="Email" context="Sign in form"
- role=textbox name="Password" context="Sign in form; the value is private"
- role=button name="Sign in" context="Sign in form"
- role=link name="Start a return for {{order}}" context="Your orders table"
- role=combobox name="Return reason" context="Return form"
- role=button name="Submit return" context="Return form; starts a return"
- role=heading name="Return started" context="Confirmation section after submitting"

## Why these targets are stable

Form fields use visible labels, and each return link carries its order number. The confirmation heading is fixed text.
