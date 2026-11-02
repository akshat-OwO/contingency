---
name: example-broken-cart
description: Example. Add one Ridgeline Hardware product to the cart and confirm the cart lists it. The Example Run starts with the store's deliberate Add to cart fault switched on, so the expected result is a reported failure with evidence.
inputs:
  - name: product
    description: The product name as the store lists it, such as Cedar Pull Saw.
hosts:
  - ridgeline.localhost
emulation:
  userAgentProfile: default
  viewport: 1280x800@1
---

# Identify a broken cart

This is a bundled Example Flow Skill for the Ridgeline Hardware demo store. It is read-only, it is not user-verified, and its authority ends at the demo store. Targets are listed in [references/accessibility.md](references/accessibility.md).

The Example Run opens the store with a deliberate fault: Add to cart looks successful but leaves the cart unchanged. A banner named "Demo fault" says so. The banner is a label, not proof. Prove the outcome from the cart itself.

1. Open the store's Shop page, where the Run starts.

   Done when: the page shows the "Products" heading.

2. In "Products", select "Add {{product}} to cart".

   Done when: the status line reports that {{product}} was added.

3. Select the Cart link in the store navigation.

   Done when: the "Your cart" page shows whether {{product}} is in Items. With the fault on, the page reads "Your cart is empty." Report that as the observed failure and cite the Snapshot.

4. In the "Demo fault" banner, select "Restore healthy store".

   Done when: the banner is gone. The store is healthy again in this browser only.
