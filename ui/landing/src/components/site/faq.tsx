import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Reveal } from "./motion";
import { SectionScene } from "./illo";
import styles from "./story.module.css";

const FAQS = [
  {
    q: "What does my drawing actually do?",
    a: "It says which way you think the price is going. Draw it going up and you win if it goes up. Draw it turning down and from that point you win if it falls. That is all it has to get right.",
  },
  {
    q: "Do I have to guess the right price?",
    a: "No. You are not picking a number or a range to land in. Draw up, and if it goes up you make money. The bigger the move, the more you make.",
  },
  {
    q: "What if the price doesn't follow my line?",
    a: "It won't, and that is fine. You get paid on which way the price actually went, not on how close it came to your line.",
  },
  {
    q: "What closes a trade?",
    a: "The clock, you, or a limit you set. A round lasts about a minute. You can close it early whenever you like. And if it goes far enough against you, it closes on its own.",
  },
  {
    q: "Can I set a limit on what I lose?",
    a: "Yes. You type the numbers: put in $100, close if I lose $50, close if I make $70. Both are optional, and you can never lose more than you put in.",
  },
  {
    q: "What is the boost?",
    a: "It makes your money work harder. At 50\u00d7 your $100 moves like $5,000, so wins get bigger and so do losses. You still cannot lose more than you put in.",
  },
  {
    q: "Do you hold my money?",
    a: "No. Nothing to install, no account to approve, and we never hold your funds.",
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
