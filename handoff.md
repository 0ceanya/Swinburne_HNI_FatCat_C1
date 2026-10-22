# SignGuard — Handoff (2026-10-22)

## 1. The vision (from the project owner)

- **Product:** SignGuard stops one person from getting a high-value company document (payment voucher, e-invoice) signed alone, the Đồng Tháp case where one accountant held the signature + PIN. Approvals are **cryptographic, not database rows**, and no master key belongs to the platform.
- **TideCloak does all auth and key work.** We never write our own key splitting, threshold signing or encryption.
- **The fundamental flow:** someone makes a request, the keyholder(s) who must approve it see it, and they approve it **in Tide's own window, opened from SignGuard**. Tide's network re-checks the approvals and signs.
- **SignGuard has its own Sign in and Sign up pages.** Only the password/key step happens in Tide's window, because a password must never reach our server.
- **The MVP must demonstrate a real user flow** with real organisation accounts, not just tests. "A demo that doesn't show the flow is unacceptable."
- **Demo accounts:** 3 real accounts (Owner, Director, Accountant), created first-hand. Newcomers via sign-up: **limit 2**. The free Tide licence allows 5 user accounts in total; see bug B1.
- **Stack:** Vue 3 frontend, Node + TypeScript backend, local Docker TideCloak. Plan: `tidecloak/docs/PLAN.md`.

## 2. Repo state

Nothing is committed since `cdfd77c install`. All of the following is untracked or modified:

```
handoff.md                     this file
.gitignore                     *.docx, .env*, tidecloak/data/, tidecloak/*.local.json
tidecloak/
  .env                         (gitignored) admin password, licence email, terms=yes, URLs
  demo-accounts.local.json     (gitignored) Tide usernames + passwords of the demo people
  bootstrap.py                 rebuilds the realm + 3 demo members (FORCE_WIPE=1 to wipe)
  realm.json.template          realm, sg_* roles, registrationAllowed=true
  tidecloak.json               adapter exported by bootstrap (public keys/ids)
  data/                        (gitignored) H2 DB, invite-links.json
  docs/PLAN.md                 build plan (updated with findings)
  app/
    README.md                  how to run, architecture, tests, security notes
    backend/                   Express + node:sqlite. 83 tests (vitest)
    frontend/                  Vue 3 + Vite + Pinia. 31 tests (vitest)
    contracts/                 optional custom Forseti contract + Tide compile harness (passes)
    e2e/                       Playwright scripts driving the REAL Tide windows (not in npm check)
    branding/, scripts/        login branding + uploader (brand.py), dev runner
```

Run it: Docker Desktop running, container `tidecloak` up on **:8081**. Port 8080 is taken by EnterpriseDB's httpd.

```bash
cd tidecloak/app && npm install && npm run dev     # API :3000, app http://localhost:5173
npm run check                                     # typecheck + 114 tests + builds
```

If `npm run dev` exits with "port in use", an old Vite or Node process is still listening. Kill whatever holds :3000 and :5173 (IPv4 **and** IPv6), then restart.

### Realm (rebuilt 2026-10-22, multiAdmin, free licence `maxUserAcc: 5`)

| Person | TideCloak user | Roles | Tide login |
|---|---|---|---|
| Nguyễn Văn An (owner, realm admin) | `owner` | sg_owner, sg_director, sg_viewer, _tide_decryptor, tide-realm-admin | see `tidecloak/demo-accounts.local.json` |
| Lê Văn Cường (director) | `director` | sg_director, sg_viewer, _tide_decryptor | same file |
| Trần Thị Bình (accountant) | `accountant` | sg_drafter, sg_viewer, _tide_decryptor, _tide_encryptor | same file |
| (sign-up test, no name) | `dd1d979a…` | none | `newcomer` in the same file |

Tide setup is **done**: the sealed-fields policy and the 3 network rules were approved by the owner and verified. The local DB (`app/backend/data/signguard.db`) holds the demo documents: PC-0001 (rejected → draft), PC-0002 (85M, signed), HD-0001 (640M e-invoice, signed + mock CA).

## 3. Verified LIVE on the real Tide network (headless Chromium, `app/e2e`)

1. Creating Tide accounts from invite links (owner, director, accountant): `e2e/create-account.mjs`.
2. Sign-in through Tide's window into SignGuard, with DPoP (falls back to the pop-up relay).
3. Tide setup: the owner approved 4 policies in Tide's approval window. The network's signatures **verified byte-for-byte** against the server's own codec.
4. Field encryption and decryption with `RelationshipAttestation:1`.
5. **The core flow:** the accountant submits, the director sees it in the inbox and approves in Tide's window, the network signs, the server verifies, and the document is Signed.
6. High band: director + owner approvals; the network's threshold 2 of `sg_director` worked; the e-invoice got the mock CA receipt.
7. Đồng Tháp replay: the initiator is blocked with a reason; the director rejects with a reason, and the document returns to Draft.
8. Audit: "Chain verified · 20 entries · 2 Tide-signed anchors (2 match)".
9. The owner's own DPoP token can call TideCloak's IGA admin API from the browser (`e2e/probe-iga.mjs`).

Re-run the scripts from `app/e2e` with `npm i && npm run install-browser`, then `node run-setup.mjs <outdir>`, `node run-create.mjs <outdir> <amount> ...`, `node run-approve.mjs <outdir> <who> approve|reject|view <amountFilter>` and `node run-audit.mjs <outdir>`. Each one signs in as the named demo person.

## 4. Bugs and open work (priority order)

**B1. The free licence is full: sign-up cannot create new accounts.** The licence allows `maxUserAcc: 5` and Tide now answers "Subscription … has exceeded its total user count". Abandoned sign-up attempts during automation used up slots on the network side, even though only 4 realm users exist. The plan is 3 demo accounts plus **at most 2 newcomers**. To get the slots back, either rebuild once more (`FORCE_WIPE=1 python tidecloak/bootstrap.py`, then `e2e/create-account.mjs` for each person **once**, without exploring), or ask Tide for more seats. Any automation must create each account exactly once: an aborted sign-up still costs a seat and reserves the username for about 5 minutes.

**B2. A self-signed-up user never lands back in SignGuard.** The first `run-signup.mjs` created a Tide account and a realm user (`dd1d979a…`, linked, no name), but the browser never returned to `localhost:5173`. Signing in as that user also stalls: `login-probe.mjs newcomer` times out waiting for the redirect, and a 404 appears in the console. Suspects:
- the first-broker-login flow for **self-registered** users (as opposed to invited ones),
- a required action,
- the user having no roles at all (not even `appUser`/`_tide_enabled`: check that default roles applied),
- the realm's `RegOn` signed settings.

Next step: screenshot where it stops (add `shot()` on timeout in `e2e/lib.mjs signIn`) and read `docker logs tidecloak` around that time.

**B3. Not yet tested live:**
- sign-up → join request → owner **Approve** → "Approve in Tide ✓" on each pending change (in-app IGA approval via `approveChangeRequest` in `frontend/src/tide/tide.ts`) → the next step filed automatically;
- saving a name through the Account API with a DPoP token (`updateOwnProfile`).

Both are covered by unit and API tests only.

**B4. Chrome Local Network Access.** Tide's public pages call `localhost:8081`, so Chrome asks every person to allow local network access. If they refuse, sign-in fails ("Network request failed"), and the branding images on the sign-in page are blocked (the approval window shows the logo fine). Tell demo users to click **Allow**. The e2e scripts grant it automatically.

**B5. Server-only rules.** The built-in contract only counts holders of a role. The **server** enforces distinct approvers, the initiator exclusion and the director + owner mix. To move these onto the network, send `app/contracts/SignGuardApprovalContract.cs` to the Tide team (info@tide.org). See PLAN §8.

**B6. Smaller items:**
- Phone approvals need an HTTPS tunnel; register its URL early, because each new URL is one Tide approval.
- `window.__signguardTide` exists in dev builds only (for e2e).
- The `node:sqlite` ExperimentalWarning is noise.
- The e2e scripts are not wired into `npm run check`.
- A presenter guide (DEMO.md) and an "e2e run-all" script are still to write.
- Commit the work: nothing is committed yet.

## 5. Key facts learned (don't rediscover)

- Signing uses the built-in **`GenericRealmAccessThresholdRole:1`**, so nothing needs deploying. Statements are signed as Policy bodies through the `Policy:1` model. The SDK's policy version is **"4"**. The backend has its own TideMemory codec, because `@tideorg/js` can't load in plain Node; tests cross-check it byte-for-byte.
- **TideCloak IGA allows one pending change request per user.** Grant roles one at a time. Assign roles only **after** the user has linked their Tide account.
- Licensing makes `email` a required profile attribute; `bootstrap.py` makes it optional again.
- Tide's sign-up form fields: `input#sign_up-input_username`, `#sign_up-input_password`, `#sign_up-input_repeat_password`, then `#sign_up-button`, then the recovery step `#sign_up_email-button` (email is optional), then "Tide account linked". The approval window has Y/N buttons per request and `#submitBtn`. Wait for the page to be styled before reading it.
- Policies, rules and statements use only lowercase parameter names, so any sort order agrees.
