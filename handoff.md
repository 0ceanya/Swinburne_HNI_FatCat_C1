# SignGuard: Handoff (2026-10-22, reworked into a key vault)

## 1. The vision (from the project owner)

- **Product:** SignGuard is a **key manager**, not a task manager. What it protects are the company's third-party keys: the Viettel MySign / VNPT SmartCA signing credential and PIN (the Đồng Tháp case: one accountant held the signature and the PIN), cloud root keys, API keys, banking credentials.
- **Each key has a permission level, and the level is the number of approvers needed.** Cloud root = 4, digital signature = 3, API key = 2, and so on, capped at the board size. With the 3-person board, the highest level needs all 3.
- **The keys are locked with TideCloak's algorithm.** The secret is encrypted in the browser with Tide's policy-protected encryption. The Tide network decrypts it only after the quorum approves. We never write our own key splitting, threshold signing or encryption.
- **Sign-in and approvals go through TideCloak.** Approvals happen in Tide's own window, opened from SignGuard. SignGuard has its own Sign in and Sign up pages; only the password/key step happens in Tide's window.
- **The board is fixed.** The members and their permissions are the demo accounts in `tidecloak/demo-accounts.local.json` (owner, director, accountant; the newcomers have no board seat). **That file and those roles must never be changed.** SignGuard has no feature that changes membership or roles.
- **Stack:** Vue 3 frontend, Node + TypeScript backend, local Docker TideCloak.

## 2. Repo state

Committed on `claude/beautiful-einstein-1e4pnu`. The document-signing workflow (vouchers, approval bands, mock CA) is gone; `tidecloak/docs/PLAN.md` describes it and is kept for history only.

```
handoff.md                     this file
tidecloak/
  .env                         (gitignored) admin password, licence email, terms=yes, URLs
  demo-accounts.local.json     (gitignored, NEVER change) Tide usernames + passwords of the board and newcomers
  bootstrap.py                 rebuilds the realm + 3 demo members (FORCE_WIPE=1 to wipe)
  realm.json.template          realm, sg_* roles
  tidecloak.json               adapter exported by bootstrap (public keys/ids)
  app/
    README.md                  how it works, how to run, tests, what is not verified live
    backend/                   Express + node:sqlite. 61 tests (vitest)
    frontend/                  Vue 3 + Vite + Pinia. 28 tests (vitest)
    contracts/                 SignGuardVaultContract.cs (optional upgrade) + Tide compile harness (passes)
    e2e/                       Playwright scripts driving the REAL Tide windows (not in npm check)
```

Run it: Docker Desktop running, container `tidecloak` up on **:8081** (port 8080 is taken by EnterpriseDB's httpd).

```bash
cd tidecloak/app && npm install && npm run dev     # API :3000, app http://localhost:5173
npm run check                                     # typecheck + 89 tests + builds
```

The vault keeps its data in a new `app/backend/data/vault.db`. The old `signguard.db` with the demo documents is not read any more.

### Realm (rebuilt 2026-10-22, multiAdmin, free licence `maxUserAcc: 5`, unchanged by the rework)

| Person | TideCloak user | Roles | Board |
|---|---|---|---|
| Nguyễn Văn An (owner, realm admin) | `owner` | sg_owner, sg_director, sg_viewer, _tide_decryptor, tide-realm-admin | yes |
| Lê Văn Cường (director) | `director` | sg_director, sg_viewer, _tide_decryptor | yes |
| Trần Thị Bình (accountant) | `accountant` | sg_drafter, sg_viewer, _tide_decryptor, _tide_encryptor | yes |
| (sign-up test, no name) | `dd1d979a…` | none | no |

The network counts approvals from holders of **`sg_viewer`**, which all three board members already hold, so no role had to change.

## 3. Verification status

**Verified live before the rework** (headless Chromium, the old document flow). These pieces are reused unchanged:
1. Creating Tide accounts from invite links (`e2e/create-account.mjs`).
2. Sign-in through Tide's window with DPoP.
3. Signing a policy in Tide setup as the owner under the realm admin policy: the network's signature verified byte for byte against the server's codec. The vault policies are signed through this same flow.
4. Multi-person approval in Tide's window, and the network's `GenericRealmAccessThresholdRole:1` counting approvers by realm role (threshold 2 of `sg_director` worked).

**Not yet run live (the new vault flow):** signing the 3 vault policies; `doDraftEncryption`/`doCommitEncryption` and `doDraftDecryption`/`doCommitDecryption` with the built-in threshold contract and PUBLIC execution; merging approvals from several browsers in the requester's browser. Every byte layout is cross-checked against the real `@tideorg/js` in the tests, including the SDK's own threshold contract accepting the policy. Run, from `app/e2e` (`npm i && npm run install-browser`):

```bash
node run-setup.mjs out                       # owner signs the 1-, 2-, 3-approval vault policies
node run-register.mjs out owner 4            # owner adds a level-4 key (needs 3 of 3)
node run-approve.mjs out director approve
node run-approve.mjs out accountant approve
node run-finish.mjs out owner                # owner seals it
# then an unlock: request it as the accountant in the UI (Vault → key → Ask the board), and
node run-approve.mjs out owner approve
node run-approve.mjs out director approve
node run-finish.mjs out accountant           # prints the secret's length, never the secret
node run-audit.mjs out
```

## 4. Open work (priority order)

**V1. Run the vault flow live** (section 3). If the network refuses the draft/commit cycle with the built-in contract, the error text says which step; the most likely adjustment is the policy's execution type or model ids.

**V2. Duplicate approvals.** The built-in contract counts dokens holding the role, not distinct people, so one board member who approves in several sessions and merges their own approvals could reach the threshold alone. SignGuard never assembles such a set, but the network does not stop it. `app/contracts/SignGuardVaultContract.cs` fixes it (distinct vuids, vault tag, executor must be an approver). It passes the compile harness. Send it to the Tide team (info@tide.org) to deploy.

**B1. The free licence is full** (`maxUserAcc: 5`). Sign-up cannot create new accounts. The board does not need new accounts. Do not run account-creating automation.

**B2. A self-signed-up user never lands back in SignGuard.** Unchanged and less important now: a newcomer has no board seat anyway. See the previous notes in git history.

**B4. Chrome Local Network Access.** Tide's pages call `localhost:8081`; tell demo users to click **Allow**.

**Smaller:** key rotation and retiring a key (both should need the key's quorum) are not built; the release's audit record is written by the requester's browser after the network decrypts, and the finish kit is logged when the approvals leave the server (`request.finish_started`); phone approvals need an HTTPS tunnel; the e2e scripts are not wired into `npm run check`.

## 5. Key facts learned (don't rediscover)

- **Quorum-gated decryption is a Tide SDK feature:** `doDraftDecryption` → `requestTideOperatorApproval` (each approver, Tide window) → `doCommitDecryption(request, policy)`, and the same for encryption. The policy is the built-in `GenericRealmAccessThresholdRole:1` with model ids `PolicyEnabledEncryption:1` + `PolicyEnabledDecryption:1`, EXPLICIT. EXPLICIT applies to both models, so **sealing a key also needs the quorum**.
- **Drafts never contain the secret.** Encryption happens in the browser: ElGamal to the network's public key, or AES with an ElGamal-wrapped data key for values of 32 bytes or more. The draft carries the C1 point plus ciphertext; decryption keys go back to the committing session only.
- **Approvals are independent:** each signs the creation message plus the network's creation signature (`dataToApprove`), not the other approvals, so they merge with `BaseTideRequest.addApproval` in any order. `Doken.serialize()` returns the original string.
- `PolicyProtectedSerializedField` v2 = `[version 2, encFieldChk, timestamp(8), encKey, signature]`. It is not re-exported from `Models`; import the module path (the SDK has no exports map).
- Signing uses the SDK's policy version **"4"**. The backend has its own TideMemory codec, because `@tideorg/js` can't load in plain Node; tests cross-check it byte for byte.
- **TideCloak IGA allows one pending change request per user.** Assign roles only **after** the user has linked their Tide account.
- Tide's sign-up form fields: `input#sign_up-input_username`, `#sign_up-input_password`, `#sign_up-input_repeat_password`, `#sign_up-button`, then `#sign_up_email-button`. The approval window has Y/N buttons per request and `#submitBtn`.
- `contracts/harness/check.sh` has CRLF line endings: on Linux run an LF copy kept in the same folder (`tr -d '\r' < check.sh > .check-lf.sh && bash .check-lf.sh ../SignGuardVaultContract.cs`), then delete it and `git checkout -- bin obj` (the build rewrites the committed outputs).
