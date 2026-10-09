import type { Plan, PlanLimits } from '../../../shared/plans';

export type Role = 'owner' | 'admin' | 'staff';

export interface Me {
  user: { id: string; email: string; name: string | null; locale: string } | null;
  memberships: {
    tenantId: string;
    slug: string;
    name: string;
    timezone: string;
    onboardingDone: boolean;
    role: Role;
    staffId: string | null;
    plan: Plan;
  }[];
  config: { googleEnabled: boolean; billingMode: 'stripe' | 'dev'; vapidPublicKey: string };
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  address: string | null;
  phone: string | null;
  logoData: string | null;
  brandColor: string | null;
  locale: 'en' | 'el';
  slotStepMin: number;
  minNoticeMin: number;
  maxDaysAhead: number;
  published: boolean;
  onboardingDone: boolean;
}

export interface TenantInfo {
  tenant: Tenant;
  membership: { tenantId: string; role: Role; staffId: string | null };
  bookingUrl: string;
  plan: {
    plan: Plan;
    rawPlan: 'free' | 'pro' | 'founding';
    limits: PlanLimits;
    status: string;
    interval: 'month' | 'year' | null;
    currentPeriodEnd: string | null;
    foundingUntil: string | null;
    hasBillingAccount: boolean;
  };
  usage: { bookingsThisMonth: number; bookingLimit: number | null; activeStaff: number; staffLimit: number };
}

export interface Service {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  priceCents: number;
  currency: string;
  bufferMin: number;
  active: boolean;
  sort: number;
}

export interface HoursRow {
  weekday: number;
  start: string;
  end: string;
}

export interface Staff {
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  sort: number;
  hours: HoursRow[];
  member: { userId: string; role: Role; email: string } | null;
  pendingInvite: { email: string; role: Role; expiresAt: string } | null;
}

export type AppointmentStatus = 'confirmed' | 'cancelled' | 'completed' | 'no_show';

export interface Appointment {
  id: string;
  staffId: string;
  serviceId: string | null;
  clientId: string;
  serviceName: string;
  priceCents: number;
  currency: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  source: 'online' | 'manual';
  notes: string | null;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  staffName: string;
  localStart: string; // YYYY-MM-DDTHH:MM in the business timezone
  localEnd: string;
}

export interface TimeOff {
  id: string;
  staffId: string;
  staffName: string;
  kind: 'day_off' | 'block';
  reason: string | null;
  localStart: string;
  localEnd: string;
}

export interface Client {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  visits: number;
  noShows: number;
  lastVisit: string | null;
  nextVisit: string | null;
  createdAt: string;
}

export interface PublicService {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  priceCents: number;
  currency: string;
}

export interface PublicPage {
  tenant: {
    slug: string;
    name: string;
    timezone: string;
    address: string | null;
    phone: string | null;
    logoData: string | null;
    brandColor: string | null;
    locale: 'en' | 'el';
    maxDaysAhead: number;
  };
  published: boolean;
  acceptingBookings: boolean;
  badge: boolean;
  services: PublicService[];
  staff: { id: string; name: string }[];
}

export interface Slot {
  time: string;
  startsAt: string;
  staffCount: number;
}
