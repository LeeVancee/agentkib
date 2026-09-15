# AgentKib LAN transport

This crate owns a private-IPv4 listener, mDNS discovery, device identity and
one-way read-only authorization. `RemoteService::request` is blocking: desktop
integration must dispatch it on a dedicated worker, not the main RPC loop.

## Trust boundary

- TLS 1.3 requires certificates on both sides. During pairing, certificates
  prove private-key possession without Web PKI trust. All subsequent outbound
  connections pin the complete certificate fingerprint.
- An eight-digit code expires after five minutes or five failed attempts. One
  successful submission consumes it. Host approval is still required.
- Both devices independently derive the displayed verification number from the
  TLS exporter and both certificate IDs. The host must compare it with the
  controller's display before approval; the controller never trusts a number
  sent by the peer.
- Only `pair`, `pair-status`, `hello`, `heartbeat`, `catalog` and `events` exist
  on the network. Desktop operation names are not remotely dispatchable.
- Authorization grants have individual cancellation tokens. Revocation cancels
  pending reads and partial writes for that device, without revoking others.
- `Source` must enforce registered-workspace ownership, opaque session IDs,
  indexing settings and an availability epoch. Epoch changes also abort old
  responses after a quick disable/re-enable cycle.

## Limits and storage

Requests are length-prefixed JSON, at most 16 KiB. Responses are at most 4 MiB;
oversized responses return `limit`. Events accept up to 100 items and 1,024-byte
cursors. Connections have ten-second timeouts and inbound concurrency is 16.
Blocking source reads have a separate 16-task limit. Their permits remain held
until the work returns, even when timeout or revocation has closed the connection;
additional reads fail with `limit` instead of accumulating detached work.
Heartbeats are bounded-parallel with one in flight per host and retry backoff.

The data directory's `remote/identity.json` and `remote/devices.json` are atomic,
owner-only files (Unix permissions or protected Windows OWNER RIGHTS ACLs).
Pairing codes are memory-only. No session content is persisted by this crate.
Shutdown cancels networking and bounds Tokio shutdown to one second, even if a
data-source blocking task has not returned.

## Verification

`cargo test -p agentkib-remote` exercises real loopback mutual-TLS connections,
approval, code limits, revocation, persistence, certificate changes, and
interrupted multi-megabyte responses. Loopback listening is available only to
the private unit-test constructor. Real cross-device mDNS, firewall prompts and
Windows ACL enforcement require platform acceptance testing.
