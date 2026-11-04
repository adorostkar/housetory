"""Provider-neutral transactional email with a captured development transport."""

from __future__ import annotations

import contextlib
import json
import logging
import smtplib
import ssl
import threading
from dataclasses import dataclass
from email.message import EmailMessage as StdEmailMessage
from email.utils import formataddr
from pathlib import Path
from typing import Protocol

from ..config import Settings, get_settings

logger = logging.getLogger("housetory.email")


class EmailError(RuntimeError):
    pass


class EmailNotConfigured(EmailError):
    pass


class EmailDeliveryError(EmailError):
    pass


@dataclass(frozen=True)
class EmailMessage:
    to: str
    subject: str
    text: str


class EmailTransport(Protocol):
    def send(self, message: EmailMessage) -> None: ...


class SmtpEmailTransport:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def send(self, message: EmailMessage) -> None:
        settings = self.settings
        if not settings.email_configured:
            raise EmailNotConfigured("Email delivery is not configured.")
        email = StdEmailMessage()
        email["From"] = formataddr(
            (settings.smtp_from_name.strip() or "Housetory", settings.smtp_from_address)
        )
        email["To"] = message.to
        email["Subject"] = message.subject
        email.set_content(message.text)
        context = ssl.create_default_context()
        try:
            if settings.smtp_tls_mode == "ssl":
                smtp = smtplib.SMTP_SSL(
                    settings.smtp_host,
                    settings.smtp_port,
                    timeout=settings.smtp_timeout_seconds,
                    context=context,
                )
            else:
                smtp = smtplib.SMTP(
                    settings.smtp_host,
                    settings.smtp_port,
                    timeout=settings.smtp_timeout_seconds,
                )
            try:
                smtp.ehlo()
                if settings.smtp_tls_mode == "starttls":
                    smtp.starttls(context=context)
                    smtp.ehlo()
                if settings.smtp_username:
                    smtp.login(settings.smtp_username, settings.smtp_password)
                smtp.send_message(email)
            finally:
                with contextlib.suppress(Exception):
                    smtp.quit()
        except (OSError, smtplib.SMTPException) as exc:
            logger.warning(
                "Email delivery failed for %s (%s)",
                message.to.rsplit("@", 1)[-1],
                type(exc).__name__,
            )
            raise EmailDeliveryError("Email delivery failed.") from None


class CapturedEmailTransport:
    """Development/test transport; never sends mail and never writes logs."""

    def __init__(self, persist_dir: Path | None = None) -> None:
        self.persist_dir = persist_dir
        self._messages: list[EmailMessage] = []
        self._lock = threading.Lock()

    def send(self, message: EmailMessage) -> None:
        with self._lock:
            self._messages.append(message)
            if self.persist_dir is not None:
                self.persist_dir.mkdir(parents=True, exist_ok=True)
                with contextlib.suppress(OSError):
                    self.persist_dir.chmod(0o700)
                path = self.persist_dir / f"{len(self._messages):04d}.json"
                path.write_text(
                    json.dumps(
                        {
                            "to": message.to,
                            "subject": message.subject,
                            "text": message.text,
                        },
                        indent=2,
                    ),
                    encoding="utf-8",
                )
                with contextlib.suppress(OSError):
                    path.chmod(0o600)

    def messages(self) -> list[EmailMessage]:
        with self._lock:
            return list(self._messages)

    def clear(self) -> None:
        with self._lock:
            self._messages.clear()


_captured_transport = CapturedEmailTransport()


def reset_captured_email() -> None:
    _captured_transport.clear()


def captured_messages() -> list[EmailMessage]:
    return _captured_transport.messages()


def get_transport(settings: Settings | None = None) -> EmailTransport:
    settings = settings or get_settings()
    if settings.email_configured:
        return SmtpEmailTransport(settings)
    if settings.environment in {"development", "test"}:
        if settings.environment == "development":
            _captured_transport.persist_dir = settings.data_dir / "mail-capture"
        return _captured_transport
    raise EmailNotConfigured("Email is not configured. Set SMTP_HOST and SMTP_FROM_ADDRESS.")


def email_configured(settings: Settings | None = None) -> bool:
    settings = settings or get_settings()
    return settings.email_configured or settings.environment in {"development", "test"}


def absolute_link(path: str, settings: Settings | None = None) -> str:
    settings = settings or get_settings()
    return f"{settings.app_base_url.rstrip('/')}/{path.lstrip('/')}"


def send_invitation(
    *,
    to: str,
    household_name: str,
    inviter_name: str,
    role: str,
    token: str,
    expires_at,
    settings: Settings | None = None,
) -> None:
    settings = settings or get_settings()
    role_label = {"owner": "an owner", "member": "a member", "viewer": "a viewer"}.get(
        role, "a member"
    )
    link = absolute_link(f"/invitations/{token}", settings)
    text = (
        f"Hello,\n\n"
        f"{inviter_name} invited you to join {household_name} as {role_label}.\n\n"
        f"Accept the invitation:\n{link}\n\n"
        f"This single-use link expires {expires_at.strftime('%Y-%m-%d %H:%M UTC')}.\n"
        "If you were not expecting this invitation, ignore this message.\n"
    )
    get_transport(settings).send(
        EmailMessage(
            to=to,
            subject=f"Invitation to join {household_name} on Housetory",
            text=text,
        )
    )


def send_password_reset(
    *,
    to: str,
    name: str,
    token: str,
    expires_at,
    settings: Settings | None = None,
) -> None:
    settings = settings or get_settings()
    link = absolute_link(f"/reset-password/{token}", settings)
    text = (
        f"Hello {name},\n\n"
        "A password reset was requested for your Housetory account.\n\n"
        f"Choose a new password:\n{link}\n\n"
        f"This single-use link expires {expires_at.strftime('%Y-%m-%d %H:%M UTC')}.\n"
        "If you did not request this, ignore this message; no password has changed.\n"
    )
    get_transport(settings).send(
        EmailMessage(
            to=to,
            subject="Reset your Housetory password",
            text=text,
        )
    )
