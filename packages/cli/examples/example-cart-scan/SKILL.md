---
name: example-cart-scan
description: Example. Add one Ridgeline Hardware product, open the cart, and run the required accessibility scan once the cart lists the product. Use to show a Scan Requirement in a Run.
inputs:
  - name: product
    description: The product name as the store lists it, such as Garden Trowel.
hosts:
  - ridgeline.localhost
emulation:
  userAgentProfile: default
  viewport: 1280x800@1
---

# Check the cart with a scan

This is a bundled Example Flow Skill for the Ridgeline Hardware demo store. It is read-only, it is not user-verified, and its authority ends at the demo store. Targets are listed in [references/accessibility.md](references/accessibility.md). The required scan is defined in [references/scans.json](references/scans.json).

The store has one documented accessibility finding: the "Free returns within 30 days of delivery." note on the cart page has low color contrast. The journey still passes when the scan reports it. Cite the Scan Report as evidence.

1. Open the store's Shop page, where the Run starts.

   Done when: the page shows the "Products" heading.

2. In "Products", select "Add {{product}} to cart".

   Done when: the status line reads "{{product}} added to cart."

3. Select the Cart link in the store navigation.

   Done when: the "Your cart" page lists {{product}} in Items.

4. Run the required scan `cart-accessibility` with agent_run_scan.

   Done when: the Run holds a completed accessibility Scan Report for the cart page.
