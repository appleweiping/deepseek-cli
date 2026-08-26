# Distribution and CI hardening — 2026-08-27

## Outcome

WEIPING_WHALE 0.4.1 makes its distribution boundary executable and honest. The
unscoped `weiping-whale` package was not present in the public npm registry when
this release was prepared, so the README no longer presents a registry command
that returns `E404`. The supported path clones the repository, installs the
locked dependency graph, builds the CLI, links that exact build, and verifies
the version without requiring credentials. Doctor diagnostics remain in First
Run, after the API key is configured.

The package smoke test independently packs the project, installs the tarball in
a temporary application with lifecycle scripts disabled, checks the installed
manifest, executes every bin alias, and runs structured doctor diagnostics.

## Supply-chain boundary

The CI workflow now pins `actions/checkout` and `actions/setup-node` to verified
40-character commits from their official repositories. Checkout credentials are
not persisted because the workflow only reads the repository. A release gate
rejects floating action tags and a mutation test protects this invariant.

## Upstream references

- [Gemini CLI installation](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/installation.mdx)
  documents `npm link` as its production-like source workflow. WEIPING_WHALE
  adds an explicit build first because its package has no build-on-link hook.
- [GitHub Secure Use reference](https://docs.github.com/en/actions/reference/security/secure-use)
  identifies a full-length commit SHA as the immutable way to consume an action.
- Action refs were resolved from the official repositories' `v6` tags before
  pinning: `actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803`
  and `actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38`.

## Verification contract

Run all four gates before release:

```text
npm run typecheck
npm test
npm pack --dry-run
npm run audit:prod
```

No npm publication is implied by this source release.
