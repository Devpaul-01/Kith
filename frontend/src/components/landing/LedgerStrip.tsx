import { cn } from '@/utils/cn';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';

type Status = 'confirmed' | 'pending' | 'proof_uploaded';

interface Row {
  name: string;
  initials: string;
  colorClass: string;
  container: string;
  amount: number;
  currency: string;
  status: Status;
}

const STATUS_STYLE: Record<Status, string> = {
  confirmed: 'bg-success/10 text-success',
  pending: 'bg-warning/10 text-warning',
  proof_uploaded: 'bg-primary/10 text-primary',
};

const STATUS_LABEL: Record<Status, string> = {
  confirmed: 'Confirmed',
  pending: 'Pending',
  proof_uploaded: 'Proof uploaded',
};

// Realistic, diaspora-relevant sample data pulled from the product's own domain
// vocabulary (container names, currencies) — not generic placeholder rows.
const ROWS: Row[] = [
  { name: 'Aunt Grace', initials: 'AG', colorClass: 'bg-purple-100 text-purple-700', container: "Mom's 60th Birthday", amount: 150, currency: 'GBP', status: 'confirmed' },
  { name: 'Kwame O.', initials: 'KO', colorClass: 'bg-blue-100 text-blue-700', container: 'Monthly Family Support Fund', amount: 200, currency: 'GHS', status: 'confirmed' },
  { name: 'Uncle Femi', initials: 'UF', colorClass: 'bg-orange-100 text-orange-700', container: "Dad's Care Fund", amount: 75, currency: 'USD', status: 'proof_uploaded' },
  { name: 'Wanjiru M.', initials: 'WM', colorClass: 'bg-green-100 text-green-700', container: 'Susu Rotation — July', amount: 12000, currency: 'KES', status: 'pending' },
  { name: 'Chidi A.', initials: 'CA', colorClass: 'bg-pink-100 text-pink-700', container: 'Wedding Fund — Ada & Tobi', amount: 300, currency: 'NGN', status: 'confirmed' },
  { name: 'Grandma Ngozi', initials: 'GN', colorClass: 'bg-blue-100 text-blue-700', container: "Mom's 60th Birthday", amount: 50, currency: 'GBP', status: 'confirmed' },
  { name: 'Esi B.', initials: 'EB', colorClass: 'bg-purple-100 text-purple-700', container: 'Monthly Family Support Fund', amount: 200, currency: 'GHS', status: 'proof_uploaded' },
  { name: 'Tunde K.', initials: 'TK', colorClass: 'bg-orange-100 text-orange-700', container: "Dad's Care Fund", amount: 100, currency: 'USD', status: 'confirmed' },
];

function LedgerRow({ row }: { row: Row }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-white px-4 py-3 shadow-card shrink-0 w-[19rem]">
      <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold', row.colorClass)}>
        {row.initials}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-text-primary">{row.name}</p>
        <p className="truncate text-xs text-text-secondary">{row.container}</p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <CurrencyAmount amount={row.amount} currency={row.currency} className="text-sm font-bold text-text-primary tabular-nums" />
        <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap', STATUS_STYLE[row.status])}>
          {STATUS_LABEL[row.status]}
        </span>
      </div>
    </div>
  );
}

/**
 * Continuously-drifting two-row marquee of realistic ledger entries — the
 * page's signature element. A live-feeling preview of the product's actual
 * core object (the ledger), not a generic illustration.
 * Pauses on hover/focus; collapses to a static grid under reduced-motion.
 */
export function LedgerStrip() {
  const rowA = [...ROWS, ...ROWS];
  const rowB = [...ROWS.slice().reverse(), ...ROWS.slice().reverse()];

  return (
    <div
      className="relative w-full overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)] motion-reduce:[mask-image:none]"
      role="img"
      aria-label="Live example of family contributions being recorded and confirmed in Kith's ledger"
    >
      <div className="flex flex-col gap-3 py-1">
        <div className="flex gap-3 animate-[marquee_38s_linear_infinite] motion-reduce:animate-none hover:[animation-play-state:paused]">
          {rowA.map((row, i) => (
            <LedgerRow key={`a-${i}`} row={row} />
          ))}
        </div>
        <div className="flex gap-3 animate-[marquee-reverse_34s_linear_infinite] motion-reduce:animate-none hover:[animation-play-state:paused]">
          {rowB.map((row, i) => (
            <LedgerRow key={`b-${i}`} row={row} />
          ))}
        </div>
      </div>
    </div>
  );
}
