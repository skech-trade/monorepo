import Image from "next/image";
import styles from "./features.module.css";

const FEATURES = [
  {
    image: "funding",
    title: "Funds in. Funds out.",
    description: "Easy deposits and withdrawals, all in one place.",
  },
  {
    image: "leverage",
    title: "Boost up to 50×",
    description: "Put in a little, trade like a lot.",
  },
  {
    image: "fees",
    title: "Low trading fees",
    description: "Keep your trading costs low, with no fee to redraw.",
  },
  {
    image: "markets",
    title: "Crypto and stocks",
    description: "Different markets. The same simple way to draw a trade.",
  },
  {
    image: "redraw",
    title: "Redraw for free",
    description: "Change your path and update your trade without a redraw fee.",
  },
  {
    image: "rewards",
    title: "Earn rewards in skech.",
    description: "Discover more ways to earn rewards in skech.",
  },
] as const;

/** An asymmetric bento, with funding and leverage as the anchors. */
export function Features() {
  return (
    <section aria-labelledby="features-title" className={styles.section} id="features">
      <div className={styles.heading}>
        <h2 id="features-title">What skech enables.</h2>
        <p>From moving funds to finding your next market.</p>
      </div>
      <div className={styles.grid}>
        {FEATURES.map(feature => (
          <article className={`${styles.feature} ${styles[feature.image]}`} key={feature.image}>
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
                  src={feature.image === "redraw" ? `/assets/illo/features/redraw-wide-${theme}.png` : `/assets/illo/features/${feature.image}${theme === "dark" ? "-dark" : feature.image === "funding" || feature.image === "markets" ? "-v4" : feature.image === "leverage" ? "-v3" : ""}.png`}
                  width={feature.image === "redraw" ? 1500 : 1200}
                  height={feature.image === "redraw" ? 500 : feature.image === "leverage" ? 1600 : 900}
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
