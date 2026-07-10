Golden conformance fixtures copied verbatim from the CCLG repo (canonical source of the
`.cclg` format and its Python effective-view implementation), `tests/conformance/` at
commit `51fbd242af317dab302cc0a0bfd405c6ae64ee6c`.

Each numbered pair is a `.cclg` container plus a language-neutral `*.expected.json`
describing the expected `effectiveView()` result (or, for 07/08, that loading/computing
it must fail). See `packages/core/test/cclg-conformance.test.mjs` for how these are
consumed.

To re-sync after upstream changes: copy `tests/conformance/*.cclg` and
`tests/conformance/*.expected.json` from the CCLG repo into this directory and update the
commit hash above.
