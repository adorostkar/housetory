# Tailscale access for Housetory

Housetory should never be exposed directly to the public internet. Tailscale
Serve gives the application an HTTPS URL inside your tailnet, using a certificate
managed by Tailscale, and forwards traffic to the nginx container on loopback.

This guide assumes a Linux server and an iPhone on the same tailnet.

## 1. Server prerequisites

```bash
# Docker Engine + Compose plugin
docker --version
docker compose version

# Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status
```

MagicDNS must be enabled in the tailnet (it is on by default). Note the full
machine name, for example:

```
housetory-server.tailnet-abc123.ts.net
```

That DNS name only resolves inside the tailnet. No public DNS record is needed.

## 2. Start Housetory on loopback

On the server:

```bash
cd /opt/housetory
cp .env.example .env
openssl rand -hex 24       # paste into POSTGRES_PASSWORD
$EDITOR .env
```

Set:

```dotenv
APP_BASE_URL=https://housetory-server.tailnet-abc123.ts.net
COOKIE_SECURE=true
WEB_PORT=8080
```

Then:

```bash
docker compose up --build -d
docker compose ps
curl -fsS http://127.0.0.1:8080/api/v1/health/ready
```

The web port is bound to `127.0.0.1` by Compose. It is not reachable from other
machines directly.

> `APP_BASE_URL` is also the origin allowed to submit forms. It must match the
> HTTPS URL exactly, with no trailing slash. API returns
> `403 origin_not_allowed` if it does not.

## 3. Serve it over Tailscale HTTPS

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
sudo tailscale serve status
```

Expected shape:

```
https://housetory-server.tailnet-abc123.ts.net
|-- / proxy http://127.0.0.1:8080
```

The certificate is obtained automatically by Tailscale. There is no Certbot, no
public DNS dependency, and no additional reverse proxy.

If HTTPS port 443 is already used on the host, use another port:

```bash
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8080
```

Then use `https://housetory-server.tailnet-abc123.ts.net:8443` as
`APP_BASE_URL`.

Remove the serve configuration with:

```bash
sudo tailscale serve reset
```

**Never run `tailscale funnel`.** Funnel publishes to the public internet and is
not appropriate for private household data.

## 4. Tailnet access control

At minimum, only allow your own devices/users to reach this machine. Tailscale
ACLs can express this. For a single-user tailnet the default grants are usually
sufficient, but review them in the Tailscale admin console.

Do not add firewall port forwards or public load balancers for ports 8080/8000/
5432. Keep the host firewall closed to inbound traffic except what Tailscale and
your SSH policy require.

## 5. Install on iPhone

1. Install Tailscale from the App Store and sign in to the same tailnet.
2. Open Safari and visit the HTTPS address from section 3.
3. Sign in to Housetory (or complete first-run setup).
4. Tap the Share button → **Add to Home Screen**.
5. Launch it from the home screen. It opens standalone, without Safari chrome.

The manifest and Apple metadata are already included. The service worker caches
only the application shell; it never caches API responses or inventory data.

## 6. Verify

On the server:

```bash
curl -fsS https://housetory-server.tailnet-abc123.ts.net/api/v1/health/ready
```

From an iPhone on the tailnet, open the URL over HTTPS. In Safari's page info you
should see a valid certificate for the `*.ts.net` name.

Check cookie behavior after signing in: the `housetory_session` cookie must be
`Secure`, `HttpOnly`, and `SameSite=Lax`. If sign-in loops back to the login page:

- `COOKIE_SECURE` must be `true` for HTTPS.
- `APP_BASE_URL` must exactly match the HTTPS origin.
- The iPhone clock must be correct.
- Try Safari private browsing off; cookies may be blocked there.

## 7. Updating Housetory

```bash
cd /opt/housetory
git pull
docker compose up --build -d
docker compose ps
```

The one-shot `migrate` service applies pending migrations before the new API
starts. Take a backup first for major updates:

```bash
./scripts/backup.sh
```

## 8. Backups

```bash
./scripts/backup.sh
```

Copy the resulting directory off the server. Schedule with cron or a systemd
timer. Restores are destructive and documented in the README.

Do not back up the PostgreSQL container's raw data directory while it is running;
use the provided `pg_dump` script.
