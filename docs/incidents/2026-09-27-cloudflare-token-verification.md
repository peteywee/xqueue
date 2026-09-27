# 2026-09-27 Cloudflare token-type verification incident

## Summary

During XQueue post-cutover production acceptance, a valid Cloudflare account-owned
API token was repeatedly tested against the user-token verification endpoint.
Because the token was a `cfat_` account token, the user endpoint returned
`Invalid API Token` even though the account-scoped verification endpoint
reported the token as active.

Separately, GitHub Actions was still holding an older `cfat_` token that
Cloudflare correctly rejected as invalid. That stale CI credential was only
discovered after a live preview workflow attempted D1 access.

No production mutation resulted from either failure. Production remained under
the owner halt.

## Root cause

The operator procedure relied on hand-constructing a Cloudflare token
verification request instead of deriving the endpoint from the token type.

The repository also had no independent credential-health gate for the
Cloudflare token stored in GitHub Actions.

## Contributing factors

- `cfat_` account tokens and `cfut_` user tokens use different verification
  endpoints.
- the terminal procedure did not classify the token before verification;
- Cloudflare authorization failure was surfaced only when a later Wrangler/D1
  command executed;
- GitHub Actions credential freshness was not checked independently of release
  workflows.

## Permanent controls

1. `src/cloudflare-auth.mjs` classifies the credential before network access.
2. `cfat_` tokens use the account-scoped verification endpoint.
3. `cfut_` tokens use the user-scoped verification endpoint.
4. malformed, whitespace-containing, missing, and unknown token formats fail
   closed.
5. the verifier never prints the credential.
6. `pnpm cf:auth:preflight` verifies token status and performs a read-only D1
   capability probe.
7. production halt control verifies the token before Cloudflare access.
8. production authority control verifies the token before any authority
   mutation path.
9. Preview Owner Ops runs the typed preflight before live D1 reads.
10. Cloudflare Auth Health checks the GitHub Actions credential on a schedule
    and against both preview and production D1.

## Operator rule

Do not manually choose a Cloudflare token verification endpoint during an
XQueue acceptance or recovery run. Use the repository preflight.

Local production check:

```bash
pnpm cf:auth:preflight --environment production
```

Local preview check:

```bash
pnpm cf:auth:preflight --environment preview
```

When rotating the Cloudflare token, update the GitHub Actions
`CLOUDFLARE_API_TOKEN` secret in the same change window and require the
Cloudflare Auth Health workflow to pass before production acceptance resumes.

## Recovery from this incident

- local account token verification: proven active;
- production halt: proven owner-controlled, halted, generation 6;
- repository verification and structural authority/credential audits: passed;
- GitHub Actions secret: identified as stale and must be replaced with the
  currently valid operator token before PR #141 can be merged.
