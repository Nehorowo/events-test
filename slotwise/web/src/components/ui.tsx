import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';

const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50',
  accent: 'accent-bg hover:brightness-95 disabled:opacity-50',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:opacity-50',
  ghost: 'text-slate-700 hover:bg-slate-100 disabled:opacity-50',
  danger: 'bg-white text-red-700 border border-red-300 hover:bg-red-50 disabled:opacity-50',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
        size === 'sm' && 'px-3 py-1.5 text-sm',
        size === 'md' && 'px-4 py-2.5 text-sm',
        size === 'lg' && 'px-5 py-3.5 text-base w-full',
        variants[variant],
        className,
      )}
    >
      {loading && <Spinner small />}
      {children}
    </button>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return (
    <span
      role="status"
      aria-label="loading"
      className={cx('inline-block animate-spin rounded-full border-2 border-current border-t-transparent', small ? 'h-4 w-4' : 'h-6 w-6')}
    />
  );
}

export function PageSpinner() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-brand-600">
      <Spinner />
    </div>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
    </div>
  );
}

const inputCls =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm disabled:bg-slate-100';

export function Input({ label, hint, error, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; hint?: ReactNode; error?: ReactNode }) {
  const id = useId();
  const input = <input id={id} {...rest} className={cx(inputCls, className)} aria-invalid={Boolean(error)} />;
  return label ? <Field label={label} hint={hint} error={error} htmlFor={id}>{input}</Field> : input;
}

export function Textarea({ label, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: ReactNode }) {
  const id = useId();
  const el = <textarea id={id} rows={3} {...rest} className={cx(inputCls, className)} />;
  return label ? <Field label={label} htmlFor={id}>{el}</Field> : el;
}

export function Select({ label, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label?: ReactNode }) {
  const id = useId();
  const el = (
    <select id={id} {...rest} className={cx(inputCls, 'pr-8', className)}>
      {children}
    </select>
  );
  return label ? <Field label={label} htmlFor={id}>{el}</Field> : el;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 py-1">
      <span className="text-sm text-slate-700">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx('relative h-6 w-11 shrink-0 rounded-full transition', checked ? 'bg-brand-600' : 'bg-slate-300')}
      >
        <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition', checked ? 'left-5.5' : 'left-0.5')} />
      </button>
    </label>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5', className)}>{children}</div>;
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'green' | 'red' | 'amber' | 'brand' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    green: 'bg-emerald-100 text-emerald-800',
    red: 'bg-red-100 text-red-800',
    amber: 'bg-amber-100 text-amber-900',
    brand: 'bg-brand-100 text-brand-700',
  };
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold', tones[tone])}>{children}</span>;
}

export function Alert({ children, tone = 'amber' }: { children: ReactNode; tone?: 'amber' | 'red' | 'green' | 'brand' }) {
  const tones = {
    amber: 'border-amber-300 bg-amber-50 text-amber-900',
    red: 'border-red-300 bg-red-50 text-red-900',
    green: 'border-emerald-300 bg-emerald-50 text-emerald-900',
    brand: 'border-brand-100 bg-brand-50 text-brand-700',
  };
  return <div role="status" className={cx('rounded-lg border px-4 py-3 text-sm', tones[tone])}>{children}</div>;
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-0 mt-auto w-full max-w-none rounded-t-2xl bg-white p-0 shadow-xl backdrop:bg-slate-900/40 sm:m-auto sm:max-w-lg sm:rounded-2xl"
    >
      {open && (
        <div className="flex max-h-[90dvh] flex-col">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h2 className="text-lg font-semibold">{title}</h2>
            <button type="button" onClick={onClose} className="rounded-lg p-1 text-slate-500 hover:bg-slate-100" aria-label="close">
              <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor"><path d="M6.3 5 5 6.3 8.7 10 5 13.7 6.3 15 10 11.3l3.7 3.7 1.3-1.3L11.3 10 15 6.3 13.7 5 10 8.7z" /></svg>
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3 pb-safe">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/** Translates an API error into a friendly message. */
export function useErrorMessage() {
  const { t, i18n } = useTranslation();
  return (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.status === 429) return t('errors.rate_limited');
      const key = `errors.${err.code}`;
      if (i18n.exists(key)) return t(key);
      if (err.code === 'invalid_input') return err.message;
    }
    return t('errors.generic');
  };
}

export function ErrorText({ error }: { error: unknown }) {
  const msg = useErrorMessage();
  if (!error) return null;
  return <p className="text-sm text-red-600" role="alert">{msg(error)}</p>;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={async (e) => {
        const btn = e.currentTarget;
        try {
          await navigator.clipboard.writeText(text);
          const prev = btn.textContent;
          btn.textContent = t('common.copied');
          setTimeout(() => (btn.textContent = prev), 1500);
        } catch {
          window.prompt('', text);
        }
      }}
    >
      {label ?? t('common.copy')}
    </Button>
  );
}

export function Avatar({ name, src, size = 40 }: { name: string; src?: string | null; size?: number }) {
  if (src) return <img src={src} alt="" width={size} height={size} className="rounded-full object-cover" style={{ width: size, height: size }} />;
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return (
    <span className="accent-bg inline-flex items-center justify-center rounded-full font-semibold" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {initials || '•'}
    </span>
  );
}
