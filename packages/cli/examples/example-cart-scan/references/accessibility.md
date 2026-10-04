# Targets

- role=button name="Add {{product}} to cart" context="Products list on the Shop page"
- role=link name="Cart" context="Store navigation; the name includes the item count"
- role=cell name="{{product}}" context="Items table on the Your cart page"

## Why these targets are stable

Product buttons and cart rows carry the product name. The Cart link keeps its name prefix while the count changes.
