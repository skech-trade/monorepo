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
    a: "It says which way you think the price goes. Where the line starts is where you get in, and each turn in it is a change of mind — up from here, then down from there. Nothing else about the shape is a promise: the height of it is not a target and the dips are not levels. You only have to be right about the direction.",
  },
  {
    q: "Do I have to guess the right price?",
    a: "No, and that is the whole point. You are not picking a number or a band the price has to land inside. If you drew up and it goes up, you make money — a little if it moves a little, a lot if it moves a lot. Being right by more pays more; being right at all is what it takes.",
  },
  {
    q: "What if the price doesn't follow my line?",
    a: "It almost never will, and it doesn't need to. You're paid on where the price actually goes while you're in it, not on how closely it traced what you drew.",
  },
  {
    q: "What closes a trade?",
    a: "The clock, your own hand, the levels you set, or the margin. A round runs about a minute and marks out at the end; you can take it off whenever you like; you can say up front to close it if you lose or make a set amount; and if the price runs far enough against you, it closes itself. Nothing closes at a level you didn't ask for.",
  },
  {
    q: "Can I set a limit on what I lose?",
    a: "Yes, in money. \u201cPut in $100, close it if I lose $50, close it if I make $70\u201d \u2014 those are the two numbers, and you type them rather than draw them. Both are optional, and you can never lose more than you put in either way.",
  },
  {
    q: "What is the boost?",
    a: "How hard your money works. At 50\u00d7 a hundred dollars moves like five thousand, so a small move is worth having \u2014 and a move against you runs out that much faster. It cuts both ways, it is the fastest way to lose what you put in, and you can never lose more than that.",
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
