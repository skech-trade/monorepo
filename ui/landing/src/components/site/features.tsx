import Image from "next/image";
import { DIFFICULTY, difficulty } from "@skech/core/dots";
import styles from "./features.module.css";

/*
  The most one dot can pay, read from the game's own settings rather than written here. The page said 50x while
  the game paid 14x, and the artwork said 15x: three numbers, none of them the game's. A number the page cannot
  set is a number it cannot get wrong.
*/
const MOST = difficulty(DIFFICULTY).maxMultiple;

/**
 * `slot` is the tile's place in the bento (features.module.css owns those names); `art` is what it shows. They are
 * separate because the layout outlived the product: the grid areas still read as the perps app this began as.
 */
const FEATURES = [
  {
    slot: "funding",
    art: { light: "funding-v4", dark: "funding-dark" },
    size: [1200, 900],
    title: "Funds in. Funds out.",
    description: "Easy deposits and withdrawals, all in one place.",
  },
  {
    slot: "leverage",
    art: { light: "ladder", dark: "ladder-dark" },
    size: [1254, 1254],
    title: `Up to ${MOST}\u00d7 a dot`,
    description: "Every dot sits on a rung. The less likely the ink, the more that rung pays.",
  },
  {
    slot: "fees",
    art: { light: "fees", dark: "fees-dark" },
    size: [1200, 900],
    title: "Low trading fees",
    description: "Keep your trading costs low, with no fee to redraw.",
  },
  {
    slot: "markets",
    art: { light: "bitcoin", dark: "bitcoin-dark" },
    size: [1254, 1254],
    title: "Bitcoin, second by second",
    description: "One market, judged one second at a time against the price it really traded at.",
  },
  {
    slot: "redraw",
    art: { light: "redraw-wide-light", dark: "redraw-wide-dark" },
    size: [1500, 500],
    title: "Redraw for free",
    description: "Change your path and update your trade without a redraw fee.",
  },
  {
    slot: "rewards",
    art: { light: "practice", dark: "practice-dark" },
    size: [1402, 1122],
    title: "Try it free",
    description: "A full run on the real odds, played with paper money. No wallet, no sign-in.",
  },
] as const;

/** An asymmetric bento, with funding and leverage as the anchors. */
export function Features() {
  return (
    <section aria-labelledby="features-title" className={styles.section} id="features">
      <div className={styles.heading}>
        <h2 id="features-title">What skech enables.</h2>
        <p>From your first free run to the ink that pays.</p>
      </div>
      <div className={styles.grid}>
        {FEATURES.map(feature => (
          <article className={`${styles.feature} ${styles[feature.slot]}`} key={feature.slot}>
            <div className={styles.caption}>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </div>
            <div className={styles.artwork}>
              {(["light", "dark"] as const).map(theme => (
                <Image
                  key={theme}
                  alt=""
                  className={theme === "dark" ? styles.darkArt : styles.lightArt}
                  src={`/assets/illo/features/${feature.art[theme]}.png`}
                  width={feature.size[0]}
                  height={feature.size[1]}
                  sizes="(max-width: 767px) calc(100vw - 56px), (max-width: 1023px) 45vw, 500px"
                />
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
