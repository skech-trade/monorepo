import Image from "next/image";
import revealDark from "../../../public/assets/illo/reveal-wide-dark.png";
import reveal from "../../../public/assets/illo/reveal-wide.png";
import { Body } from "./type";
import styles from "./reveal-band.module.css";

/**
 * What a finished line looks like, after the three chapters have explained how one is drawn.
 *
 * It sits outside StoryStack rather than inside it: the stack pins its chapters and gives each one a z-index by
 * `nth-child`, so a fourth child there would reorder the cards that recede behind one another.
 */
export function RevealBand() {
  return (
    <section aria-labelledby="reveal-title" className={styles.band}>
      <div className={styles.copy}>
        <h2 className={styles.title} id="reveal-title">
          Only the ink it runs through pays.
        </h2>
        <Body className={styles.lead}>
          Your line becomes a row of seconds. The price came through five of these eight, and those five paid their rung. The other three are gone.
        </Body>
      </div>
      {/* Both twins ship; the stylesheet shows whichever the theme calls for, as the scenes do. */}
      <Image alt="" aria-hidden="true" className={`${styles.art} ${styles.lightArt}`} sizes="(max-width: 63.999rem) calc(100vw - 3rem), 70rem" src={reveal} />
      <Image alt="" aria-hidden="true" className={`${styles.art} ${styles.darkArt}`} sizes="(max-width: 63.999rem) calc(100vw - 3rem), 70rem" src={revealDark} />
    </section>
  );
}
