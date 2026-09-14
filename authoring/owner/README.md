# XQueue Author owner approval authority

Authoritative candidate approval is owner-reserved. XQueue automation may prepare the exact approval payload and may verify a signature, but it must never possess or invoke the production private signing key.

## Trust root

The verifier reads only:

`authoring/owner/approval-public-key.pem`

That file contains Patrick's Ed25519 **public** key. The corresponding private key is generated and stored outside this repository under owner control.

## Required local key handling

Generate the production key only on Patrick's local workstation, encrypted with a passphrase. Never generate the production private key in GitHub Actions, a cloud agent, an LLM tool, a repository workspace, or `.xqueue-author/`.

Recommended private-key location:

`~/.config/xqueue/owner-approval-ed25519.pem`

Only `approval-public-key.pem` is copied into the repository.

## Approval flow

1. Run `pnpm author:approval-payload -- ... --output <payload.json>`.
2. Inspect the exact candidate digest and decision.
3. Sign the exact payload bytes outside XQueue automation with the owner-held Ed25519 private key.
4. Run `pnpm author:approve -- ... --payload <payload.json> --signature <signature.bin>`.
5. XQueue verifies the detached signature against the committed public key before saving the approval.
6. `pnpm author:promotion-plan` verifies the signature again before granting any promotion authority.

The unsigned payload grants no authority. A stored `decided_by` string, candidate digest, boolean, CLI confirmation, or generated text is not owner authentication.

## Rotation

Changing `approval-public-key.pem` changes the owner-approval trust root. Treat key rotation as a material governance change with an explicit owner decision, a documented old/new fingerprint, and exact-candidate verification. Never silently replace the public key as part of unrelated authoring work.
