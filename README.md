# Contingency

Turborepo workspace managed by `nub`.

## Quality

```sh
nub exec turbo run quality
nub exec turbo run quality:fix
```

The root quality tasks use Ultracite presets with Oxlint and Oxfmt. Read-only checks run in parallel; fixes run in lint-then-format order to prevent concurrent writes.
