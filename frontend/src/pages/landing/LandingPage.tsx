import { Link } from 'react-router-dom';
import { useState } from 'react';
import {
  ArrowRight,
  Menu,
  X,
  ShieldCheck,
  Users2,
  Repeat,
  Gavel,
  Bell,
  Link2,
  FileCheck2,
  Lock,
  History,
  ScanLine,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Reveal } from '@/components/landing/Reveal';
import { LedgerStrip } from '@/components/landing/LedgerStrip';
import { NestingDiagram } from '@/components/landing/NestingDiagram';
import { CurrencyBar } from '@/components/landing/CurrencyBar';
import { FaqAccordion } from '@/components/landing/FaqAccordion';

const NAV_LINKS = [
  { label: 'How it works', href: '#how-it-works' },
  { label: 'Features', href: '#features' },
  { label: 'Security', href: '#security' },
  { label: 'FAQ', href: '#faq' },
];

const PROBLEMS = [
  {
    quote: '"Did you send that already?"',
    detail:
      'Three cousins, one WhatsApp thread, and nobody quite sure who\u2019s paid toward Dad\u2019s care fund this month.',
  },
  {
    quote: '"I thought Uncle Femi was tracking it."',
    detail:
      'A spreadsheet somebody made two years ago, shared once, never opened since — nobody\u2019s sure it\u2019s even current.',
  },
  {
    quote: '"That\u2019s not what I agreed to send."',
    detail:
      'A real disagreement about money, between people who love each other, with no process to resolve it — just a thread that goes quiet.',
  },
];

const FEATURES = [
  {
    icon: Users2,
    title: 'Proxy members',
    description:
      'Grandma will never install an app, and the baby you\u2019re saving for definitely won\u2019t. Add them anyway — an admin records on their behalf, fully audited.',
  },
  {
    icon: Repeat,
    title: 'Recurring pools that run themselves',
    description:
      'A monthly susu or care fund opens its own cycle, reminds late payers, and closes on schedule — automatically, with no one\u2019s memory required.',
  },
  {
    icon: Gavel,
    title: 'Disputes with an actual process',
    description:
      '"I already paid that" becomes a structured, admin-resolved workflow with a permanent record — not a WhatsApp argument that fizzles out unresolved.',
  },
  {
    icon: History,
    title: 'Nothing confirmed ever quietly changes',
    description:
      'Once a contribution is confirmed, it\u2019s history. Fixing a number means posting a correction everyone can see — never a silent edit.',
  },
  {
    icon: Bell,
    title: 'Reminders that actually reach people',
    description:
      'Push, email, and in-app — before something\u2019s due and after it\u2019s overdue — so "outstanding balance" is something you see, not something you chase.',
  },
  {
    icon: Link2,
    title: 'A public page for the fundraiser',
    description:
      'Share one link with extended family who aren\u2019t even in the workspace yet. You choose whether contributor names are shown at all.',
  },
];

const SECURITY_POINTS = [
  {
    icon: ScanLine,
    title: 'Proof isn\u2019t just trusted',
    description:
      'Every uploaded payment proof is checked byte-for-byte against its real file signature — not just the label a browser happened to send.',
  },
  {
    icon: FileCheck2,
    title: 'Retries can\u2019t double-charge the record',
    description:
      'Every contribution carries a unique key, so a flaky connection and an anxious double-tap can never create two entries for one payment.',
  },
  {
    icon: Lock,
    title: 'Built to fail safe, not silent',
    description:
      'You can\u2019t delete a container or remove a member while real confirmed money is attached to them — by design, not by convention.',
  },
];

function NavBar({ mobileOpen, setMobileOpen }: { mobileOpen: boolean; setMobileOpen: (v: boolean) => void }) {
  return (
    <header className="sticky top-0 z-50 border-b border-border/80 bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-1 text-xl font-extrabold tracking-tight text-text-primary">
          ki<span className="text-primary">th</span>
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Link to="/login" className="text-sm font-semibold text-text-secondary hover:text-text-primary transition-colors px-3 py-2">
            Log in
          </Link>
          <Link to="/signup">
            <Button size="sm">
              Get started free
            </Button>
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setMobileOpen(!mobileOpen)}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-text-primary md:hidden"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>

      {mobileOpen && (
        <div className="border-t border-border bg-white px-4 py-4 md:hidden">
          <nav className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-text-secondary hover:bg-surface-page hover:text-text-primary"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
            <Link to="/login" className="rounded-xl px-3 py-2.5 text-center text-sm font-semibold text-text-primary hover:bg-surface-page">
              Log in
            </Link>
            <Link to="/signup">
              <Button fullWidth size="sm">Get started free</Button>
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

export default function LandingPage() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-surface-page">
      <NavBar mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />

      {/* ============ HERO ============ */}
      <section className="relative overflow-hidden px-4 pt-16 pb-20 sm:px-6 sm:pt-24 sm:pb-28">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[640px] opacity-60"
          style={{
            background:
              'radial-gradient(60% 50% at 50% 0%, rgba(37,99,235,0.10) 0%, rgba(37,99,235,0) 70%)',
          }}
          aria-hidden
        />
        <div className="mx-auto max-w-3xl text-center">
          <Reveal>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/5 px-3.5 py-1.5 text-xs font-semibold text-primary">
              Family coordination, done right
            </span>
          </Reveal>
          <Reveal delay={80}>
            <h1 className="mt-6 text-[2.5rem] font-extrabold leading-[1.08] tracking-tight text-text-primary sm:text-6xl sm:leading-[1.05]">
              Money and responsibility,
              <br />
              shared without the group chat.
            </h1>
          </Reveal>
          <Reveal delay={160}>
            <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-text-secondary">
              Kith turns "did you send that already?" into a structured, auditable system —
              built for the funerals, weddings, and monthly family pools that a spreadsheet
              and a WhatsApp thread were never quite enough for.
            </p>
          </Reveal>
          <Reveal delay={240}>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to="/signup" className="w-full sm:w-auto">
                <Button size="lg" fullWidth className="sm:w-auto group">
                  Get started free
                  <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
                </Button>
              </Link>
              <a href="#how-it-works" className="w-full sm:w-auto">
                <Button variant="secondary" size="lg" fullWidth className="sm:w-auto">
                  See how it works
                </Button>
              </a>
            </div>
          </Reveal>
          <Reveal delay={300}>
            <p className="mt-4 text-xs text-text-secondary">No card required. Set up your family in under two minutes.</p>
          </Reveal>
        </div>

        <Reveal delay={360} className="mt-16">
          <LedgerStrip />
        </Reveal>
      </section>

      {/* ============ CURRENCY TRUST BAR ============ */}
      <section className="border-y border-border bg-white px-4 py-10 sm:px-6">
        <Reveal className="mx-auto max-w-4xl text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-text-secondary">
            Built for families spread across more than one country
          </p>
          <div className="mt-5">
            <CurrencyBar />
          </div>
        </Reveal>
      </section>

      {/* ============ PROBLEM ============ */}
      <section className="px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <Reveal className="mx-auto max-w-xl text-center">
            <h2 className="text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
              Every extended family runs into this eventually.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-text-secondary">
              Not because anyone did anything wrong — because money shared between people
              who aren\u2019t a company was never given the tools a company gets by default.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-5 sm:grid-cols-3">
            {PROBLEMS.map((problem, i) => (
              <Reveal key={problem.quote} delay={i * 90}>
                <div className="h-full rounded-2xl border border-border bg-white p-6 shadow-card">
                  <p className="text-lg font-bold leading-snug text-text-primary">{problem.quote}</p>
                  <p className="mt-3 text-sm leading-relaxed text-text-secondary">{problem.detail}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ============ HOW IT WORKS (nesting diagram) ============ */}
      <section id="how-it-works" className="bg-white px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-16">
            <Reveal>
              <span className="text-xs font-bold uppercase tracking-widest text-primary">How it works</span>
              <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
                Three ideas, nested inside each other.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-text-secondary">
                A <strong className="text-text-primary">Workspace</strong> is your family. Inside it,
                a <strong className="text-text-primary">Container</strong> is whatever you\u2019re
                coordinating — a one-off event or an ongoing pool. Inside that, the{' '}
                <strong className="text-text-primary">Ledger</strong> is the honest record of every
                contribution, correction, and dispute. Nothing floats outside this structure, so
                nothing gets lost in a thread.
              </p>
              <Link to="/signup" className="mt-7 inline-flex">
                <Button className="group">
                  Set up your family
                  <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
                </Button>
              </Link>
            </Reveal>
            <Reveal delay={120}>
              <NestingDiagram />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ============ FEATURES ============ */}
      <section id="features" className="px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-6xl">
          <Reveal className="mx-auto max-w-xl text-center">
            <span className="text-xs font-bold uppercase tracking-widest text-primary">Features</span>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
              Everything a family actually needs — nothing a business doesn\u2019t.
            </h2>
          </Reveal>

          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature, i) => {
              const Icon = feature.icon;
              return (
                <Reveal key={feature.title} delay={(i % 3) * 90}>
                  <div className="h-full rounded-2xl border border-border bg-white p-6 shadow-card transition-shadow hover:shadow-card-hover">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon size={20} strokeWidth={2.25} />
                    </div>
                    <h3 className="mt-4 text-base font-bold text-text-primary">{feature.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">{feature.description}</p>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* ============ SECURITY ============ */}
      <section id="security" className="bg-text-primary px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <Reveal className="mx-auto max-w-xl text-center">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-blue-300">
              <ShieldCheck size={14} /> Security & trust
            </span>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              Real money between real relatives deserves real safeguards.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-slate-300">
              Not marketing language — specific mechanisms, because this is the part of the
              product that has to be trustworthy.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-5 sm:grid-cols-3">
            {SECURITY_POINTS.map((point, i) => {
              const Icon = point.icon;
              return (
                <Reveal key={point.title} delay={i * 100}>
                  <div className="h-full rounded-2xl border border-white/10 bg-white/[0.04] p-6">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 text-blue-300">
                      <Icon size={20} strokeWidth={2.25} />
                    </div>
                    <h3 className="mt-4 text-base font-bold text-white">{point.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-300">{point.description}</p>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* ============ TESTIMONIALS ============ */}
      <section className="px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <Reveal className="mx-auto max-w-xl text-center">
            <h2 className="text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
              What this looks like for a family
            </h2>
            <p className="mt-3 text-sm text-text-secondary">
              Illustrative examples of how families use Kith — not verified customer quotes.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-5 sm:grid-cols-3">
            {[
              {
                quote:
                  '"I used to keep our care-fund spreadsheet in my head. Now my brothers can just see it — and nobody has to ask me."',
                name: 'Illustrative example',
                role: 'Admin of a family care fund',
              },
              {
                quote:
                  '"We converted Dad\u2019s funeral fund straight into an ongoing support pool. Nothing about the original history disappeared."',
                name: 'Illustrative example',
                role: 'Extended family organizer',
              },
              {
                quote:
                  '"Grandma has never opened the app once. She\u2019s still fully part of the family pool because someone can act for her."',
                name: 'Illustrative example',
                role: 'Proxy manager for a parent',
              },
            ].map((t, i) => (
              <Reveal key={t.name + i} delay={i * 90}>
                <div className="h-full rounded-2xl border border-border bg-white p-6 shadow-card">
                  <p className="text-sm leading-relaxed text-text-primary">{t.quote}</p>
                  <div className="mt-5 border-t border-border pt-4">
                    <p className="text-sm font-semibold text-text-primary">{t.name}</p>
                    <p className="text-xs text-text-secondary">{t.role}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ============ FAQ ============ */}
      <section id="faq" className="bg-white px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-3xl">
          <Reveal className="text-center">
            <h2 className="text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">Questions, answered plainly</h2>
          </Reveal>
          <Reveal delay={100} className="mt-10">
            <FaqAccordion />
          </Reveal>
        </div>
      </section>

      {/* ============ FINAL CTA ============ */}
      <section className="px-4 py-20 sm:px-6 sm:py-28">
        <Reveal className="mx-auto max-w-4xl overflow-hidden rounded-3xl bg-primary px-6 py-14 text-center shadow-card-hover sm:px-16">
          <h2 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
            Your family already coordinates money.
            <br className="hidden sm:block" />
            Give it somewhere real to live.
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-base leading-relaxed text-blue-100">
            Free to get started. No card required — just you, your family, and two minutes.
          </p>
          <Link to="/signup" className="mt-8 inline-flex">
            <Button size="lg" className="!bg-white !text-primary hover:!bg-blue-50 group">
              Create your family workspace
              <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
            </Button>
          </Link>
        </Reveal>
      </section>

      {/* ============ FOOTER ============ */}
      <footer className="border-t border-border bg-white px-4 py-12 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 sm:flex-row">
          <div className="flex items-center gap-1 text-lg font-extrabold tracking-tight text-text-primary">
            ki<span className="text-primary">th</span>
          </div>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} className="text-sm text-text-secondary hover:text-text-primary">
                {link.label}
              </a>
            ))}
            <Link to="/login" className="text-sm text-text-secondary hover:text-text-primary">Log in</Link>
          </nav>
          <p className="text-xs text-text-secondary">© {new Date().getFullYear()} Kith. Built for families.</p>
        </div>
      </footer>
    </div>
  );
}
