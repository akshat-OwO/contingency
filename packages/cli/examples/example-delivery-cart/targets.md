# Targets

- role=combobox name="City" context="Delivery location section on the Shop page"
- role=combobox name="Area" context="Delivery location section; options follow the chosen City"
- role=button name="Save location" context="Delivery location section"
- role=button name="Add {{product}} to cart" context="Products list on the Shop page"
- role=link name="Cart" context="Store navigation; the name includes the item count"
- role=cell name="{{product}}" context="Items table on the Your cart page"

## Why these targets are stable

Each target is a labeled native control or a table row header. The names come from the store's visible labels and product names, which do not change between visits.
