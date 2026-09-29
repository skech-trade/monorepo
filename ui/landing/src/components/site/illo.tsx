import Image from "next/image";
import { cn } from "@/lib/utils";
import heroLeft from "../../../public/assets/illo/hero-left.png";
import heroLeftDark from "../../../public/assets/illo/hero-left-dark.png";
import heroRightDark from "../../../public/assets/illo/hero-right-dark.png";
import heroRight from "../../../public/assets/illo/hero-right.png";
import heroPhone from "../../../public/assets/illo/mobile-hero.png";
import cta from "../../../public/assets/illo/cta-scene.png";
import band from "../../../public/assets/illo/band-cast.png";
import steps from "../../../public/assets/illo/spot-steps.png";
import example from "../../../public/assets/illo/spot-example.png";
import redraw from "../../../public/assets/illo/spot-redraw.png";
import faq from "../../../public/assets/illo/spot-faq.png";
import sceneSteps from "../../../public/assets/illo/scene-steps.png";
import sceneExample from "../../../public/assets/illo/scene-example.png";
import sceneRedraw from "../../../public/assets/illo/scene-redraw.png";
import sceneFaq from "../../../public/assets/illo/scene-faq.png";
import sceneStepsDark from "../../../public/assets/illo/scene-steps-dark.png";
import sceneExampleDark from "../../../public/assets/illo/scene-example-dark.png";
import sceneRedrawDark from "../../../public/assets/illo/scene-redraw-dark.png";
import sceneFaqDark from "../../../public/assets/illo/scene-faq-dark.png";
import { IllustrationPalette } from "./illustration-palette";
import styles from "./illo.module.css";

/*
 * The illustration layer.
 *
 * Static imports give changed artwork a new content-hashed URL, including in
 * Next's image cache. Dark mode remaps the neutral inks through the shared SVG
 * filter while keeping the blue, yellow, green and red fills at full opacity.
 * These small palette PNGs bypass lossy optimisation, which otherwise adds
 * colour noise and fringes that become visible when the neutrals are remapped.
 */
const SLOTS = {
  heroLeft,
  heroRight,
  cta,
  band,
  steps,
  example,
  redraw,
  faq,
} as const;

const SECTION_SCENES = {
  steps: { light: sceneSteps, dark: sceneStepsDark },
  example: { light: sceneExample, dark: sceneExampleDark },
  redraw: { light: sceneRedraw, dark: sceneRedrawDark },
  faq: { light: sceneFaq, dark: sceneFaqDark },
} as const;

export function SectionScene({
  name,
  className,
}: {
  name: keyof typeof SECTION_SCENES;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cn(styles.sectionScene, className)}>
      {/* Recolour before browser scaling, so ink edges stay smooth at any size. */}
      <Image
        alt=""
        className={cn(styles.sectionArtwork, styles.sectionLight)}
        src={SECTION_SCENES[name].light}
        unoptimized
      />
      <Image
        alt=""
        className={cn(styles.sectionArtwork, styles.sectionDark)}
        src={SECTION_SCENES[name].dark}
        unoptimized
      />
    </span>
  );
}

/**
 * One character above a section heading.
 *
 * Small on purpose. These sit over a heading that is already doing the work, so
 * they are a mark rather than a scene, with a 112px slot and generous padding
 * already included in each asset.
 */
export function Spot({
  name,
  className,
}: {
  name: "steps" | "example" | "redraw" | "faq";
  className?: string;
}) {
  const s = SLOTS[name];
  return (
    <Image
      alt=""
      aria-hidden="true"
      className={cn(
        styles.image,
        "pointer-events-none mx-auto size-28 select-none",
        className,
      )}
      sizes="112px"
      src={s}
      unoptimized
    />
  );
}

/**
 * The hero art: two flanks on a wide screen, one drawn scene on a phone.
 *
 * Each flank is weighted away from the centre and nearly empty on its inner
 * third, which is the side the headline sits on.
 *
 * Phones get their own asset rather than a scaled-up flank. The flank is a
 * half-composition cropped for the edge of a wide page, so filling a phone
 * with it meant blowing it up to 24rem and sliding it off centre — the
 * characters came out enormous and the half that was designed to sit under
 * the headline was the half on screen. `mobile-hero.png` is the whole cast at
 * a size a phone can hold.
 *
 * Both are in the markup and CSS picks one, rather than branching on a media
 * query in JavaScript: the art is above the fold, and a layout that waits for
 * hydration to decide what to paint shows the wrong one first.
 */
export function HeroScene() {
  return (
    <div aria-hidden="true" className={styles.scene}>
      <IllustrationPalette />
      <Flank slot="heroLeft" side="left" />
      <Flank slot="heroRight" side="right" />
      {/*
        The one illustration here that is optimised rather than served raw.
        The others are small palette PNGs where Next's lossy pass adds fringes
        that the dark-mode remap then amplifies; this one is a 1402px asset
        drawn at 320px, and `unoptimized` means no srcset, so the browser was
        doing the whole 2.19x reduction itself in one step and softening the
        edges. Sharp resamples it once, properly, at each width in the srcset.
        `quality` is up at 96 because the art is flat colour with hard edges,
        which is exactly what a default-quality encode smears.
      */}
      <Image
        alt=""
        className={cn(styles.image, styles.legacyImage, styles.phoneArt)}
        fetchPriority="high"
        loading="eager"
        quality={96}
        sizes="20rem"
        src={heroPhone}
      />
    </div>
  );
}

function Flank({
  slot,
  side,
}: {
  slot: "heroLeft" | "heroRight";
  side: "left" | "right";
}) {
  const s = SLOTS[slot];
  const dark = side === "left" ? heroLeftDark : heroRightDark;
  return (
    <span className={cn(styles.flank, side === "left" ? styles.left : styles.right)}>
      <Image alt="" className={cn(styles.sectionArtwork, styles.sectionLight)} fetchPriority="high" loading="eager" src={s} unoptimized />
      <Image alt="" className={cn(styles.sectionArtwork, styles.sectionDark)} fetchPriority="high" loading="eager" src={dark} unoptimized />
      <span className={cn(styles.accent, styles.accentSquare)} />
      <span className={cn(styles.accent, styles.accentDot)} />
      <span className={cn(styles.accent, styles.accentDash)} />
    </span>
  );
}

/**
 * The whole cast, as a break between movements.
 *
 * It sits between the last walkthrough and the questions, which was the longest
 * unbroken run of dark panels on the page. Purely a breath: nothing here is
 * information.
 */
export function BandScene({ className }: { className?: string }) {
  return (
    <div className={cn("container-x px-4 sm:px-6 lg:px-8", className)}>
      <Image
        alt=""
        aria-hidden="true"
        className={cn(
          styles.image,
          styles.legacyImage,
          "pointer-events-none mx-auto h-auto w-full max-w-[34rem] select-none",
        )}
        sizes="(max-width: 576px) 90vw, 544px"
        src={SLOTS.band}
        unoptimized
      />
    </div>
  );
}

/** The closing band scene, beside the way into the app. */
export function CtaScene({ className }: { className?: string }) {
  return (
    <Image
      alt=""
      aria-hidden="true"
      className={cn(
        styles.image,
        styles.legacyImage,
        "pointer-events-none select-none",
        className,
      )}
      sizes="(max-width: 448px) 85vw, 384px"
      src={SLOTS.cta}
      unoptimized
    />
  );
}
