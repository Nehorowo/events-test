# Earnings live events — snapshot + SSE reconciliation

A full-stack TypeScript demo of one specific problem: a page loads a **snapshot
that is 10 minutes stale** (`GET /events`) and a **live delta stream**
(`/live_events` over SSE, nchan-style), and has to end up with one correct
picture — without holes, without duplicates, and without rolling anything
backwards.

```
                         ┌──────────────────────────────┐
   GET /events ────────► │  snapshot as of now-10min    │ ──┐
   (stale by design)     └──────────────────────────────┘   │
                                                            ▼
                         ┌──────────────────────────────┐  fold
   /live_events (SSE) ─► │  in-memory buffer (15 min)   │ ──┘  →  rendered state
   replay + live         └──────────────────────────────┘
```

The page **subscribes before it fetches**. Deltas produced while the snapshot
request is in flight land in the buffer; the moment the snapshot arrives the
buffer is folded onto it, and from then on every message is applied directly.

---

## Running it

```bash
npm install
npm run dev          # API on :4000, Vite on :5173
open http://localhost:5173
```

The server backfills ~30 minutes of history at boot, so the page is immediately
interesting: the snapshot really is 10 minutes behind, the replay buffer really
is full, and the reconciliation really happens on first paint.

```bash
npm test             # 36 unit tests, no browser needed
npm run typecheck
npm run build
```

Useful knobs (all env vars, see `packages/server/src/config.ts`):

| Variable | Default | What it does |
| --- | --- | --- |
| `SNAPSHOT_LAG_MS` | `600000` | How stale `/events` is |
| `SNAPSHOT_DELAY_MS` | `400` | Simulated latency of the snapshot API (see below) |
| `REPLAY_WINDOW_MS` | `600000` | Channel retention (nchan's message buffer) |
| `SIM_CYCLE_MS` | `240000` | One full earnings lifecycle in the simulator |
| `SIM_HISTORY_MS` | `1800000` | History generated at boot |
| `NCHAN_PUBLISH_URL` | — | Mirror messages into a real nginx+nchan |

`?symbols=AAPL,MSFT` on the page narrows the watchlist.

`SNAPSHOT_DELAY_MS` stands in for the database query and network hop a real
snapshot API costs. Locally the snapshot would otherwise answer in under a
millisecond — beating the SSE replay — and the buffer-onto-snapshot path this
whole app is about would never run. With it, the reconciliation log shows what
actually happens:

```
Snapshot (600s old, 39 events) + 147 buffered messages →
  121 applied, 25 created, 1 already in snapshot, 0 orphan · buffer covers the snapshot
```

---

## The wire contract

### `GET /events?symbols=…` → `EarningsEventsSnapshot`

Not a cached response: the live state *rewound* to `now - SNAPSHOT_LAG_MS`,
reconstructed with the same fold function the browser uses.

### `/live_events` — SSE, one channel, unfiltered

Every message carries:

| Field | Why |
| --- | --- |
| `id` (SSE `id:` + body) | nchan's global monotonic counter: total order and resume cursor |
| `type` (SSE `event:` + body) | duplicated in the body for consumers that only parse `data:` |
| `eventId` | the calendar event; part of the dedupe key |
| `companyId`, `symbol` | client-side filtering — the channel is *not* filtered server-side |
| `tsSent` | ISO-8601 UTC publication time: latency measurement and staleness decisions |

Six message types: `event_scheduled` (full entity), `event_updated` (partial
patch), `live_started`, `live_ended`, `recording_available`, `live_failed`.

The channel is deliberately unfiltered, because that is what nchan is — a
channel it replays verbatim. Filtering is the client's job, which is exactly why
`symbol`/`companyId` are in every payload.

---

## How correctness is achieved

**Dedupe** — `eventId|type|tsSent`, an O(1) `Set` lookup. Not `eventId` alone
(an event gets many deltas), not `id` alone (a broker restart renumbers).

**Staleness** — per entity, `tsSent` vs `updatedAt`. A delta older than the
entity it targets is already reflected in it. This one rule makes folding a
10-minute buffer onto a 10-minute-old snapshot idempotent no matter how much the
two overlap — the fold can be repeated, reordered, or replayed and it converges.

**Coverage** — `assessCoverage()` checks that the buffer reaches back *past*
`snapshotAt`. If the oldest buffered message is newer than the snapshot, the
window between them is unaccounted for; the provider says so and refetches
rather than rendering a state it cannot vouch for.

**Replay gaps** — if the broker cannot resume from the client's cursor (it aged
out of the buffer), it sends a `gap` frame. That propagates to `onReconnect` and
triggers a snapshot refetch.

**No rollback** — on a refetch, a per-event "newest `updatedAt` wins" merge keeps
the held state where it is ahead of the (by construction older) snapshot.

**Replay vs live** — `hello` announces how many messages the channel is about to
replay, and the transport counts them down, so `MessageMeta.replayed` is exact.
End-to-end latency is measured over live messages only: a replayed message is as
old as the replay window and would describe nothing but that window.

The fold lives in `packages/shared/src/apply.ts` and is used by **both** sides,
so the client cannot disagree with the server about what a delta means.

---

## The three client interfaces

```ts
interface ILiveEventsClient {           // one SSE subscription, app-wide singleton
  subscribe(cb: (m: LiveEventsMessage, meta?: MessageMeta) => void): void;
  unsubscribe(cb: (m: LiveEventsMessage, meta?: MessageMeta) => void): void;
  onReconnect(cb: (info: ReconnectInfo) => void): () => void;
  readonly connected: boolean;
}

interface ILiveEventsHttpApi {          // thin: one call, no state
  fetchSnapshot(query?: SnapshotQuery): Promise<EarningsEventsSnapshot>;
}

interface IEarningsEventsProvider {     // owns the buffer and the reconciliation
  readonly snapshot: EarningsEventsSnapshot | null;
  actualizeSnapshot(s: EarningsEventsSnapshot): EarningsEventsSnapshot;
}
```

React only binds them together (`useEarningsFeed` → `useSyncExternalStore`);
none of the logic depends on React, which is why it is all unit-testable.

---

## One connection per browser, not per tab

```
      tab A (leader)                     tab B, C … (followers)
   ┌────────────────────┐             ┌─────────────────────────┐
   │ Web Locks: holds   │             │ Web Locks: queued       │
   │ live_events_leader │             │                         │
   │        │           │             │                         │
   │   SSE ─┴─► buffer ─┼──Broadcast──┼─► buffer ─► provider    │
   └────────────────────┘   Channel   └─────────────────────────┘
```

- **Election** — `navigator.locks.request(..., {mode:'exclusive'})`, held for the
  tab's lifetime. When the leader tab closes or crashes, *the browser* releases
  the lock and the next tab is promoted: no heartbeat, no timeout tuning, no
  stale-leader window.
- **Fan-out** — the leader broadcasts each message on a `BroadcastChannel`.
- **Joining mid-session** — a new tab asks for the leader's buffer
  (`buffer_request` → `buffer_sync`) so it can reconcile its own snapshot fetch
  without opening a second connection.
- **Handover** — the promoted tab resumes from the highest `id` it has seen, so a
  handover costs a replay at worst, never a hole.
- **Degradation** — no Web Locks or no `BroadcastChannel` (old Safari, insecure
  context) means every tab connects on its own. Correct, just less frugal.

Verified in a real browser: two tabs → `/health` reports **one** subscriber;
close the leader → the follower takes over and the count stays at one.

---

## Layout

```
packages/shared/          types + contracts + the fold (used by both sides)
  src/types.ts            wire contract, payload rules, dedupe key
  src/apply.ts            applyLiveEvent / foldLiveEvents / assessCoverage
  src/contracts.ts        ILiveEventsClient, ILiveEventsHttpApi, IEarningsEventsProvider

packages/server/
  src/domain/simulator.ts     deterministic lifecycle generator (backfill + live)
  src/domain/eventsService.ts server truth + the rewound snapshot
  src/broker/channelBroker.ts nchan-compatible buffer, ids, resume, gap
  src/http/app.ts             GET /events, GET /live_events, /health, /debug/state
  deploy/nchan.conf           the same contract as real nginx+nchan

packages/client/
  src/lib/liveEvents/         SseTransport · LeaderElection · CrossTabBus · LiveEventsClient
  src/lib/LiveEventBuffer.ts  15-minute ring, O(1) dedupe
  src/provider/               EarningsEventsProvider — the reconciliation
  src/feed/useEarningsFeed.ts React binding
```

`GET /debug/state` returns the server's live truth for the same symbols — handy
for eyeballing that the client's merged state matches.

---

## Known limits

- The simulator cycles fiscal periods every few minutes, so fiscal years drift
  far into the future. That is the point (visible lifecycle in seconds), not an
  attempt at a realistic calendar.
- Buffer retention is compared against the local clock, so a client whose clock
  is minutes behind the server would evict messages early. A real deployment
  should offset by the skew observable from `serverTime` in the snapshot.
- The broker is in-process: restarting the API resets the channel's `id`
  counter. Clients survive it — an unknown cursor produces a `gap`, which
  triggers a refetch — but a real nchan deployment would keep the ids.
