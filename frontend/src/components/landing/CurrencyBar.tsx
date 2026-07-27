import { CURRENCY_SYMBOLS, CURRENCY_LABELS } from '@/constants/currencies';

const FEATURED = ['USD', 'GBP', 'NGN', 'GHS', 'KES', 'ZAR', 'INR', 'CAD', 'EUR', 'AED'] as const;

export function CurrencyBar() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2.5">
      {FEATURED.map((code) => (
        <div
          key={code}
          title={CURRENCY_LABELS[code]}
          className="flex items-center gap-1.5 rounded-full border border-border bg-white px-3.5 py-1.5 text-sm shadow-card"
        >
          <span className="font-bold text-primary">{CURRENCY_SYMBOLS[code]}</span>
          <span className="font-semibold text-text-primary tracking-wide">{code}</span>
        </div>
      ))}
      <div className="flex items-center rounded-full border border-dashed border-border px-3.5 py-1.5 text-sm font-medium text-text-secondary">
        + every other currency, worldwide
      </div>
    </div>
  );
}
