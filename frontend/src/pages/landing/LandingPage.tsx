import { Link } from 'react-router-dom';
import { useState } from 'react';
import {
  ArrowRight,
  Menu,
  X,
  History,
  Users,
  ClipboardCheck,
  Archive,
  Play,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Reveal } from '@/components/landing/Reveal';
import { LedgerStrip } from '@/components/landing/LedgerStrip';
import { NestingDiagram } from '@/components/landing/NestingDiagram';
import { CurrencyBar } from '@/components/landing/CurrencyBar';
import { FaqAccordion } from '@/components/landing/FaqAccordion';
import { SectionEyebrow } from '@/components/landing/SectionEyebrow';
import { ChatVsKith } from '@/components/landing/ChatVsKith';
import { DashboardPreview } from '@/components/landing/DashboardPreview';
import { CycleAnimation } from '@/components/landing/CycleAnimation';
import { ActivityTimeline } from '@/components/landing/ActivityTimeline';
import { MemberList } from '@/components/landing/MemberList';
import { TaskStoryCards } from '@/components/landing/TaskStoryCards';

const NAV_LINKS = [
  { label: 'How it works', href: '#how-it-works' },
  { label: 'Features', href: '#features' },
  { label: 'Security', href: '#security' },
  { label: 'FAQ', href: '#faq' },
];

const TOOL_COMPARISON = [
  { title: 'Messaging apps', desc: 'Great for conversations. Not great for tracking commitments over time.' },
  { title: 'Spreadsheets', desc: 'Great for calculations. Not great for involving an entire family.' },
  { title: 'Notes', desc: 'Great for personal reminders. Not great for shared coordination.' },
  { title: 'Kith', desc: 'Designed specifically for families working together, not teams or businesses.', highlight: true },
];

const MONEY_CARDS = [
  { title: 'Shared contribution progress', desc: 'Everyone sees how close the family is to reaching the goal.' },
  { title: 'Transparent history', desc: "Every contribution becomes part of the family's shared record." },
  { title: 'Payment confirmation', desc: 'Members submit proof of payment so everyone stays informed.' },
];

const TRUST_POINTS = [
  { icon: History, title: 'Contribution History', description: "Every contribution becomes part of a running record — who gave, when, and what it was for. Nobody has to ask, and nobody has to remember." },
  { icon: Users, title: 'Shared Activity', description: "Everyone in the family sees the same updates as they happen, so no one is left wondering what they missed." },
  { icon: ClipboardCheck, title: 'Clear Responsibilities', description: "Every task has an owner and a status, so it's always obvious what's done and what still needs attention." },
  { icon: Archive, title: 'Organized Records', description: "Receipts, notes, and updates stay attached to the event they belong to, instead of buried in a chat thread from months ago." },
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
            <a key={link.href} href={link.href} className="text-sm font-medium text-text-secondary transition-colors hover:text-text-primary">
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Link to="/login" className="text-sm font-semibold text-text-secondary hover:text-text-primary transition-colors px-3 py-2">
            Log in
          </Link>
          <Link to="/signup">
            <Button size="sm">Get started free</Button>
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

      {/* ============ 1. HERO ============ */}
      <section className="relative overflow-hidden px-4 pt-16 pb-20 sm:px-6 sm:pt-24 sm:pb-28">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[640px] opacity-60"
          style={{ background: 'radial-gradient(60% 50% at 50% 0%, rgba(37,99,235,0.10) 0%, rgba(37,99,235,0) 70%)' }}
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
              Everything your family needs
              <br />
              to coordinate life together.
            </h1>
          </Reveal>
          <Reveal delay={160}>
            <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-text-secondary">
              Birthdays, healthcare, monthly support, celebrations. Kith brings every responsibility your
              family shares into one organized home — instead of scattered across group chats, notes, and memory.
            </p>
          </Reveal>
          <Reveal delay={240}>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to="/signup" className="w-full sm:w-auto">
                <Button size="lg" fullWidth className="sm:w-auto group">
                  Explore Kith
                  <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
                </Button>
              </Link>
              <a href="#how-it-works" className="w-full sm:w-auto">
                <Button variant="secondary" size="lg" fullWidth className="sm:w-auto group">
                  <Play size={14} /> Watch a 90-second walkthrough
                </Button>
              </a>
            </div>
          </Reveal>
          <Reveal delay={300}>
            <p className="mt-4 text-xs text-text-secondary">No card required. Set up your family in under two minutes.</p>
          </Reveal>
        </div>

        <Reveal delay={360} className="mx-auto mt-16 max-w-5xl">
          <DashboardPreview />
        </Reveal>
      </section>

      {/* ============ CURRENCY TRUST BAR ============ */}
      <section className="border-y border-border bg-white px-4 py-10 sm:px-6">
        <Reveal className="mx-auto max-w-4xl text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-text-secondary">
            Every family coordinates in the currency that makes sense for them
          </p>
          <div className="mt-5">
            <CurrencyBar />
          </div>
          <p className="mt-3 text-xs text-text-secondary">
            A few examples — Kith supports every global currency, so distance never gets in the way of family.
          </p>
        </Reveal>
      </section>

      {/* ============ 2. THE PROBLEM ============ */}
      <section className="px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-4xl">
          <Reveal className="mx-auto max-w-xl text-center">
            <SectionEyebrow pillar="neutral">The Problem</SectionEyebrow>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
              Family coordination shouldn't depend on memory and group chats.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-text-secondary">
              Someone reminds relatives about contributions. Someone tracks who's paid. Someone answers the
              same question twice. Not because families don't care — because they were never given the right tools.
            </p>
          </Reveal>
          <Reveal delay={120} className="mt-14">
            <ChatVsKith />
          </Reveal>
        </div>
      </section>

      {/* ============ 3. WHY EXISTING TOOLS BREAK DOWN ============ */}
      <section className="bg-white px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <Reveal className="mx-auto max-w-xl text-center">
            <SectionEyebrow pillar="neutral">A different kind of tool</SectionEyebrow>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
              The problem isn't your family. It's the tools.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-text-secondary">
              Messaging apps are great for conversations. Spreadsheets are great for calculations. But families
              don't just communicate — they coordinate, and that takes structure.
            </p>
          </Reveal>
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {TOOL_COMPARISON.map((c, i) => (
              <Reveal key={c.title} delay={i * 90}>
                <div
                  className={
                    c.highlight
                      ? 'h-full rounded-2xl border border-primary/30 bg-primary/[0.04] p-6'
                      : 'h-full rounded-2xl border border-border bg-white p-6 shadow-card'
                  }
                >
                  <h3 className={c.highlight ? 'text-base font-bold text-primary' : 'text-base font-bold text-text-primary'}>
                    {c.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{c.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ============ 4. HOW KITH WORKS ============ */}
      <section id="how-it-works" className="px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-16">
            <Reveal>
              <SectionEyebrow pillar="neutral">How it works</SectionEyebrow>
              <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
                One shared home for everything your family coordinates.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-text-secondary">
                A <strong className="text-text-primary">Workspace</strong> is your family. Inside it, a{' '}
                <strong className="text-text-primary">Container</strong> is whatever you're coordinating. Inside
                that, the <strong className="text-text-primary">Ledger</strong> is the honest record of every
                contribution. Nothing floats outside this structure.
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

      {/* ============ 5. FINANCIAL COORDINATION ============ */}
      <section id="features" className="bg-white px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <Reveal className="mx-auto max-w-xl text-center">
            <SectionEyebrow pillar="money">Coordinate family money together</SectionEyebrow>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
              Everyone always knows where things stand.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-text-secondary">
              Contribution progress, remaining balance, who's paid, upcoming deadlines — visible to everyone,
              all the time. No more guessing. No more repeated questions.
            </p>
          </Reveal>
          <Reveal delay={120} className="mt-14">
            <LedgerStrip />
          </Reveal>
          <div className="mt-10 grid gap-5 sm:grid-cols-3">
            {MONEY_CARDS.map((c, i) => (
              <Reveal key={c.title} delay={i * 90}>
                <div className="h-full rounded-2xl border border-border bg-white p-6 shadow-card">
                  <h3 className="text-base font-bold text-text-primary">{c.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{c.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ============ 6. RESPONSIBILITIES BEYOND MONEY ============ */}
      <section className="px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <Reveal className="mx-auto max-w-xl text-center">
            <SectionEyebrow pillar="responsibility">Beyond money</SectionEyebrow>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
              Keep everyone aligned — even when money isn't involved.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-text-secondary">
              Decorations, venues, phone calls, favors. Kith tracks those commitments alongside everything else
              so nothing gets forgotten.
            </p>
          </Reveal>
          <Reveal delay={120} className="mt-14">
            <TaskStoryCards />
          </Reveal>
        </div>
      </section>

      {/* ============ 7. RECURRING FAMILY COMMITMENTS ============ */}
      <section className="bg-white px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-16">
            <Reveal>
              <SectionEyebrow pillar="money">Some commitments never end</SectionEyebrow>
              <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
                Some family commitments happen every month. Kith remembers them for you.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-text-secondary">
                Monthly healthcare support. Education funds. Community obligations. Instead of recreating
                everything from scratch every month, Kith keeps recurring coordination running smoothly so
                everyone always knows what's next.
              </p>
            </Reveal>
            <Reveal delay={120}>
              <CycleAnimation />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ============ 8. INCLUDE EVERY FAMILY MEMBER ============ */}
      <section className="px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-16">
            <Reveal>
              <SectionEyebrow pillar="responsibility">Inclusion</SectionEyebrow>
              <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
                Because every family member deserves to be included.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-text-secondary">
                Not everyone in the family wants an account. Grandma Ruth has never opened the app once — but a
                trusted family member can act on her behalf, fully audited, so she's still part of every
                celebration and every fund.
              </p>
            </Reveal>
            <Reveal delay={120}>
              <MemberList />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ============ 9. SHARED HISTORY ============ */}
      <section className="bg-white px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-16">
            <Reveal delay={120} className="order-2 lg:order-1">
              <ActivityTimeline />
            </Reveal>
            <Reveal className="order-1 lg:order-2">
              <SectionEyebrow pillar="trust">Shared history</SectionEyebrow>
              <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
                A shared history your family can always come back to.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-text-secondary">
                Birthdays become anniversaries. Healthcare support continues for years. Kith keeps everything
                organized so your family always knows what happened, when, and who was involved.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ============ 10. DASHBOARD ============ */}
      <section className="px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <Reveal className="mx-auto max-w-xl text-center">
            <SectionEyebrow pillar="neutral">The dashboard</SectionEyebrow>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
              Know what needs your attention the moment you open Kith.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-text-secondary">
              Upcoming events, pending contributions, tasks assigned to you, recent activity — everything
              important, visible at a glance.
            </p>
          </Reveal>
          <Reveal delay={120} className="mt-14">
            <DashboardPreview annotated />
          </Reveal>
        </div>
      </section>

      {/* ============ 11. AUTOMATION ============ */}
      <section className="bg-white px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-16">
            <Reveal>
              <SectionEyebrow pillar="money">Quiet automation</SectionEyebrow>
              <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
                The little things happen automatically, so your family doesn't have to remember everything.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-text-secondary">
                Imagine your family contributes toward your parents' monthly healthcare. Nobody has to remember
                to recreate the contribution every month — Kith keeps the process moving, and your family
                simply continues supporting each other.
              </p>
            </Reveal>
            <Reveal delay={120}>
              <CycleAnimation />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ============ 12. TRUST / TRANSPARENCY ============ */}
      <section id="security" className="bg-text-primary px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <Reveal className="mx-auto max-w-xl text-center">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-blue-300">
              <History size={14} /> Transparency
            </span>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              Everyone stays informed. Nobody has to guess.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-slate-300">
              Trust isn't a promise Kith makes — it's what happens naturally when every contribution,
              task, and update has a clear, visible home.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {TRUST_POINTS.map((point, i) => {
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

      {/* ============ 13. SEE KITH IN ACTION ============ */}
      <section className="px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-4xl text-center">
          <Reveal>
            <SectionEyebrow pillar="neutral">See Kith in action</SectionEyebrow>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
              Take a quick tour before you decide.
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-base leading-relaxed text-text-secondary">
              A 60-90 second walkthrough of the real product — no voiceover, real interactions, no fake interface.
            </p>
          </Reveal>
          <Reveal delay={120} className="mt-10">
            {/*
              PLACEHOLDER: replace this button/frame with a real <video> element
              once the walkthrough is recorded, e.g.:
              <video controls poster="/assets/walkthrough-poster.jpg" className="w-full rounded-3xl">
                <source src="/assets/walkthrough.mp4" type="video/mp4" />
              </video>
            */}
            <div className="mx-auto flex aspect-video max-w-2xl items-center justify-center rounded-3xl border border-border bg-white shadow-card-hover">
              <button
                className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-white shadow-lg hover:bg-primary-hover transition-colors"
                aria-label="Play walkthrough video"
              >
                <Play size={22} className="ml-1" fill="white" />
              </button>
            </div>
            <p className="mt-3 text-xs text-text-secondary">Walkthrough video placeholder — drop in the recorded MP4 when ready.</p>
          </Reveal>
        </div>
      </section>

      {/* ============ 14. FAQ ============ */}
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

      {/* ============ 15. FINAL CTA ============ */}
      <section className="px-4 py-20 sm:px-6 sm:py-28">
        <Reveal className="mx-auto max-w-4xl overflow-hidden rounded-3xl bg-primary px-6 py-14 text-center shadow-card-hover sm:px-16">
          <h2 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
            Your family already works together.
            <br className="hidden sm:block" />
            Kith simply makes it easier.
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-base leading-relaxed text-blue-100">
            Stop relying on scattered messages, forgotten reminders, and outdated spreadsheets. Start organizing with confidence.
          </p>
          <Link to="/signup" className="mt-8 inline-flex">
            <Button size="lg" className="!bg-white !text-primary hover:!bg-blue-50 group">
              Create Your Family Workspace
              <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
            </Button>
          </Link>
        </Reveal>
      </section>

      {/* ============ 16. FOOTER ============ */}
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
          <p className="text-xs text-text-secondary">Questions? kithnoreply@gmail.com</p>
        </div>
        <p className="mt-6 text-center text-xs text-text-secondary">© {new Date().getFullYear()} Kith. Built for families.</p>
      </footer>
    </div>
  );
}
