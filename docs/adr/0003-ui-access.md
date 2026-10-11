# ADR-0003: Interface access

Status: accepted by the owner 2026-10-01

## Context

RFC §8 requires secure access for a remote UI on one's own VMs/Docker.

## Decision

- By default the daemon listens only on 127.0.0.1.
- Any access to the HTTP API and the UI requires a bearer token that the CLI generates and prints; the UI receives it via a one-time link and stores it in an `HttpOnly; SameSite=Strict` cookie.
- Remote access is an SSH tunnel or an explicit bind to an interface with the same mandatory token. The daemon has no TLS of its own.
- The hook event intake endpoint listens only on loopback or a Unix socket and uses a separate intake token.

## Consequences

A secure-by-default local mode without certificate infrastructure. Channel encryption for remote access is provided by the tunnel or an external proxy.

## Owner decisions

Accepted by the owner 2026-10-04:

1. CSRF protection for requests with a cookie. `SameSite=Strict` does not separate pages on other ports of 127.0.0.1: the port is not part of the site, and the browser sends the daemon's cookie along with their requests. A simple `POST` with `text/plain` (a form or `fetch` in `no-cors` mode) goes without a preflight, and the daemon parses the body as JSON regardless of the type. Without protection, such a page stops the daemon via `POST /api/admin/shutdown`. Therefore:
   - the check runs in the daemon's router before route selection and covers all write routes, including future ones, and static files;
   - it applies to cookie-authorized requests with unsafe methods — all except `GET`, `HEAD`, `OPTIONS` and `TRACE`, i.e. `POST`, `PUT`, `PATCH` and `DELETE`;
   - `Origin` must match the daemon's origin, and if `Origin` is absent, `Sec-Fetch-Site: same-origin` is required; otherwise — 403 `forbidden`. `Origin: null` is rejected;
   - the body must have `Content-Type: application/json`, parameters such as `charset` are allowed; the requirement applies to `DELETE` without a body too; otherwise — 415 `unsupported_media_type`. The origin is checked before the type;
   - requests with a valid bearer token (CLI) are not checked: the browser will not send an `Authorization` header to another origin without a preflight, and the daemon does not allow CORS. A request with an invalid bearer and a valid cookie is checked as a cookie request;
   - reads (`GET`, `HEAD`, SSE) are not affected. The web client sends mutating requests from its own page with `Content-Type: application/json`.

   The daemon's origin is exactly `http://127.0.0.1:P` and `http://localhost:P`, where P is the port the daemon listens on. `Origin` is compared against them in full: scheme, host and port. A malformed `Origin` is rejected the same way as `Origin: null`. Without `Origin`, a request is accepted only with `Sec-Fetch-Site: same-origin` and a `Host` from the same list (`127.0.0.1:P` or `localhost:P`). When `Origin` is present, the `Host` header is not considered. An SSH tunnel forwards the same port: `ssh -L P:127.0.0.1:P`.
