import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Reveal } from "./motion";
import { SectionScene } from "./illo";
import styles from "./story.module.css";

const FAQS = [
  {
    q: "What does my drawing actually do?",
    a: "Where the line starts is where you get in, and where it ends up decides whether you're long or short. The shape in between is the forecast — the whole of it counts, not just where you stopped drawing.",
  },
  {
    q: "What if the price doesn't follow my line?",
    a: "It almost never will, and it doesn't need to. You're paid on where the price actually goes while you're in it, not on how close it came to the line you drew.",
  },
  {
    q: "What closes a trade?",
    a: "The clock, your own hand, or the margin. A round runs for a set stretch and marks out at the end, you can take it off at any point before that, and if the price runs far enough against you at the leverage you chose, you're liquidated. There's no stop you didn't set and no target you didn't ask for.",
  },
  {
    q: "Can I change it after?",
    a: "Yes. Every point ahead of the current candle is still yours to move while it plays out, and moving one updates the trade you already have rather than opening a second one. You pay one round trip either way, so redrawing is free.",
  },
  {
    q: "What does the leverage do?",
    a: "Both ends of it. At 50× a hundred dollars moves like five thousand, so a small move is worth having — and a move against you eats the margin that much faster. You can never lose more than you put in.",
  },
  {
    q: "Do you hold my money?",
    a: "No. Nothing to install, no account to approve, and we never take custody of anything.",
  },
  {
    q: "Why has nobody built this before?",
    a: "Following a hand-drawn line means keeping up with the hand. Blockchains only recently got fast enough that the line you get is the line you meant.",
  },
] as const;

/** The first answer is open so the questions read as part of the page. */
export function Faq() {
  return (
    <section aria-labelledby="faq-title" className={styles.faq} id="faq">
      <Reveal>
        <h2 className={styles.title} id="faq-title">
          Questions, answered.
        </h2>
        <SectionScene className={styles.faqArt} name="faq" />
      </Reveal>

      <Accordion className={styles.questions} defaultValue={[FAQS[0].q]}>
        {FAQS.map((item) => (
            <AccordionItem className={styles.question} key={item.q} value={item.q}>
              <AccordionTrigger className="py-5 text-left text-body text-foreground data-panel-open:text-foreground">
                {item.q}
              </AccordionTrigger>
              <AccordionPanel className="measure pt-0 pb-6 text-fg-muted text-sm leading-[1.75]">
                {item.a}
              </AccordionPanel>
            </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}
