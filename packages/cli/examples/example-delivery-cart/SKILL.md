---
name: example-delivery-cart
description: Example. Add one Ridgeline Hardware product for delivery to a chosen city and area, then confirm the cart names both. Use to show how a taught journey works with different inputs.
inputs:
  - name: product
    description: The product name as the store lists it, such as Trail Hammer.
  - name: city
    description: A delivery city from the store's City list, such as Boulder.
  - name: area
    description: An area of that city from the store's Area list, such as Pearl Street.
hosts:
  - ridgeline.localhost
emulation:
  userAgentProfile: default
  viewport: 1280x800@1
---

# Add a product for delivery

This is a bundled Example Flow Skill for the Ridgeline Hardware demo store. It is read-only, it is not user-verified, and its authority ends at the demo store. Targets are listed in [references/accessibility.md](references/accessibility.md).

1. Open the store's Shop page, where the Run starts.

   Done when: the page shows the heading "Tools for the trail and the workshop" and the "Delivery location" section.

2. In "Delivery location", choose {{city}} in the City list and {{area}} in the Area list, then select "Save location".

   Done when: the status line reads "Delivering to: {{area}}, {{city}}".

3. In "Products", select "Add {{product}} to cart".

   Done when: the status line reads "{{product}} added to cart." and the Cart link shows a count.

4. Select the Cart link in the store navigation.

   Done when: the "Your cart" page lists {{product}} in Items and shows "{{area}}, {{city}}" as the Delivery location.
