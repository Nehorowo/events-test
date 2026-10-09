// Server-side strings (emails, push). The web app has its own locale files.

export type Locale = 'en' | 'el';
export const LOCALES: Locale[] = ['en', 'el'];

export function asLocale(v: unknown): Locale {
  return v === 'el' ? 'el' : 'en';
}

const strings = {
  en: {
    loginSubject: 'Your Slotwise sign-in link',
    loginIntro: 'Click the button below to sign in. The link works once and expires in 20 minutes.',
    loginButton: 'Sign in to Slotwise',
    loginIgnore: "If you didn't ask for this, you can ignore this email.",
    inviteSubject: (biz: string) => `You're invited to join ${biz} on Slotwise`,
    inviteIntro: (biz: string) => `${biz} invited you to manage your appointments on Slotwise.`,
    inviteButton: 'Accept invitation',
    bookedSubject: (biz: string) => `Booking confirmed — ${biz}`,
    bookedIntro: (name: string) => `Hi ${name}, your appointment is confirmed.`,
    rescheduledSubject: (biz: string) => `Booking moved — ${biz}`,
    rescheduledIntro: (name: string) => `Hi ${name}, your appointment has a new time.`,
    cancelledSubject: (biz: string) => `Booking cancelled — ${biz}`,
    cancelledIntro: (name: string) => `Hi ${name}, your appointment has been cancelled.`,
    reminderSubject: (biz: string) => `Reminder: your appointment tomorrow — ${biz}`,
    reminderIntro: (name: string) => `Hi ${name}, this is a reminder of your appointment.`,
    manageButton: 'Cancel or reschedule',
    bookAgain: 'Book again',
    service: 'Service',
    with: 'With',
    when: 'When',
    where: 'Where',
    previously: 'Previously',
    ownerNewSubject: (client: string, when: string) => `New booking: ${client}, ${when}`,
    ownerCancelledSubject: (client: string, when: string) => `Cancelled: ${client}, ${when}`,
    ownerRescheduledSubject: (client: string, when: string) => `Moved: ${client}, now ${when}`,
    client: 'Client',
    openCalendar: 'Open calendar',
    pushNew: 'New booking',
    pushCancelled: 'Booking cancelled',
    pushRescheduled: 'Booking moved',
    footer: 'Sent by Slotwise on behalf of',
  },
  el: {
    loginSubject: 'Ο σύνδεσμος σύνδεσης στο Slotwise',
    loginIntro: 'Πατήστε το κουμπί για να συνδεθείτε. Ο σύνδεσμος ισχύει μία φορά και λήγει σε 20 λεπτά.',
    loginButton: 'Σύνδεση στο Slotwise',
    loginIgnore: 'Αν δεν το ζητήσατε, αγνοήστε αυτό το email.',
    inviteSubject: (biz: string) => `Πρόσκληση από ${biz} στο Slotwise`,
    inviteIntro: (biz: string) => `Η επιχείρηση ${biz} σας προσκάλεσε να διαχειρίζεστε τα ραντεβού σας στο Slotwise.`,
    inviteButton: 'Αποδοχή πρόσκλησης',
    bookedSubject: (biz: string) => `Επιβεβαίωση ραντεβού — ${biz}`,
    bookedIntro: (name: string) => `Γεια σας ${name}, το ραντεβού σας επιβεβαιώθηκε.`,
    rescheduledSubject: (biz: string) => `Αλλαγή ώρας ραντεβού — ${biz}`,
    rescheduledIntro: (name: string) => `Γεια σας ${name}, το ραντεβού σας έχει νέα ώρα.`,
    cancelledSubject: (biz: string) => `Ακύρωση ραντεβού — ${biz}`,
    cancelledIntro: (name: string) => `Γεια σας ${name}, το ραντεβού σας ακυρώθηκε.`,
    reminderSubject: (biz: string) => `Υπενθύμιση: το ραντεβού σας αύριο — ${biz}`,
    reminderIntro: (name: string) => `Γεια σας ${name}, σας υπενθυμίζουμε το ραντεβού σας.`,
    manageButton: 'Ακύρωση ή αλλαγή',
    bookAgain: 'Νέο ραντεβού',
    service: 'Υπηρεσία',
    with: 'Με',
    when: 'Πότε',
    where: 'Πού',
    previously: 'Προηγουμένως',
    ownerNewSubject: (client: string, when: string) => `Νέο ραντεβού: ${client}, ${when}`,
    ownerCancelledSubject: (client: string, when: string) => `Ακύρωση: ${client}, ${when}`,
    ownerRescheduledSubject: (client: string, when: string) => `Αλλαγή: ${client}, τώρα ${when}`,
    client: 'Πελάτης',
    openCalendar: 'Άνοιγμα ημερολογίου',
    pushNew: 'Νέο ραντεβού',
    pushCancelled: 'Ακύρωση ραντεβού',
    pushRescheduled: 'Αλλαγή ραντεβού',
    footer: 'Στάλθηκε από το Slotwise εκ μέρους της επιχείρησης',
  },
} as const;

export function t(locale: Locale) {
  return strings[locale];
}

export function formatWhen(d: Date, timeZone: string, locale: Locale, style: 'full' | 'short' = 'full'): string {
  return new Intl.DateTimeFormat(locale === 'el' ? 'el-GR' : 'en-GB', {
    timeZone,
    weekday: style === 'full' ? 'long' : 'short',
    day: 'numeric',
    month: style === 'full' ? 'long' : 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}
