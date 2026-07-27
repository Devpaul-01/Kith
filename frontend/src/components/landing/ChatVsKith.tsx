import { Check, Image as ImageIcon } from 'lucide-react';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { FamilyAvatar } from './FamilyAvatar';
import { DEMO_CONTAINERS } from '@/constants/demoFamily';

// A styled illustrative chat mock (not a screenshot of any real messaging
// app) paired with the equivalent Kith event view — the contrast is meant
// to be readable in under two seconds, per the blueprint's "Problem"
// section brief.
const CHAT_MESSAGES = [
  { from: 'Esther', text: 'Did you send that already?' },
  { from: 'Daniel', text: 'send what 😅' },
  { from: 'Esther', text: "Grandma's birthday money" },
  { from: 'Grace', text: 'I thought Uncle Femi was tracking it' },
  { from: 'Daniel', text: '[image.jpg]' },
  { from: 'Sarah', text: "That's not what I agreed to send" },
  { from: 'Esther', text: 'can someone just confirm who has paid 🙏' },
];

const birthday = DEMO_CONTAINERS.find((c) => c.id === 'c_birthday')!;

function ChatMock() {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-white shadow-card overflow-hidden">
      <div className="border-b border-border bg-surface-page px-4 py-3">
        <p className="text-sm font-semibold text-text-primary">Family 💛 (24)</p>
        <p className="text-xs text-text-secondary">Esther, Daniel, Grace, Sarah +20</p>
      </div>
      <div className="flex-1 space-y-2.5 overflow-hidden px-4 py-4">
        {CHAT_MESSAGES.map((m, i) => (
          <div key={i} className="flex items-start gap-2">
            <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-600">
              {m.from[0]}
            </div>
            <div className="rounded-xl rounded-tl-sm bg-slate-100 px-3 py-1.5 text-xs text-text-primary max-w-[80%]">
              {m.text === '[image.jpg]' ? (
                <span className="flex items-center gap-1.5 text-text-secondary italic">
                  <ImageIcon size={12} /> image.jpg
                </span>
              ) : (
                m.text
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-border px-4 py-2.5">
        <div className="h-8 rounded-full bg-slate-100" />
      </div>
    </div>
  );
}

function KithMock() {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-primary/20 bg-white shadow-card overflow-hidden">
      <div className="border-b border-border bg-primary/[0.04] px-4 py-3">
        <p className="text-sm font-bold text-text-primary">{birthday.name}</p>
        <p className="text-xs text-text-secondary">7 participants · due Sep 12</p>
      </div>
      <div className="flex-1 space-y-4 px-4 py-4">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-medium text-text-secondary">Raised</span>
            <span className="text-sm font-bold text-text-primary">£1,632 of £2,400</span>
          </div>
          <ProgressBar value={birthday.total_confirmed!} max={birthday.total_expected!} className="mt-1.5" />
        </div>
        <div className="flex -space-x-2">
          {['David Adeyemi', 'Sarah Adeyemi', 'Grace Adeyemi', 'Daniel Adeyemi'].map((n) => (
            <FamilyAvatar key={n} name={n} size="sm" className="ring-2 ring-white" />
          ))}
        </div>
        <div className="space-y-1.5 rounded-xl bg-surface-page p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-text-primary font-medium"><Check size={12} className="text-success" /> Daniel confirmed £240</span>
            <span className="text-text-secondary">2d ago</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-text-primary font-medium"><Check size={12} className="text-success" /> Sarah confirmed £300</span>
            <span className="text-text-secondary">6d ago</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChatVsKith() {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <div className="h-[280px]">
          <ChatMock />
        </div>
        <p className="text-center text-xs font-medium text-text-secondary">A group chat, three days later</p>
      </div>
      <div className="flex flex-col gap-2">
        <div className="h-[280px]">
          <KithMock />
        </div>
        <p className="text-center text-xs font-medium text-primary">The same event, inside Kith</p>
      </div>
    </div>
  );
}
