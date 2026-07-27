import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/utils/cn';

interface FaqItem {
  question: string;
  answer: string;
}

const FAQS: FaqItem[] = [
  {
    question: 'Is Kith a bank, or does it move money itself?',
    answer:
      'No. Kith never touches or moves money — it’s a system of record. Family members still pay each other however they already do (bank transfer, mobile money, cash), and record it in Kith with proof of payment so everyone can see it was done.',
  },
  {
    question: 'What happens to someone who won’t use an app — a grandparent, or a baby being saved for?',
    answer:
      'You add them as a proxy member. They can have targets, appear in the ledger, and be included in every pool — but only an admin records on their behalf, and every one of those actions is separately logged so it’s always clear who acted for whom.',
  },
  {
    question: 'What if someone disagrees a payment happened, or the amount is wrong?',
    answer:
      'They raise a dispute directly on the entry. It’s flagged for every admin immediately, notes get added as the conversation develops, and an admin resolves it with a required explanation. Nothing is deleted — if a number needs to change, it’s posted as a correction, so the full history stays visible.',
  },
  {
    question: 'Can our extended family see our finances, or is this public?',
    answer:
      'Private by default. Money details are only visible to members you’ve added to your workspace, and even then, contributors mostly see their own standing — not everyone else’s. If you want to share a public fundraiser page, you can generate one for a specific event, and choose whether contributor names show at all.',
  },
  {
    question: 'What currencies does Kith support?',
    answer:
      "All of them. USD, GBP, EUR, NGN, GHS, KES, ZAR, INR, and CAD are just a few examples — every family workspace can coordinate using whichever currency makes sense for them, so distance and different currencies never get in the way.",
  },
  {
    question: 'What happens if nobody opens the app for a month?',
    answer:
      'Recurring pools keep running on their own. Cycles open and close on schedule, reminders go out before and after a due date, and unpaid balances can automatically carry forward — no one has to remember to operate it.',
  },
];

function FaqRow({ item, isOpen, onToggle }: { item: FaqItem; isOpen: boolean; onToggle: () => void }) {
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between gap-4 py-5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-lg"
      >
        <span className="text-[15px] font-semibold text-text-primary">{item.question}</span>
        <ChevronDown
          size={18}
          className={cn('shrink-0 text-text-secondary transition-transform duration-300', isOpen && 'rotate-180 text-primary')}
        />
      </button>
      <div
        className={cn('grid transition-all duration-300 ease-out', isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}
        style={{ display: 'grid' }}
      >
        <div className="overflow-hidden">
          <p className="pb-5 text-sm leading-relaxed text-text-secondary max-w-2xl">{item.answer}</p>
        </div>
      </div>
    </div>
  );
}

export function FaqAccordion() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  return (
    <div className="rounded-2xl border border-border bg-white shadow-card px-5 sm:px-8">
      {FAQS.map((item, i) => (
        <FaqRow key={item.question} item={item} isOpen={openIndex === i} onToggle={() => setOpenIndex(openIndex === i ? null : i)} />
      ))}
    </div>
  );
}
