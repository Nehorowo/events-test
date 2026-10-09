import { Link } from 'react-router';

// Plain-language privacy notice. Replace the bracketed parts with your
// company details before launch and have it reviewed.
export default function Privacy() {
  return (
    <main className="prose mx-auto max-w-2xl px-4 py-10 text-slate-700">
      <Link to="/" className="text-sm text-brand-600">‹ Slotwise</Link>
      <h1 className="mt-4 text-2xl font-bold text-slate-900">Privacy notice</h1>
      <div className="mt-4 space-y-4 text-sm leading-6">
        <p>
          Slotwise is operated by [Company name, address, Cyprus]. Businesses use Slotwise to take appointments; for their
          clients&apos; data, the business is the controller and Slotwise is its processor under a data processing agreement.
        </p>
        <h2 className="text-lg font-semibold text-slate-900">What we collect</h2>
        <ul className="list-disc pl-5">
          <li>Clients booking an appointment: name, phone, email, optional note, and the appointment itself.</li>
          <li>Business users: email, name, and the business profile they enter.</li>
          <li>Technical data needed to run the service (server logs kept for 14 days).</li>
        </ul>
        <h2 className="text-lg font-semibold text-slate-900">Why</h2>
        <p>To make and manage the booking, send the confirmation and reminder, and let the business contact you about it. We do not sell data, show ads, or list businesses in a marketplace.</p>
        <h2 className="text-lg font-semibold text-slate-900">Where</h2>
        <p>All data is stored in the European Union. Email is delivered through our email provider; payments for business subscriptions are handled by Stripe.</p>
        <h2 className="text-lg font-semibold text-slate-900">Your rights</h2>
        <p>
          Clients can cancel bookings from their email link and can ask the business, or us at [privacy@yourdomain], for access,
          correction or deletion. Businesses can export all their data as CSV and delete their account at any time from Settings.
        </p>
        <h2 className="text-lg font-semibold text-slate-900">Retention</h2>
        <p>Appointment data is kept while the business uses Slotwise and deleted when the business deletes it or closes its account; backups roll over within 30 days.</p>
      </div>
    </main>
  );
}
