# Housetory desktop (Tauri 2)

The macOS desktop application is intentionally **not scaffolded yet**. The
product plan adds a Tauri 2 shell after the web application has proven stable, so
the desktop target does not duplicate UI work or ship a half-built wrapper.

When work begins:

1. Install Rust and the Tauri 2 prerequisites for macOS.
2. Scaffold a Tauri 2 app here that loads either the deployed Housetory URL or a
   bundled production build of `apps/web`.
3. Keep credentials out of the bundle. Authentication continues to use the
   server's HttpOnly session cookie.
4. Add macOS window chrome, menu bar shortcuts, and code signing/notarization.

See `IMPLEMENTATION_PLAN.md` — Phase 6.
