"""ONE-TIME, run on your own computer. Logs in to Garmin Connect (asks for the MFA code if you
use one) and prints a base64 token bundle to store as the GitHub secret GARMIN_TOKENS_B64.

    pip install "garminconnect>=0.3.10"
    python scripts/garmin_login.py

Tokens are long lived, so you normally do this once. Never commit the output.
"""
import base64
import getpass
import io
import os
import tarfile
import tempfile

from garminconnect import Garmin

email = input("Garmin email: ").strip()
password = getpass.getpass("Garmin password: ")
tokdir = tempfile.mkdtemp(prefix="garmin-tokens-")

client = Garmin(email, password, prompt_mfa=lambda: input("MFA code (check your email/app): ").strip())
client.login(tokdir)

buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as t:
    for name in os.listdir(tokdir):
        t.add(os.path.join(tokdir, name), arcname=name)
print("\nLogin OK. Save this whole line as the GitHub secret GARMIN_TOKENS_B64:\n")
print(base64.b64encode(buf.getvalue()).decode())
