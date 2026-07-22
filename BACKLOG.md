# Backlog

## Event stream snapshot sizing

The client WebSocket proxy currently applies the 256 KiB `MAX_PENDING_BYTES`
limit to upstream frames received before the browser-facing socket opens. The
bridge sends the complete fleet snapshot as one frame, and agent status strings
are not bounded, so a valid snapshot can exceed this limit and cause a permanent
reconnect loop.

- Define event-stream frame and buffer limits separately from terminal limits.
- Bound agent status field sizes at the protocol/API boundary.
- Chunk or paginate snapshots if the supported fleet size can exceed one frame.
- Add coverage for snapshots near and above the supported limit.

## Bridge event backpressure

The bridge broadcasts events without checking `ServerWebSocket.send()` results
or configuring backpressure behavior. A slow browser can miss an update while
remaining connected, leaving its workspace state stale because a fresh snapshot
is only sent after reconnecting.

- Handle dropped and backpressured sends explicitly.
- Close affected clients so reconnect synchronization repairs their state, or
  implement bounded per-client queues with `drain` handling.
- Configure explicit WebSocket backpressure limits.
- Add slow-client and backpressure regression coverage.
