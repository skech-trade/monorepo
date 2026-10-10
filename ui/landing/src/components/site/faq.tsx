import { DIFFICULTY, difficulty } from "@skech/core/dots";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Reveal } from "./motion";
import { SectionScene } from "./illo";
import styles from "./story.module.css";

/* The ladder's ends, from the game rather than from this page. */
const RULES = difficulty(DIFFICULTY);
const MOST = RULES.maxMultiple;
const LEAST = RULES.minMultiple;

const FAQS = [
  {
    q: "What does my drawing actually do?",
    a: "Your line is cut into one-second pieces. Each piece covers a small band of prices, and it pays if the price comes through that band during that second. The seconds it misses are gone.",
  },
  {
    q: "Do I have to guess the right price?",
    a: "Near enough, yes. A piece of your line covers a band of prices for one second and pays only if the price passes through it. A wider pen covers more of the chart and pays less for being there.",
  },
  {
    q: "What if the price doesn't follow my line?",
    a: "It will not, and it does not have to. Only the seconds the price spent inside your line pay. A line that catches half of them has done well.",
  },
  {
    q: "How much does a hit pay?",
    a: `Every piece sits on a rung, from ${LEAST}\u00d7 up to ${MOST}\u00d7. The rung is set by how likely that band was: ink where the price was never expected pays the most for being right.`,
  },
  {
    q: "When is a drawing finished?",
    a: "Each second of ink is judged as the price reaches it, from the price that second really traded at. When the last piece has been judged, the drawing is done.",
  },
  {
    q: "Can I set a limit on what I lose?",
    a: "You set it before you draw. Every dot costs what you chose, from ten cents to a dollar, and you can never lose more than the ink you put down.",
  },
  {
    q: "Do you hold my money?",
    a: "Your balance is USDC held by the game on Solana. Deposits, withdrawals and every drawing are transactions on chain, and skech pays the network fee for them.",
  },
  {
    q: "Why has nobody built this before?",
    a: "Following a hand-drawn line means keeping up with the hand. Chains only got fast enough for that recently.",
  },
] as const;

/**
 * The first answer is open so the questions read as part of the page.
 *
 * Plain <details>, one open at a time through their shared `name`: the browser
 * does what Base UI's accordion did, with no script to load or hydrate.
 */
export function Faq() {
  return (
    <section aria-labelledby="faq-title" className={styles.faq} id="faq">
      <Reveal>
        <h2 className={styles.title} id="faq-title">
          Questions, answered.
        </h2>
        <SectionScene className={styles.faqArt} name="faq" />
      </Reveal>

      <div className={styles.questions}>
        {FAQS.map((item, i) => (
            <details className={cn("group border-b last:border-b-0", styles.question)} key={item.q} name="faq" open={i === 0}>
              <summary className="flex flex-1 cursor-pointer list-none items-start justify-between gap-4 rounded-md py-5 text-left font-medium text-body text-foreground outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                {item.q}
                <ChevronDownIcon
                  aria-hidden="true"
                  className="pointer-events-none size-4 shrink-0 translate-y-0.5 opacity-80 transition-transform duration-200 ease-in-out group-open:rotate-180"
                />
              </summary>
              <div className="measure pt-0 pb-6 text-fg-muted text-sm leading-[1.75]">
                {item.a}
              </div>
            </details>
        ))}
      </div>
    </section>
  );
}
