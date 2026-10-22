"""Bootstrap a local TideCloak realm for SignGuard.

Python port of the Tide Agent Pack's templates/shared/bootstrap-tidecloak.sh (v1.9.33), so it
runs on Windows without bash, sudo, lsof or jq. Same steps, same order:

   0. Refuse to wipe a container that already hosts realms, then clean ./data
   1. Start tideorg/tidecloak-dev:latest
   2. Create the realm from realm.json.template (includes the sg_* tier roles)
   3. Turn off Keycloak's first-login profile page
   4. License the realm (setUpTideRealm), stamp iga.attestor=tide, enable IGA
   5. Approve change requests, create the admin user
   6. Print the invite link and WAIT for the admin to link a Tide account in the browser
   7. Sign IdP settings, grant tide-realm-admin LAST (flips the realm to multiAdmin)
   8. Export the adapter config to tidecloak.json

Everything is read from .env next to this file (gitignored). Usage:  python bootstrap.py
Set FORCE_WIPE=1 to rebuild from scratch when realms already exist.
"""
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
HERE = Path(__file__).resolve().parent


def die(msg, code=1):
    print(f"ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def load_env(path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


load_env(HERE / ".env")

TIDECLOAK_URL = os.environ.get("TIDECLOAK_URL", "http://localhost:8081").rstrip("/")
HOST_PORT = urllib.parse.urlparse(TIDECLOAK_URL).port or 80
REALM = os.environ.get("REALM_NAME", "signguard")
CLIENT = os.environ.get("CLIENT_NAME", "signguard-client")
# Every origin the app may be served from. Adding one after the multiAdmin flip needs a manual
# enclave approval in the admin console, so list them all now.
APP_URLS = [u.strip().rstrip("/") for u in
            os.environ.get("CLIENT_APP_URLS", os.environ.get("CLIENT_APP_URL", "http://localhost:5173")).split(",")
            if u.strip()]
ADAPTER_OUTPUT = HERE / os.environ.get("ADAPTER_OUTPUT", "tidecloak.json")
IMAGE = os.environ.get("TIDECLOAK_IMAGE", "tideorg/tidecloak-dev:latest")
DATA_DIR = HERE / "data"
ADMIN_USER = os.environ.setdefault("KC_BOOTSTRAP_ADMIN_USERNAME", os.environ.get("KC_ADMIN_USER", "admin"))
ADMIN_PASSWORD = os.environ.get("KC_BOOTSTRAP_ADMIN_PASSWORD") or os.environ.get("KC_ADMIN_PASSWORD", "")
TERMS_URL = "https://tide.org/legal"

if not ADMIN_PASSWORD:
    die("KC_BOOTSTRAP_ADMIN_PASSWORD is not set in tidecloak/.env (no default, by design).")
os.environ["KC_BOOTSTRAP_ADMIN_PASSWORD"] = ADMIN_PASSWORD
if "stg" in IMAGE:
    die(f"{IMAGE} is a staging image and is not supported. Use tideorg/tidecloak-dev:latest.")

# --- Licence email + Terms & Conditions: answered by a PERSON, never defaulted (AP-90) ---
PLACEHOLDER_DOMAINS = {"example.com", "example.org", "example.net", "yourorg.com", "yourdomain.com",
                       "yourcompany.com", "company.com", "domain.com", "test.com", "placeholder.com",
                       "email.com", "localhost"}


def valid_license_email(email):
    if not re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", email or ""):
        return False
    domain = email.rsplit("@", 1)[1].lower()
    return domain not in PLACEHOLDER_DOMAINS and not domain.endswith((".example", ".test", ".invalid", ".local"))


LICENSE_EMAIL = os.environ.get("TIDE_LICENSE_EMAIL") or os.environ.get("ADMIN_EMAIL", "")
TERMS = os.environ.get("TIDE_TERMS_ACCEPTED", "")
if sys.stdin.isatty() and sys.stdout.isatty():
    while not valid_license_email(LICENSE_EMAIL):
        LICENSE_EMAIL = input("Enter an email to manage your Tide licence: ").strip()
    if TERMS != "yes":
        print(f"Please review the Tide Terms & Conditions: {TERMS_URL}")
        if input("Do you agree to the Terms & Conditions? (yes/no): ").strip().lower() not in ("y", "yes"):
            die("Terms & Conditions not accepted. Nothing was created.")
        TERMS = "yes"
if not valid_license_email(LICENSE_EMAIL) or TERMS != "yes":
    die("STOP: TIDE_LICENSE_EMAIL and TIDE_TERMS_ACCEPTED=yes must both be set by the person who owns "
        f"this deployment (terms: {TERMS_URL}). Nothing was created.", 2)
print(f"==> Licence email: {LICENSE_EMAIL}")
print(f"==> Terms & Conditions ({TERMS_URL}): accepted by the operator")


# --- HTTP helpers (no redirect following: setUpTideRealm's 303 must stay visible) ---
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def http(method, path, token=None, json_body=None, form=None, timeout=60):
    """Return (status, body_text). Never raises on HTTP errors; status 0 means no connection."""
    url = path if path.startswith("http") else TIDECLOAK_URL + path
    headers, data = {}, None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if json_body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(json_body).encode()
    elif form is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        data = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with _opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as e:
        return 0, str(e)


def as_json(body, default=None):
    try:
        return json.loads(body)
    except (ValueError, TypeError):
        return default


def get_token():
    # Master-admin tokens live ~60 seconds, so mint one per call.
    code, body = http("POST", "/realms/master/protocol/openid-connect/token", form={
        "username": ADMIN_USER, "password": ADMIN_PASSWORD,
        "grant_type": "password", "client_id": "admin-cli"})
    token = (as_json(body) or {}).get("access_token")
    if not token:
        die(f"could not get a master-admin token (HTTP {code}). Is the password in .env the one the "
            "container was first started with?")
    return token


SKIP_ACTIONS = {"DISABLE_IGA", "DELETE_REALM", "OFFBOARD_REALM"}


def pending_change_requests():
    code, body = http("GET", f"/admin/realms/{REALM}/iga/change-requests?status=PENDING", get_token())
    items = as_json(body, [])
    return [cr for cr in items if cr.get("actionType") not in SKIP_ACTIONS] if isinstance(items, list) else []


def approve_all_pending():
    """Authorize each pending change request one by one, then commit those ready (several passes,
    so dependent requests become ready). Valid only while the realm is still firstAdmin."""
    for cr in pending_change_requests():
        http("POST", f"/admin/realms/{REALM}/iga/change-requests/{cr['id']}/authorize", get_token(), json_body={})
    for _ in range(5):
        ready = [cr for cr in pending_change_requests() if cr.get("readyToCommit") is True]
        if not ready:
            break
        for cr in ready:
            http("POST", f"/admin/realms/{REALM}/iga/change-requests/{cr['id']}/commit", get_token())


def port_in_use(port):
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


def docker(*args, check=True):
    result = subprocess.run(["docker", *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        die(f"docker {args[0]} failed: {result.stderr.strip()}")
    return result


# --- Step 0: refuse to wipe a container that already hosts realms ---
if os.environ.get("FORCE_WIPE") != "1" and http("GET", "/realms/master", timeout=3)[0] == 200:
    print(f"==> An instance is already responding on {TIDECLOAK_URL}; checking for existing realms...")
    code, body = http("POST", "/realms/master/protocol/openid-connect/token", form={
        "username": ADMIN_USER, "password": ADMIN_PASSWORD, "grant_type": "password", "client_id": "admin-cli"})
    token = (as_json(body) or {}).get("access_token")
    if token:
        realms = [r.get("realm") for r in as_json(http("GET", "/admin/realms", token)[1], [])]
        # `myrealm` is imported by the dev image itself on every start; it is not ours.
        existing = [r for r in realms if r not in ("master", "myrealm")]
        if existing:
            die(f"refusing to wipe: this container already hosts realm(s) {existing}. A realm cannot be "
                "un-flipped from multiAdmin. Set FORCE_WIPE=1 to wipe everything anyway.")

print("==> Cleaning previous state...")
docker("stop", "tidecloak", check=False)
docker("rm", "tidecloak", check=False)
DATA_DIR.mkdir(exist_ok=True)
for f in DATA_DIR.glob("keycloakdb*"):
    f.unlink()
if port_in_use(HOST_PORT):
    die(f"port {HOST_PORT} is already in use. Stop that service or change TIDECLOAK_URL in .env.")

# --- Step 1: start the container ---
# The dev image is wired to the PRODUCTION Tide network and ships working ORK/threshold defaults:
# do NOT pass SYSTEM_HOME_ORK, THRESHOLD_T/N or PAYER_PUBLIC, and do NOT append `start-dev`.
# `-e NAME` without a value passes the variable from our environment, keeping the password out of argv.
print(f"==> Starting TideCloak ({IMAGE}) on port {HOST_PORT}...")
docker("run", "-d", "--name", "tidecloak",
       "-v", f"{DATA_DIR}:/opt/keycloak/data/h2",
       "-p", f"{HOST_PORT}:8080",
       "-e", "KC_BOOTSTRAP_ADMIN_USERNAME", "-e", "KC_BOOTSTRAP_ADMIN_PASSWORD",
       IMAGE)

print("==> Waiting for TideCloak to start...")
for attempt in range(1, 31):
    if 0 < http("GET", "/", timeout=5)[0] < 400 and http("GET", "/realms/master", timeout=5)[0] == 200:
        break
    print(f"  Attempt {attempt}/30...")
    time.sleep(5)
else:
    die("TideCloak did not start within 150 seconds. Check `docker logs tidecloak`.")
print("  TideCloak is ready.")

# --- Step 2: create the realm from the template ---
print(f"==> Creating realm '{REALM}'...")
template = (HERE / "realm.json.template").read_text(encoding="utf-8")
realm_rep = json.loads(template.replace("REALM_NAME", REALM).replace("CLIENT_NAME", CLIENT))
for client in realm_rep["clients"]:
    if client["clientId"] == CLIENT:
        client["redirectUris"] = [u + suffix for u in APP_URLS
                                  for suffix in ("", "/*", "/silent-check-sso.html", "/auth/redirect")]
        client["webOrigins"] = APP_URLS
code, body = http("POST", "/admin/realms", get_token(), json_body=realm_rep)
if code not in (201, 204):
    die(f"realm creation failed (HTTP {code}): {body[:400]}")

# --- Step 3: never show Keycloak's "Update Account Information" page ---
# Tide asserts only a username (the vuid), so the stock first-broker-login review page would show
# an unstyled form with a 64-hex username. Must run BEFORE IGA, or it becomes a change request.
print("==> Disabling the first-broker-login profile page...")
flow_path = f"/admin/realms/{REALM}/authentication/flows/first%20broker%20login/executions"
review_cfg = {"alias": "review profile config", "config": {"update.profile.on.first.login": "off"}}
execs = as_json(http("GET", flow_path, get_token())[1], [])
review = next((e for e in execs if e.get("providerId") == "idp-review-profile"), None)
if review and review.get("authenticationConfig"):
    http("PUT", f"/admin/realms/{REALM}/authentication/config/{review['authenticationConfig']}",
         get_token(), json_body=review_cfg)
elif review:
    http("POST", f"/admin/realms/{REALM}/authentication/executions/{review['id']}/config",
         get_token(), json_body=review_cfg)
execs = as_json(http("GET", flow_path, get_token())[1], [])
review = next((e for e in execs if e.get("providerId") == "idp-review-profile"), {})
value = None
if review.get("authenticationConfig"):
    cfg = as_json(http("GET", f"/admin/realms/{REALM}/authentication/config/{review['authenticationConfig']}",
                       get_token())[1], {})
    value = cfg.get("config", {}).get("update.profile.on.first.login")
if value != "off":
    die(f"could not disable the first-broker-login profile page (read back {value!r}).")

# --- Step 4: license the realm, then enable IGA in Tide mode ---
print("==> Initializing Tide realm (licence + VRK)...")
code, body = http("POST", f"/admin/realms/{REALM}/vendorResources/setUpTideRealm", get_token(),
                  form={"email": LICENSE_EMAIL, "isRagnarokEnabled": "true"}, timeout=120)
if code == 303:
    die(f"setUpTideRealm answered 303 (paid checkout), so no free-tier licence was issued: {body[:600]}")
if not 200 <= code < 300:
    die(f"setUpTideRealm failed (HTTP {code}): {body[:600]}\n"
        "       The real cause is in `docker logs tidecloak` (look for '[Midgard]').")
if "NEED_PAYMENT" in body:
    die(f"setUpTideRealm answered NEED_PAYMENT: the realm is NOT licensed. Check the licence email.")

# Licensing with Ragnarok on makes `email` a REQUIRED profile attribute. Tide accounts carry no
# email, so that would block creating members (400 error-user-attribute-required) and the in-app
# name form. Make it optional; this write is not governed.
print("==> Making email optional in the user profile...")
profile = as_json(http("GET", f"/admin/realms/{REALM}/users/profile", get_token())[1], {})
for attribute in profile.get("attributes", []):
    if attribute.get("name") == "email":
        attribute.pop("required", None)
code, body = http("PUT", f"/admin/realms/{REALM}/users/profile", get_token(), json_body=profile)
if code != 200:
    die(f"could not make email optional (HTTP {code}): {body[:300]}")

print("==> Stamping iga.attestor=tide...")
realm_now = as_json(http("GET", f"/admin/realms/{REALM}", get_token())[1], {})
realm_now["attributes"] = {**(realm_now.get("attributes") or {}), "iga.attestor": "tide"}
http("PUT", f"/admin/realms/{REALM}", get_token(), json_body=realm_now)

print("==> Enabling IGA...")
# toggle-iga is a FLIP on current builds: call it at most once, and only when IGA is off.
realm_now = as_json(http("GET", f"/admin/realms/{REALM}", get_token())[1], {})
if str((realm_now.get("attributes") or {}).get("isIGAEnabled", "false")).lower() == "true":
    print("    IGA is already enabled on this realm; not calling toggle-iga again.")
else:
    code, body = http("POST", f"/admin/realms/{REALM}/tide-admin/toggle-iga", get_token(),
                      form={"isIGAEnabled": "true"}, timeout=120)
    if '"enabled":true' not in body.replace(" ", ""):
        die(f"toggle-iga did not report enabled=true (HTTP {code}): {body[:600]}")
    if '"warnings"' in body or "commitFailures" in body:
        print(f"WARNING: toggle-iga reported warnings. Read them before continuing: {body[:800]}", file=sys.stderr)

# --- Step 5: approve change requests, create the organisation's people ---
print("==> Approving client and role change requests...")
time.sleep(2)
approve_all_pending()

# The owner is also the realm admin. With SIGNGUARD_DEMO=1 (the default) a director and an
# accountant are created too, so the whole approval flow can be shown end to end.
MEMBERS = [
    {"username": "owner", "firstName": "An", "lastName": "Nguyễn Văn", "email": LICENSE_EMAIL, "realmAdmin": True,
     "roles": ["sg_owner", "sg_director", "sg_viewer", "_tide_decryptor"]},
]
if os.environ.get("SIGNGUARD_DEMO", "1") != "0":
    MEMBERS += [
        {"username": "director", "firstName": "Cường", "lastName": "Lê Văn",
         "roles": ["sg_director", "sg_viewer", "_tide_decryptor"]},
        {"username": "accountant", "firstName": "Bình", "lastName": "Trần Thị",
         "roles": ["sg_drafter", "sg_viewer", "_tide_decryptor", "_tide_encryptor"]},
    ]


def find_user(username):
    users = as_json(http("GET", f"/admin/realms/{REALM}/users?username={username}&exact=true", get_token())[1], [])
    return users[0] if users else None


print(f"==> Creating {len(MEMBERS)} member account(s): {', '.join(m['username'] for m in MEMBERS)}...")
for m in MEMBERS:
    rep = {"username": m["username"], "firstName": m["firstName"], "lastName": m["lastName"], "enabled": True,
           "emailVerified": False, "attributes": {"tideInvitable": ["true"]}}
    if m.get("email"):
        rep["email"] = m["email"]
    http("POST", f"/admin/realms/{REALM}/users", get_token(), json_body=rep)
time.sleep(2)
approve_all_pending()
for m in MEMBERS:
    user = find_user(m["username"])
    if not user:
        die(f"could not find user {m['username']} after creation. Check change-request approval.")
    m["id"] = user["id"]

# --- Step 6: invite links, then wait for every member to link a Tide account ---
# Roles are assigned only AFTER linking: a role grant is signed with the user's Tide identity, and
# one made before linking stays an unsignable draft forever (canon tidecloak-bootstrap).
print("==> Generating invite links...")
links = {}
for m in MEMBERS:
    code, body = http("POST", f"/admin/realms/{REALM}/tideAdminResources/get-required-action-link"
                              f"?userId={m['id']}&lifespan=43200", get_token(), json_body=["link-tide-account-action"])
    link = body.strip().strip('"')
    if not link.startswith("http"):
        die(f"could not generate the invite link for {m['username']} (HTTP {code}): {body[:400]}")
    links[m["username"]] = link
(DATA_DIR / "invite-links.json").write_text(json.dumps(links, indent=2) + "\n", encoding="utf-8")
(DATA_DIR / "invite-link.txt").write_text(links["owner"] + "\n", encoding="utf-8")
print("")
print("============================================")
print("Each person opens their link once and creates their Tide account:")
for username, link in links.items():
    print(f"  {username}: {link}")
print(f"(also saved to {DATA_DIR / 'invite-links.json'})")
print("============================================")
print("")
print("Waiting for every member to link a Tide account (polling every 5s)...")
waiting = {m["username"] for m in MEMBERS}
while waiting:
    for username in sorted(waiting):
        if ((find_user(username) or {}).get("attributes") or {}).get("tideUserKey"):
            print(f"  {username} linked.")
            waiting.discard(username)
            approve_all_pending()  # the tideUserKey write is itself a change request
    if waiting:
        time.sleep(5)

# --- Step 6b: roles, one at a time (IGA allows one pending change request per user) ---
print("==> Assigning roles...")
for m in MEMBERS:
    for role_name in m["roles"]:
        role_rep = as_json(http("GET", f"/admin/realms/{REALM}/roles/{role_name}", get_token())[1], {})
        if not role_rep.get("id"):
            die(f"role {role_name} not found")
        code, body = http("POST", f"/admin/realms/{REALM}/users/{m['id']}/role-mappings/realm", get_token(), json_body=[role_rep])
        if code not in (200, 201, 202, 204):
            die(f"granting {role_name} to {m['username']} failed (HTTP {code}): {body[:300]}")
        time.sleep(1)
        approve_all_pending()
    have = {r["name"] for r in as_json(http("GET", f"/admin/realms/{REALM}/users/{m['id']}/role-mappings/realm", get_token())[1], [])}
    missing = [r for r in m["roles"] if r not in have]
    if missing:
        die(f"{m['username']} is missing roles after approval: {missing}")
    print(f"    {m['username']}: {', '.join(m['roles'])}")

# --- Step 7: point the tide IdP at this realm's console, sign it, grant tide-realm-admin LAST ---
print("==> Configuring CustomAdminUIDomain (console origin) + signing IdP settings...")
idp = as_json(http("GET", f"/admin/realms/{REALM}/identity-provider/instances/tide", get_token())[1], {})
idp.setdefault("config", {})["CustomAdminUIDomain"] = f"{TIDECLOAK_URL}/realms/{REALM}/tide-console/"
code, _ = http("PUT", f"/admin/realms/{REALM}/identity-provider/instances/tide", get_token(), json_body=idp)
print(f"    IdP update: HTTP {code}")
code, body = http("POST", f"/admin/realms/{REALM}/vendorResources/sign-idp-settings", get_token(), timeout=120)
print(f"    sign-idp-settings: HTTP {code}")
if not 200 <= code < 300:
    print(f"WARNING: sign-idp-settings failed: {body[:400]}", file=sys.stderr)

print("==> Granting tide-realm-admin to the realm admin(s)...")
rm_clients = as_json(http("GET", f"/admin/realms/{REALM}/clients?clientId=realm-management", get_token())[1], [])
if not rm_clients:
    die("realm-management client not found.")
RM_UUID = rm_clients[0]["id"]
role = as_json(http("GET", f"/admin/realms/{REALM}/clients/{RM_UUID}/roles/tide-realm-admin", get_token())[1], {})
if not role.get("id"):
    die(f"tide-realm-admin role not found: {role}")
for m in MEMBERS:
    if m.get("realmAdmin"):
        http("POST", f"/admin/realms/{REALM}/users/{m['id']}/role-mappings/clients/{RM_UUID}", get_token(), json_body=[role])

# Final drain: commits GRANT_ROLES and flips firstAdmin -> multiAdmin. No governed write after this.
print("==> Final drain (commit grant + firstAdmin -> multiAdmin flip)...")
time.sleep(2)
approve_all_pending()

# --- Step 8: export the adapter config ---
print("==> Exporting adapter config...")
clients = as_json(http("GET", f"/admin/realms/{REALM}/clients?clientId={CLIENT}", get_token())[1], [])
code, body = http("GET", f"/admin/realms/{REALM}/vendorResources/get-installations-provider"
                         f"?clientId={clients[0]['id']}&providerId=keycloak-oidc-keycloak-json", get_token())
adapter = as_json(body)
if code != 200 or not isinstance(adapter, dict):
    die(f"adapter export failed (HTTP {code}): {body[:400]}")
ADAPTER_OUTPUT.write_text(json.dumps(adapter, indent=2) + "\n", encoding="utf-8")
missing = [k for k in ("jwk", "vendorId", "homeOrkUrl") if k not in adapter]
if missing:
    die(f"adapter config is missing {missing}: licensing did not complete. Do not hand-edit it.")

print("")
print("============================================")
print("Bootstrap complete!")
print(f"Adapter config: {ADAPTER_OUTPUT}")
print(f"TideCloak URL:  {TIDECLOAK_URL}")
print(f"Realm:          {REALM}")
print(f"Client:         {CLIENT}")
print(f"App origins:    {', '.join(APP_URLS)}")
print("============================================")
