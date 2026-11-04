"""Encrypted-at-rest API credentials for household AI providers.

The encryption key is deliberately read from the environment, not the database.
Credentials never leave the backend in plaintext and are never logged.
"""

import base64
import binascii

from cryptography.fernet import Fernet, InvalidToken

from ..config import get_settings

PREFIX = "fernet:v1:"


class CredentialError(RuntimeError):
    pass


class CredentialUnavailable(CredentialError):
    pass


def _fernet(key: str) -> Fernet:
    try:
        raw = base64.urlsafe_b64decode(key.encode("ascii"))
    except (ValueError, binascii.Error, UnicodeEncodeError):
        raise CredentialUnavailable("AI_CREDENTIAL_KEY is not valid base64.") from None
    if len(raw) != 32:
        raise CredentialUnavailable(
            "AI_CREDENTIAL_KEY must encode exactly 32 bytes (use Fernet.generate_key())."
        )
    try:
        return Fernet(key.encode("ascii"))
    except (ValueError, TypeError):
        raise CredentialUnavailable("AI_CREDENTIAL_KEY is not a valid Fernet key.") from None


def key_configured() -> bool:
    return get_settings().ai_credential_key_configured


def encrypt_secret(secret: str) -> str:
    settings = get_settings()
    if not settings.ai_credential_key:
        raise CredentialUnavailable(
            "Set AI_CREDENTIAL_KEY in the deployment environment before saving API keys."
        )
    token = _fernet(settings.ai_credential_key).encrypt(secret.encode("utf-8"))
    return f"{PREFIX}{token.decode('ascii')}"


def decrypt_secret(value: str | None) -> str | None:
    if not value:
        return None
    if not value.startswith(PREFIX):
        raise CredentialUnavailable("Stored AI credential format is unsupported.")
    settings = get_settings()
    token = value[len(PREFIX) :].encode("ascii")
    keys = [settings.ai_credential_key, settings.ai_credential_key_previous]
    for key in keys:
        if not key:
            continue
        try:
            return _fernet(key).decrypt(token).decode("utf-8")
        except (InvalidToken, CredentialUnavailable):
            continue
    raise CredentialUnavailable(
        "Saved AI credential cannot be decrypted with the configured key. "
        "Restore the matching AI_CREDENTIAL_KEY or replace the credential."
    )


def rotate_secret(value: str | None) -> str | None:
    if not value:
        return None
    return encrypt_secret(decrypt_secret(value) or "")


def generate_key() -> str:
    return Fernet.generate_key().decode("ascii")
