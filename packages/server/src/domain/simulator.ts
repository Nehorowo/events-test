/**
 * Deterministic earnings-lifecycle simulator.
 *
 * Everything here is a pure function of `(company, wall clock)`, which buys two
 * things:
 *
 *  1. At boot we *backfill* the last ~30 minutes of deltas, so a freshly
 *     started server already has a full replay buffer and an `/events` snapshot
 *     that is genuinely 10 minutes behind the live channel. Without that, the
 *     reconciliation this whole app is about would never be exercised.
 *  2. The live ticker uses the same generator for the window `(lastTick, now]`,
 *     so backfilled and live messages are indistinguishable.
 *
 * Each cycle is one calendar event with its own `eventId` (a fiscal quarter),
 * going `event_scheduled → event_updated → live_started → live_ended →
 * recording_available`. One symbol fails instead, to exercise `live_failed`.
 */

import type {
  DraftLiveEvent,
  Earning,
  FiscalPeriod,
  LiveAudio,
} from '@earnings/shared';
import { COMPANIES, type Company } from './catalog.js';

export type { DraftLiveEvent };

const PERIODS: readonly FiscalPeriod[] = ['Q1', 'Q2', 'Q3', 'Q4'];
const BASE_FISCAL_YEAR = 2026;

type PhaseKind =
  | 'scheduled'
  | 'time_confirmed'
  | 'starting_soon'
  | 'live_started'
  | 'live_ended'
  | 'recording'
  | 'failed';

interface Phase {
  kind: PhaseKind;
  /** Position inside the cycle, as a fraction of `cycleMs`. */
  at: number;
}

const HAPPY_PATH: readonly Phase[] = [
  { kind: 'scheduled', at: 0.0 },
  { kind: 'time_confirmed', at: 0.18 },
  { kind: 'starting_soon', at: 0.35 },
  { kind: 'live_started', at: 0.5 },
  { kind: 'live_ended', at: 0.8 },
  { kind: 'recording', at: 0.92 },
];

const FAILURE_PATH: readonly Phase[] = [
  { kind: 'scheduled', at: 0.0 },
  { kind: 'time_confirmed', at: 0.18 },
  { kind: 'starting_soon', at: 0.35 },
  { kind: 'failed', at: 0.52 },
];

/** This symbol's call fails every cycle, so `live_failed` is always on screen. */
const FAILING_SYMBOL = 'CRM';

const FAILURE_REASONS = [
  'audio_provider_unavailable',
  'host_cancelled_stream',
  'encoder_timeout',
] as const;

const phasesFor = (company: Company): readonly Phase[] =>
  company.symbol === FAILING_SYMBOL ? FAILURE_PATH : HAPPY_PATH;

export interface SimulatorOptions {
  /** Instant the simulated world starts at; base entities are dated here. */
  genesisMs: number;
  cycleMs: number;
  companies?: readonly Company[];
}

export class EarningsSimulator {
  private readonly companies: readonly Company[];
  private readonly genesisMs: number;
  private readonly cycleMs: number;

  constructor(options: SimulatorOptions) {
    this.companies = options.companies ?? COMPANIES;
    this.genesisMs = options.genesisMs;
    this.cycleMs = options.cycleMs;
  }

  get genesis(): number {
    return this.genesisMs;
  }

  get symbols(): string[] {
    return this.companies.map((c) => c.symbol);
  }

  /** The world at `genesisMs`: one scheduled calendar event per company. */
  baseEvents(): Earning[] {
    return this.companies.map((company, index) =>
      this.scheduledEntity(company, index, 0, this.genesisMs),
    );
  }

  /** Every delta with `from < tsSent <= to`, in chronological order. */
  eventsInWindow(fromMs: number, toMs: number): DraftLiveEvent[] {
    if (toMs <= fromMs) return [];
    const drafts: DraftLiveEvent[] = [];

    this.companies.forEach((company, index) => {
      const phases = phasesFor(company);
      const cycleZeroStart = this.genesisMs + this.offsetOf(index);

      // Step back one cycle so a phase that began before `fromMs` is not missed.
      const firstCycle = Math.max(0, Math.floor((fromMs - cycleZeroStart) / this.cycleMs) - 1);
      const lastCycle = Math.ceil((toMs - cycleZeroStart) / this.cycleMs) + 1;

      for (let k = firstCycle; k <= lastCycle; k += 1) {
        const cycleStart = cycleZeroStart + k * this.cycleMs;

        phases.forEach((phase, phaseIndex) => {
          // Cycle 0 has no `event_scheduled`: the base entity already is that.
          if (k === 0 && phaseIndex === 0) return;

          const at = cycleStart + phase.at * this.cycleMs;
          if (at <= fromMs || at > toMs) return;

          drafts.push(this.buildMessage(company, index, k, phase, at));
        });
      }
    });

    drafts.sort((a, b) => Date.parse(a.tsSent) - Date.parse(b.tsSent));
    return drafts;
  }

  // --- internals ---------------------------------------------------------

  /** Stagger companies across the cycle so deltas arrive continuously. */
  private offsetOf(index: number): number {
    return Math.round((index * this.cycleMs) / this.companies.length);
  }

  private cycleStartOf(index: number, k: number): number {
    return this.genesisMs + this.offsetOf(index) + k * this.cycleMs;
  }

  private fiscalOf(index: number, k: number): { fiscalYear: number; fiscalPeriod: FiscalPeriod } {
    const absolute = (index % PERIODS.length) + k;
    return {
      fiscalYear: BASE_FISCAL_YEAR + Math.floor(absolute / PERIODS.length),
      fiscalPeriod: PERIODS[absolute % PERIODS.length]!,
    };
  }

  /** One calendar event per company per fiscal period — hence per cycle. */
  private eventIdOf(company: Company, index: number, k: number): string {
    const { fiscalYear, fiscalPeriod } = this.fiscalOf(index, k);
    return `evt-${company.symbol.toLowerCase()}-${fiscalYear}${fiscalPeriod.toLowerCase()}`;
  }

  /** Start time as first announced (later moved up by `event_updated`). */
  private announcedDate(cycleStart: number): number {
    return cycleStart + 0.55 * this.cycleMs;
  }

  /** Confirmed start, matching the moment the call actually goes live. */
  private confirmedDate(cycleStart: number): number {
    return cycleStart + 0.5 * this.cycleMs;
  }

  private durationSec(): number {
    return Math.round((0.3 * this.cycleMs) / 1000);
  }

  private audioOf(company: Company, index: number, k: number): LiveAudio {
    const { fiscalYear, fiscalPeriod } = this.fiscalOf(index, k);
    return {
      url: `https://stream.example.com/earnings/${company.symbol.toLowerCase()}/${fiscalYear}${fiscalPeriod}.m3u8`,
      title: `${company.symbol} ${fiscalPeriod} ${fiscalYear} — live audio`,
      startedAt: null,
      durationSec: null,
      isReplay: false,
    };
  }

  private scheduledEntity(company: Company, index: number, k: number, atMs: number): Earning {
    const cycleStart = this.cycleStartOf(index, k);
    const { fiscalYear, fiscalPeriod } = this.fiscalOf(index, k);
    return {
      id: this.eventIdOf(company, index, k),
      companyId: company.companyId,
      symbol: company.symbol,
      title: `${company.name} ${fiscalPeriod} ${fiscalYear} Earnings Call`,
      date: new Date(this.announcedDate(cycleStart)).toISOString(),
      typeId: company.typeId,
      fiscalYear,
      fiscalPeriod,
      state: 'scheduled',
      liveAudio: null,
      failureReason: null,
      updatedAt: new Date(atMs).toISOString(),
    };
  }

  private buildMessage(
    company: Company,
    index: number,
    k: number,
    phase: Phase,
    atMs: number,
  ): DraftLiveEvent {
    const cycleStart = this.cycleStartOf(index, k);
    const tsSent = new Date(atMs).toISOString();
    const base = {
      eventId: this.eventIdOf(company, index, k),
      companyId: company.companyId,
      symbol: company.symbol,
      tsSent,
    };

    switch (phase.kind) {
      case 'scheduled':
        return {
          ...base,
          type: 'event_scheduled',
          event: this.scheduledEntity(company, index, k, atMs),
        };

      case 'time_confirmed':
        return {
          ...base,
          type: 'event_updated',
          changes: { date: new Date(this.confirmedDate(cycleStart)).toISOString() },
          reason: 'time_confirmed',
        };

      case 'starting_soon':
        return {
          ...base,
          type: 'event_updated',
          changes: { state: 'starting_soon', liveAudio: this.audioOf(company, index, k) },
          reason: 'starting_soon',
        };

      case 'live_started':
        return {
          ...base,
          type: 'live_started',
          startedAt: new Date(this.confirmedDate(cycleStart)).toISOString(),
          liveAudio: this.audioOf(company, index, k),
        };

      case 'live_ended':
        return {
          ...base,
          type: 'live_ended',
          endedAt: tsSent,
          durationSec: this.durationSec(),
        };

      case 'recording': {
        const { fiscalYear, fiscalPeriod } = this.fiscalOf(index, k);
        return {
          ...base,
          type: 'recording_available',
          recording: {
            url: `https://replay.example.com/earnings/${company.symbol.toLowerCase()}/${fiscalYear}${fiscalPeriod}.mp3`,
            title: `${company.symbol} ${fiscalPeriod} ${fiscalYear} — replay`,
            durationSec: this.durationSec(),
          },
        };
      }

      case 'failed':
        return {
          ...base,
          type: 'live_failed',
          failedAt: tsSent,
          reason: FAILURE_REASONS[k % FAILURE_REASONS.length]!,
        };
    }
  }
}
