"""
Resets the password of one dashboard account. Console only.

    python scripts/reset-user-password.py you@example.com

There is no "forgot password" flow in the app, and passwords are stored only
as salted scrypt hashes, so a forgotten password cannot be recovered - it can
only be replaced. This writes a new hash into the same Redis (Upstash REST)
store the app uses:

    user:email:<email>  ->  <user id>
    user:<id>           ->  JSON user record (passwordHash is replaced)

The new password and the database token are typed at the prompt (not echoed),
so neither ends up in shell history or in a chat. Nothing is written until you
type "yes" after the account has been found and shown to you.

The hash format matches lib/auth.mjs: "<salt hex>:<scrypt hex>" with Node's
scryptSync defaults (N=16384, r=8, p=1, 64-byte key) and the hex salt string
used as the salt.

Needs only the Python standard library.
"""
import getpass
import hashlib
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

SCRYPT_KEYLEN = 64


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"), salt=salt.encode("utf-8"), n=16384, r=8, p=1, dklen=SCRYPT_KEYLEN
    ).hex()
    return f"{salt}:{derived}"


def normalise_email(email: str) -> str:
    return (email or "").strip().lower()


def is_valid_email(email: str) -> bool:
    return 3 <= len(email) <= 254 and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) is not None


def is_acceptable_password(password: str) -> bool:
    return 10 <= len(password) <= 200


def redis_command(url: str, token: str, *parts):
    request = urllib.request.Request(
        url,
        data=json.dumps(list(parts)).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        raise SystemExit(f"Database request failed: HTTP {err.code} (check the URL and token).")
    except urllib.error.URLError as err:
        raise SystemExit(f"Could not reach the database: {err.reason}")
    if body.get("error"):
        raise SystemExit(f"Redis command failed: {body['error']}")
    return body.get("result")


def main() -> None:
    email = normalise_email(sys.argv[1]) if len(sys.argv) > 1 else normalise_email(input("Account email: "))
    if not is_valid_email(email):
        raise SystemExit("That does not look like an email address.")

    url = os.environ.get("KV_REST_API_URL") or input("KV_REST_API_URL: ").strip()
    token = os.environ.get("KV_REST_API_TOKEN") or getpass.getpass("KV_REST_API_TOKEN (hidden): ").strip()
    if not url or not token:
        raise SystemExit("The database URL and token are both required.")

    user_id = redis_command(url, token, "GET", f"user:email:{email}")
    if not user_id:
        raise SystemExit(f"No account found for {email}. Nothing was changed. Use 'Create one' on the login page instead.")

    raw = redis_command(url, token, "GET", f"user:{user_id}")
    if not raw:
        raise SystemExit(f"The email index points at user {user_id}, but that user record is missing. Nothing was changed.")
    user = json.loads(raw)

    print()
    print(f"Account found: {user.get('email')}")
    print(f"  user id   : {user_id}")
    print(f"  created   : {user.get('createdAt')}")
    print(f"  updated   : {user.get('updatedAt')}")
    print()

    password = getpass.getpass("New password (10-200 characters, hidden): ")
    if not is_acceptable_password(password):
        raise SystemExit("The password must be between 10 and 200 characters. Nothing was changed.")
    if getpass.getpass("Type it again to confirm: ") != password:
        raise SystemExit("The two passwords did not match. Nothing was changed.")

    answer = input(f"Replace the password for {email} on this database? Type 'yes' to continue: ").strip().lower()
    if answer != "yes":
        raise SystemExit("Cancelled. Nothing was changed.")

    user["passwordHash"] = hash_password(password)
    user["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    redis_command(url, token, "SET", f"user:{user_id}", json.dumps(user))
    print()
    print("Done. Sign in at /login with that email and the new password.")


if __name__ == "__main__":
    main()
