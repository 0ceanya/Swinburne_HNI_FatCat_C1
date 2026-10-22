# SignGuard

SignGuard is a key vault for a company's most dangerous credentials. No single person, not even our own server, can unlock a key alone.

**Demo video:** _add link here_

## Vision & originality

A vault for a company's digital signature (Viettel MySign, VNPT SmartCA), bank logins and cloud root keys. Each key's level is the number of board members who must approve before it opens. Unlike a password manager, there is no master key: approval itself unlocks the secret.

## Trust constraint insight

One person always ends up holding the keys. In Đồng Tháp, one accountant held the company's signature *and* its PIN, and signed whatever they wanted. Sharing control today means trusting an admin, server or vendor. Remove that constraint, and "two people must agree" becomes something cryptography enforces, not a policy on paper.

## Value & impact

Vietnamese SMEs that today hand legal signing power to one employee. Example: an accountant needs the signature to file VAT invoices. Two directors approve from their own devices, and the key opens in her browser for 60 seconds, recorded on a tamper-evident log. If she tries to approve her own request, it is refused and flagged.

## Why TideCloak matters

The browser encrypts each secret with Tide's network key. The key that decrypts it is split across 20 independent nodes. The nodes decrypt only after the quorum approves in Tide's own approval window, under a policy signed by the realm. Sign-in is TideCloak with DPoP-bound tokens. Without TideCloak, our server would hold the keys: the single point of trust we set out to remove.

## Prototype & storytelling

A working vault with a fixed 3-person board. Judges should watch for:
1. A new key being encrypted in the browser and sealed after one more approval.
2. A request to unlock it, approved in Tide's window and decrypted to the requester's browser only.
3. A hash-chained audit log and an Insights dashboard. Insights flags refused self-approvals; its risk model is simulated.

---

## Setup

Needs Docker Desktop and Node 22.13+.

```powershell
docker start tidecloak                 # TideCloak on http://localhost:8081
cd tidecloak/app
npm install
npm run dev                            # app on http://localhost:5173, API on :3000
```

First-time realm setup is `python tidecloak/bootstrap.py`, which reads its settings from `tidecloak/.env`. The demo board accounts are in `tidecloak/demo-accounts.local.json` (gitignored). Run tests with `npm run check`.

## More docs

- How it works, tests, security notes: [`tidecloak/app/README.md`](tidecloak/app/README.md)
- TideCloak setup: [`tidecloak/README_TIDE.MD`](tidecloak/README_TIDE.MD)
- 2-minute demo script: [`tidecloak/docs/WALKTHROUGH.md`](tidecloak/docs/WALKTHROUGH.md)
- Current state and open work: [`handoff.md`](handoff.md)
