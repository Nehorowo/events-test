/**
 * Leader election across tabs, via the Web Locks API.
 *
 * Exactly one tab holds an exclusive lock named `live_events_leader` for as
 * long as it lives; the others queue behind it. When the leader tab is closed,
 * crashes, or is discarded by the browser, the lock is released *by the
 * browser* — no heartbeat, no timeout tuning, no stale-leader window — and the
 * next queued tab is promoted.
 *
 * If Web Locks is unavailable (non-secure context, old Safari), every tab
 * elects itself. That degrades to one SSE connection per tab, which is exactly
 * the behaviour we had before — correct, just less frugal.
 */

export interface LeaderElectionOptions {
  lockName?: string;
  onPromoted: () => void;
  /** Called when the lock could not be used at all — one connection per tab. */
  onUnsupported?: () => void;
  /** Test seam: defaults to `navigator.locks`. */
  lockManager?: LockManagerLike | null;
}

export interface LockManagerLike {
  request(
    name: string,
    options: { mode: 'exclusive' | 'shared'; signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void>;
}

const getLockManager = (): LockManagerLike | null => {
  const locks = (globalThis.navigator as Navigator & { locks?: LockManagerLike } | undefined)?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
};

export class LeaderElection {
  private readonly lockName: string;
  private readonly onPromoted: () => void;
  private readonly onUnsupported: (() => void) | undefined;
  private readonly lockManager: LockManagerLike | null;

  private leader = false;
  private releaseLock: (() => void) | null = null;
  private abort: AbortController | null = null;

  constructor(options: LeaderElectionOptions) {
    this.lockName = options.lockName ?? 'live_events_leader';
    this.onPromoted = options.onPromoted;
    this.onUnsupported = options.onUnsupported;
    this.lockManager = options.lockManager !== undefined ? options.lockManager : getLockManager();
  }

  get isLeader(): boolean {
    return this.leader;
  }

  get supported(): boolean {
    return this.lockManager !== null;
  }

  start(): void {
    const locks = this.lockManager;
    if (!locks) {
      this.leader = true;
      this.onUnsupported?.();
      this.onPromoted();
      return;
    }

    this.abort = new AbortController();
    void locks
      .request(this.lockName, { mode: 'exclusive', signal: this.abort.signal }, () => {
        this.leader = true;
        this.onPromoted();
        // Holding the lock *is* being the leader: keep the callback pending
        // until this tab stands down or goes away.
        return new Promise<void>((resolve) => {
          this.releaseLock = resolve;
        });
      })
      .catch((error: unknown) => {
        // `AbortError` is our own `stop()`; anything else means no leadership.
        if ((error as { name?: string })?.name !== 'AbortError') {
          this.leader = true;
          this.onUnsupported?.();
          this.onPromoted();
        }
      });
  }

  stop(): void {
    this.leader = false;
    this.abort?.abort();
    this.abort = null;
    this.releaseLock?.();
    this.releaseLock = null;
  }
}
