# SignGuard app

A key vault for a company's third-party credentials (Viettel MySign / VNPT SmartCA signing credentials, cloud root keys, API keys, banking tokens), locked by the Tide network. Each key has a **permission level**. The level is the number of board members who must approve before anyone can seal the key into the vault or unlock it, capped at the board size. Nobody can unlock a key alone, not even SignGuard's own server.

```
tidecloak/
├── .env                  operator secrets (gitignored): admin password, licence email
├── tidecloak.json        realm adapter exported by bootstrap.py (public keys + ids)
├── bootstrap.py          one-time realm setup (the fixed board: owner, director, accountant)
└── app/
    ├── backend/          Node + TypeScript API (Express, SQLite via node:sqlite)
    ├── frontend/         Vue 3 + Vite + Pinia
    ├── contracts/        optional custom Forseti contract + Tide's compile harness
    ├── e2e/              Playwright scripts driving the real Tide windows
    ├── branding/         login-screen logo and background (uploaded to the enclave)
    └── scripts/          dev runner, branding upload
```

## Permission levels

| Level | Example keys | Needs (board of 3) |
|---|---|---|
| 1 · Standard | shared account, Wi-Fi | the requester alone, logged |
| 2 · Elevated | API key, database password | 2 of 3 |
| 3 · High | Chữ ký số (Viettel MySign, VNPT SmartCA), banking credential | 3 of 3 |
| 4 · Critical | cloud root credential | 3 of 3 (level 4 is capped at the board size) |

The board is fixed: the 3 demo accounts (owner, director, accountant) created by `bootstrap.py`. Every board member holds the realm role `sg_viewer`, which is the role the Tide network counts. SignGuard reads the board and its roles and **never changes them**. There is no route to invite people, grant roles or approve sign-ups. A Tide account that is not on the board can sign in and sees "not on the board", nothing more. If the board ever grows (`SIGNGUARD_BOARD_SIZE`), the cap lifts on its own: level 4 then needs 4.

## How a key is locked

```
 Registrar's browser                  SignGuard server                 Tide network (20 ORKs)
 ───────────────────                  ────────────────                 ──────────────────────
 doDraftEncryption(secret) ─────────► stores the DRAFT (ciphertext      
   secret encrypted HERE to the        only), opens a "seal" request
   network's key                       needing `quorum` approvals
                                                │
 Other board members' browsers  ◄───────────────┘
 requestTideOperatorApproval ───────► checks: same bytes + exactly one
   (Tide's own window)                 approval, the caller's, on the board
                                                │ ready
 Registrar's browser  ◄─────────────────────────┘ finish kit (others' approvals + policy)
 own approval in Tide's window
 merge approvals, doCommitEncryption ─────────────────────────────────► counts approvers holding
                                                                        sg_viewer ≥ threshold,
 ◄───────────────────────────────────────────────────────────────────── signs the ciphertext
 posts the ciphertext ──────────────► checks it is the approved value,
                                       key is now "active"
```

Unlocking is the same flow with `doDraftDecryption` / `doCommitDecryption`. The network returns the decryption keys to the **requester's browser only**. The secret appears there for 60 seconds and is never sent to SignGuard. Every unlock is a new request with a new quorum.

| Step | Who | What happens | Checked by |
|---|---|---|---|
| Register | Any board member | Secret encrypted in their browser (`doDraftEncryption`); only the draft (ciphertext) is sent | Server: right request model, initialised, no approvals, exactly one value tagged `signguard-vault-v1` |
| Ask to unlock | Any board member, with a reason | Decryption drafted in their browser for that key's ciphertext | Server: the draft points at **this** key's ciphertext (C1 point, timestamp and the network's signature all match) |
| Approve | Each other board member | Tide's approval window, opened from SignGuard | Server: exactly one new approval on the stored bytes, the caller's own vuid, unexpired, carrying `sg_viewer`, doken signed by the realm; the requester cannot approve here |
| Finish | The requester only, once the others are in | Own approval in Tide, merge (`BaseTideRequest.addApproval`), `doCommitEncryption`/`doCommitDecryption` | **Tide network**: the signed vault policy (`GenericRealmAccessThresholdRole:1`, `threshold = quorum`, role `sg_viewer`). Server: the requester's own approval, and for a seal, that the ciphertext is the value the board approved |

Why the requester approves **last**: approvals are independent (each signs only the request's creation), so the server hands the other members' approvals to the requester alone, and only once they are complete. Nobody else ever holds a request the network would accept. A released secret is shown only after the release is recorded on the audit log.

**Audit log**: every step is a hash-chained entry, so editing any past entry breaks the chain (Audit → Verify chain). Refused attempts (a requester trying to approve their own request, someone off the board) are logged too.

## Run it

Needs Node 22.13+ and Docker Desktop with the `tidecloak` container running (`localhost:8081`).

```bash
cd tidecloak/app
npm install
npm run dev          # API on :3000, app on http://localhost:5173
```

The vault uses a fresh database, `backend/data/vault.db`. The old document-signing `signguard.db` is left untouched.

### First run, once: Tide setup

Sign in as the **owner** (the realm admin) and open **Tide setup**. Approve each vault policy once in Tide's window: **1, 2 and 3 approvals**. Each is Tide's built-in `GenericRealmAccessThresholdRole:1` over `PolicyEnabledEncryption:1` + `PolicyEnabledDecryption:1`, EXPLICIT approval, `role = sg_viewer`. Nothing needs deploying. A key cannot be registered until the policy for its quorum is signed, and a signed policy is never replaced, because every key sealed under it is bound to it.

### Demo

1. **Owner** adds "AWS root" at level 4 (needs 3 of 3). The secret is encrypted in their browser.
2. **Director** and **accountant** each approve the seal in Tide's window. The owner presses *Approve in Tide and seal it*. The key is now in the vault.
3. **Accountant** asks to unlock it, with a reason. Trying to approve their own request is refused and logged.
4. **Owner** and **director** approve. The accountant presses *Approve in Tide and unlock it*. The network decrypts it to the accountant's browser only. Audit shows who asked, who approved and when.
5. Level 2 (an API key): one other person is enough. Level 1: the requester alone, still logged.

Use separate browser profiles to act as several people on one machine. `e2e/` scripts do the same headlessly: `node run-setup.mjs <out>`, `node run-register.mjs <out> owner 4`, `node run-approve.mjs <out> director approve`, `node run-finish.mjs <out> owner`, then the same for an unlock.

## Tests

```bash
npm run check        # typecheck + all tests + both builds
```

| Suite | What it proves |
|---|---|
| `backend/test/tide/codec.test.ts` | Against the **real** `@tideorg/js`: our vault policy bytes match `Models.Policy`; the SDK's own `GenericRealmAccessThresholdRoleContract` accepts the policy for both models with 2 board approvals and refuses 1 or a non-board approver; seal/release drafts built by the SDK's `PolicyAuthorizedEncryptionFlow` pass the server's checks; its `PolicyProtectedSerializedField` parses; approvals collected separately merge with `addApproval`; the ciphertext never contains the secret |
| `backend/test/api/vault.test.ts` | End to end against a simulated Tide network with real Ed25519 that enforces the policy threshold: levels 1, 2, 4 (capped), seal and unlock, the network refusing without the quorum, forged/duplicated/someone else's/expired/role-less approvals, a release drafted for another key, a ciphertext swapped between seals, reject/cancel/expiry, a non-board user, no member-changing routes, audit tampering |
| `backend/test/auth` | Real token + DPoP crypto: replay, wrong device, wrong URL/method/token, expired, forged signature, wrong client/issuer, no vuid |
| `backend/test/domain` | Levels → quorum, key and request rules, audit chain |
| `frontend/src/**/*.test.ts` | The exact order of Tide/API calls (Tide's window first, secret only after it is recorded), the request screen for approver / requester / bystander, the add-key form never sending the secret |

## What has NOT been verified against the live Tide network yet

The tests cross-check every byte layout against the SDK, but these steps need a real Tide session and have not been run live:

1. Signing the three **vault policies** in Tide setup. The same admin flow signed the old network rules live, byte for byte.
2. `doDraftEncryption` / `doCommitEncryption` and `doDraftDecryption` / `doCommitDecryption` with the built-in threshold contract and **PUBLIC** execution (the built-in contract has no executor check).
3. That the drafts come back initialised (the code initialises them itself if not).
4. That a request approved in **several browsers** and merged in the requester's browser is accepted by the network.

Each failure surfaces with the network's own message on screen. Run `e2e/` against the live realm to confirm.

## Security notes, stated plainly

- The server only ever stores ciphertext. It cannot approve on anyone's behalf, and it cannot decrypt: decryption needs a Tide session plus the quorum's approvals.
- **The built-in contract counts dokens, not people.** It counts approver dokens holding `sg_viewer`. A board member with technical skill could approve the same request in several sessions and merge their own approvals to reach the threshold alone. SignGuard's server never hands out such a set, and logs every approval, but the network does not prevent it. `contracts/SignGuardVaultContract.cs` closes this: distinct people by vuid, the vault tag, and the executor must be one of the approvers. It passes Tide's compile harness. Deploying it is done by the Tide team (info@tide.org).
- PUBLIC execution: anyone holding a fully approved request could commit it. SignGuard gives the other members' approvals only to the requester, who approves last in their own browser, so nobody else holds a complete request.
- The server holds the TideCloak master-admin password (from `tidecloak/.env`) for two reads only: listing the board, and fetching the realm admin policy that Tide setup signs under. **Local development only.**
