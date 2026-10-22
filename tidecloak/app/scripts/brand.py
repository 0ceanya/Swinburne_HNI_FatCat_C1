"""Upload SignGuard's login branding to the Tide enclave.

Python port of the Tide Agent Pack's templates/enclave-branding/brand-tidecloak.sh (no jq needed):
pre-flight the realm's tide-vendor-key -> upload LOGO + BACKGROUND_IMAGE -> set-branding (save AND
re-sign) -> verify. Branding is IGA-exempt, so it works after the multiAdmin flip. Safe to re-run.

Regenerate the images first with the pack's generator:
    python make-branding.py --kind vault --name SignGuard --accent 1e3a8a --out branding
Then:
    python scripts/brand.py            (reads ../.env for the master-admin credentials)
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
APP_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = APP_DIR.parent / ".env"


def load_env(path):
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


load_env(ENV_FILE)
URL = os.environ.get("TIDECLOAK_URL", "http://localhost:8081").rstrip("/")
REALM = os.environ.get("REALM_NAME", "signguard")
USER = os.environ.get("KC_BOOTSTRAP_ADMIN_USERNAME", "admin")
PASSWORD = os.environ.get("KC_BOOTSTRAP_ADMIN_PASSWORD")
if not PASSWORD:
    sys.exit("ERROR: KC_BOOTSTRAP_ADMIN_PASSWORD is not set in tidecloak/.env")

ASSETS = {"LOGO": APP_DIR / "branding" / "logo.png", "BACKGROUND_IMAGE": APP_DIR / "branding" / "background.png"}


def request(method, url, token=None, data=None, headers=None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def token():
    # Master-admin tokens live ~60 seconds: mint one per call.
    body = urllib.parse.urlencode({"username": USER, "password": PASSWORD,
                                   "grant_type": "password", "client_id": "admin-cli"}).encode()
    code, text = request("POST", f"{URL}/realms/master/protocol/openid-connect/token", data=body,
                         headers={"Content-Type": "application/x-www-form-urlencoded"})
    if code != 200:
        sys.exit(f"ERROR: could not mint an admin token (HTTP {code})")
    return json.loads(text)["access_token"]


# 1. Pre-flight: set-branding needs the tide-vendor-key component (a licensed realm).
code, text = request("GET", f"{URL}/admin/realms/{REALM}/components", token())
if code != 200 or not any(c.get("providerId") == "tide-vendor-key" for c in json.loads(text)):
    sys.exit(f"ERROR: realm '{REALM}' has no tide-vendor-key component (HTTP {code}). Nothing uploaded.")

# 2. Upload each asset (multipart: fileData, fileName, fileType).
serve = {}
for file_type, path in ASSETS.items():
    if not path.exists():
        sys.exit(f"ERROR: {path} is missing. Run the pack's make-branding.py first.")
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in (("fileName", path.name), ("fileType", file_type)):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="fileData"; filename="{path.name}"\r\n'
                 f"Content-Type: image/png\r\n\r\n".encode() + path.read_bytes() + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    code, text = request("POST", f"{URL}/admin/realms/{REALM}/tide-idp-admin-resources/images/upload", token(),
                         data=b"".join(parts), headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    digest = (json.loads(text) if text.startswith("{") else {}).get("hash")
    if code >= 300 or not digest:
        sys.exit(f"ERROR: upload of {file_type} failed (HTTP {code}): {text[:300]}")
    serve[file_type] = f"{URL}/realms/{REALM}/tide-idp-resources/images/{file_type}?v={digest}"
    print(f"--> uploaded {file_type} (sha256 {digest[:12]}...)")

# 3. Save AND re-sign in one call; the enclave verifies the signed settings blob.
code, text = request("POST", f"{URL}/admin/realms/{REALM}/vendorResources/set-branding", token(),
                     data=json.dumps({"logoUrl": serve["LOGO"], "backgroundUrl": serve["BACKGROUND_IMAGE"]}).encode(),
                     headers={"Content-Type": "application/json"})
if code >= 300:
    sys.exit(f"ERROR: set-branding returned {code}: {text[:300]}")
print(f"--> set-branding: {text.strip()[:120]}")

# 4. Verify the public image endpoints serve what we uploaded.
for file_type, path in ASSETS.items():
    code, _ = request("GET", f"{URL}/realms/{REALM}/tide-idp-resources/images/{file_type}")
    print(f"--> public {file_type}: HTTP {code}")
print("Done. Hard-refresh the login page to see the new branding.")
