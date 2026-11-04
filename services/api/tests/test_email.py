import smtplib

import pytest

from housetory_api.config import get_settings
from housetory_api.services import email as email_service


def _configure(monkeypatch, *, tls_mode="starttls"):
    settings = get_settings()
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.test")
    monkeypatch.setattr(settings, "smtp_port", 587)
    monkeypatch.setattr(settings, "smtp_tls_mode", tls_mode)
    monkeypatch.setattr(settings, "smtp_username", "mailer")
    monkeypatch.setattr(settings, "smtp_password", "secret")
    monkeypatch.setattr(settings, "smtp_from_address", "noreply@example.test")
    monkeypatch.setattr(settings, "smtp_from_name", "Housetory Test")
    return settings


class FakeSmtp:
    instances = []

    def __init__(self, host, port, timeout=None, context=None):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.context = context
        self.ehlo_calls = 0
        self.starttls_calls = 0
        self.login_args = None
        self.message = None
        self.quit_called = False
        FakeSmtp.instances.append(self)

    def ehlo(self):
        self.ehlo_calls += 1

    def starttls(self, context=None):
        self.starttls_calls += 1
        self.context = context

    def login(self, username, password):
        self.login_args = (username, password)

    def send_message(self, message):
        self.message = message

    def quit(self):
        self.quit_called = True


def test_starttls_transport_uses_configured_credentials(monkeypatch):
    settings = _configure(monkeypatch)
    FakeSmtp.instances = []
    monkeypatch.setattr(email_service.smtplib, "SMTP", FakeSmtp)
    transport = email_service.SmtpEmailTransport(settings)
    transport.send(
        email_service.EmailMessage(
            to="person@example.test",
            subject="Subject",
            text="Body",
        )
    )
    instance = FakeSmtp.instances[-1]
    assert instance.host == "smtp.example.test"
    assert instance.port == 587
    assert instance.starttls_calls == 1
    assert instance.login_args == ("mailer", "secret")
    assert instance.message["From"] == "Housetory Test <noreply@example.test>"
    assert instance.message["To"] == "person@example.test"
    assert instance.quit_called is True


def test_implicit_tls_transport_uses_smtp_ssl(monkeypatch):
    settings = _configure(monkeypatch, tls_mode="ssl")
    monkeypatch.setattr(settings, "smtp_port", 465)
    FakeSmtp.instances = []
    monkeypatch.setattr(email_service.smtplib, "SMTP_SSL", FakeSmtp)
    transport = email_service.SmtpEmailTransport(settings)
    transport.send(email_service.EmailMessage(to="person@example.test", subject="S", text="B"))
    instance = FakeSmtp.instances[-1]
    assert instance.port == 465
    assert instance.starttls_calls == 0


def test_smtp_failure_is_reported_without_leaking_content(monkeypatch):
    settings = _configure(monkeypatch)

    class FailingSmtp(FakeSmtp):
        def send_message(self, message):
            raise smtplib.SMTPException("upstream failed")

    FakeSmtp.instances = []
    monkeypatch.setattr(email_service.smtplib, "SMTP", FailingSmtp)
    transport = email_service.SmtpEmailTransport(settings)
    with pytest.raises(email_service.EmailDeliveryError):
        transport.send(
            email_service.EmailMessage(
                to="person@example.test",
                subject="Secret subject",
                text="http://example.test/reset-password/secret-token",
            )
        )


def test_absolute_links_use_configured_origin_not_request_host(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "app_base_url", "https://inventory.example.test")
    link = email_service.absolute_link("/invitations/token-value", settings)
    assert link == "https://inventory.example.test/invitations/token-value"
