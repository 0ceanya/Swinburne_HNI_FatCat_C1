# SignGuard app

Quorum approval for company digital signatures, on TideCloak. No one at the company can get a high-value document signed alone, and every approval is a signature from the approver's own Tide session, checked again by the Tide network before it signs.

```
tidecloak/
├── .env                  operator secrets (gitignored): admin password, licence email
├── tidecloak.json        realm adapter exported by bootstrap.py (public keys + ids)
├── bootstrap.py          one-time realm setup
├── docs/PLAN.md          the build plan
└── app/
    ├── backend/          Node + TypeScript API (Express, SQLite via node:sqlite)
    ├── frontend/         Vue 3 + Vite + Pinia
    ├── contracts/        optional custom Forseti contract + Tide's compile harness
    ├── branding/         login-screen logo and background (uploaded to the enclave)
    └── scripts/          dev runner, branding upload
```

## Run it

Needs Node 22.13+ and Docker Desktop with the `tidecloak` container running (`localhost:8081`).

```bash
cd tidecloak/app
npm install
npm run dev          # API on :3000, app on http://localhost:5173
```

Open **http://localhost:5173** and sign in with your Tide account.

### First run, once

1. **Give yourself tiers.** Your admin account starts with `tide-realm-admin` but no SignGuard tier. TideCloak allows **one pending change per person**, so each role is one approval:
   ```bash
   npm run grant -w backend -- admin owner,director,drafter,viewer
   ```
   It files one change, waits while you approve it at **http://localhost:8081/realms/signguard/tide-console/** → Change Requests, then files the next. Sign out and in again afterwards.
2. **Tide setup** (top menu, realm admins only). Approve each item once in Tide's window:
   - **Sealed fields**: the `RelationshipAttestation:1` policy that encrypts counterparty, bank account and description.
   - **Network signing rules**: one per approval band, on the built-in `GenericRealmAccessThresholdRole:1` contract.
3. **Invite your team** (Members, owner only). Each invite is a change request. Once it's approved, generate the invite link and send it to them. Use separate browser profiles to act as several people on one machine.

## How signing works

| Step | Who | What happens | Checked by |
|---|---|---|---|
| Submit | Drafter | Content hash frozen; approval statement built with the audit-log head | Server |
| Open on Tide | Drafter's browser | `createTideRequest` for that statement | Server checks the bytes carry exactly this statement |
| Approve | Each approver | Tide's own window (`requestTideOperatorApproval`) | Server: exactly one new approval, the caller's, a needed tier, not the initiator, and the hash in the URL (covered by the device's DPoP proof) |
| Sign | Last approver's browser | `executeSignRequest` | **Tide network** counts approvers holding the band's role; server verifies the Ed25519 signature over the statement against the realm key |
| E-invoice | Server | Mock CA refuses unless the Tide signature is valid for this content hash | Mock CA |

Default bands (policy v1): under 20M ₫ the drafter signs alone (logged); 20M–500M ₫ needs a director; over 500M ₫ needs a director **and** the owner. The owner also holds `sg_director`, because the network counts `sg_director` holders; the server additionally requires one of them to be the owner.

**Policy changes** need a second director or owner to endorse them, and realm admins must sign the new version's network rules in Tide. A request keeps the policy version it started with.

**Audit log**: every entry hashes the previous one. Each signed document's statement carries the log head at submission, signed by the Tide network, so even a full rewrite of the chain is caught (Audit → Verify chain).

## Tests

```bash
npm run check        # typecheck + all tests + both builds
```

| Suite | What it proves |
|---|---|
| `backend/test/tide/codec.test.ts` | The server's Tide byte codec matches `@tideorg/js` **byte for byte** (policies, requests, approvals) |
| `backend/test/auth` | Real token + DPoP crypto: replay, wrong device, wrong URL/method/token, expired, forged signature, wrong client/issuer, no vuid |
| `backend/test/api/flows.test.ts` | End to end with a simulated Tide network using real Ed25519 signatures: the Đồng Tháp replay, every band, forged/duplicated/stale approvals, invalid signatures, expiry, edit-cancels, policy governance, tier enforcement, tamper detection |
| `backend/test/gateways` | Tier changes against TideCloak's one-pending-change rule |
| `backend/test/domain` | Money, hashing, bands, quorum matching, initiator rule, audit chain |
| `frontend/src/**/*.test.ts` | Formatting, band preview, the exact order of Tide/API calls in the signing flow, the Approve sheet |

Mutation-checked: disabling the initiator rule fails 8 tests; making signature checks always pass fails 2.

## What has NOT been verified against the live Tide network yet

The tests simulate the network with real cryptography, but these steps need a real Tide session and have not been run yet:

1. Approving a **signing rule** and the **sealed-fields policy** in Tide setup (the admin enclave flow follows Tide's verified relationship-attestation helper).
2. Field **encryption/decryption** with `RelationshipAttestation:1`. Tide's notes say networks on ORK builds before 2026-10-16 may not have it; if encryption fails with "unknown contract", ask the Tide team.
3. **Approving a document** in the enclave: whether the approval card renders for a `Policy:1` request, and that `GenericRealmAccessThresholdRole:1` counts the approvals as expected.
4. That the network's signature verifies against the **statement bytes** the server rebuilds. Tide setup shows "signed, not verified locally" if it does not, which would mean a byte-layout difference to fix.
5. Saving your name through the Account API with a DPoP-bound token.

Each failure surfaces with the network's own message on screen. If one fails, the error text says which step.

## Dev-only switches (never for a demo)

| Variable | Effect |
|---|---|
| `SIGNGUARD_ALLOW_UNSIGNED_DEV=true` | Approvals complete without the Tide network (receipts say so) |
| `SIGNGUARD_ALLOW_PLAINTEXT_DEV=true` | Sensitive fields may be stored unencrypted (screens say so) |
| `SIGNGUARD_REQUIRE_DPOP=false` | Tokens not bound to devices |

Put them in `tidecloak/app/backend/.env` or the environment. The server prints a warning for each at start.

## Security notes, stated plainly

- The server holds the TideCloak master-admin password (from `tidecloak/.env`) to list members, file tier changes and fetch the realm's admin policy. **Local development only.** On this realm every governed write it makes is only a change request that a realm admin must sign in Tide.
- The server never sees sealed-field plaintext, cannot approve on anyone's behalf, and cannot produce a network signature.
- `contracts/SignGuardApprovalContract.cs` is an optional upgrade that moves the server's extra checks (distinct people, initiator excluded, amount within the band, tier mix) onto the network. It passes Tide's compile harness. Deploying it is done by the Tide team (info@tide.org).
