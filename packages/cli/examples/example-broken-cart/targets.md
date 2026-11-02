# Targets

- role=region name="Demo fault" context="Banner above the store header while the fault is on"
- role=button name="Restore healthy store" context="Inside the Demo fault banner"
- role=button name="Add {{product}} to cart" context="Products list on the Shop page"
- role=link name="Cart" context="Store navigation; the name includes the item count"

## Why these targets are stable

The banner and its button exist only while the fault is on, and their names are fixed text. Product buttons carry the product name in their accessible name.
