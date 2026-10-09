// Plain, transactional email layout: inline styles, one column, one button.
// Deliberately simple so it renders everywhere and stays out of spam folders.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export interface LayoutOptions {
  heading: string;
  intro: string;
  rows?: [string, string][];
  button?: { label: string; url: string };
  footer?: string;
  accent?: string;
}

export function emailLayout(o: LayoutOptions): { html: string; text: string } {
  const accent = o.accent ?? '#4f46e5';
  const rows = (o.rows ?? [])
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top">${escapeHtml(k)}</td>` +
        `<td style="padding:6px 0;color:#111827;font-weight:600">${escapeHtml(v)}</td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;padding:28px" cellpadding="0" cellspacing="0">
<tr><td>
<h1 style="margin:0 0 12px;font-size:20px;color:#111827">${escapeHtml(o.heading)}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#374151">${escapeHtml(o.intro)}</p>
${rows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px;margin:0 0 20px">${rows}</table>` : ''}
${
  o.button
    ? `<a href="${escapeHtml(o.button.url)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;font-size:15px">${escapeHtml(o.button.label)}</a>`
    : ''
}
${o.footer ? `<p style="margin:24px 0 0;font-size:12px;color:#9ca3af">${escapeHtml(o.footer)}</p>` : ''}
</td></tr></table></td></tr></table></body></html>`;
  const text = [
    o.heading,
    '',
    o.intro,
    '',
    ...(o.rows ?? []).map(([k, v]) => `${k}: ${v}`),
    '',
    o.button ? `${o.button.label}: ${o.button.url}` : '',
    o.footer ? `\n${o.footer}` : '',
  ].join('\n');
  return { html, text };
}
