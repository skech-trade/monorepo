import { LogoLink } from "./logo";
import { StartApp } from "./start-app";
// Dark mode temporarily disabled.
// import { ThemeToggle } from "./theme-toggle";

/**
 * A plain topbar that scrolls away, like family.co's.
 *
 * It used to be a fixed glass pill. Over a white page the translucency has
 * nothing to tint, so the pill read as an empty outlined box floating over the
 * content, and it sat on top of the canvas you are meant to draw on.
 */
export function SiteNav() {
  return (
    <header>
      <div className="container-x flex items-center justify-between gap-6 px-4 py-4 sm:px-6 md:py-6 lg:px-8">
        <LogoLink />

        <div className="flex items-center gap-1.5">
          {/* <ThemeToggle /> */}

          <StartApp className="h-9 shrink-0 px-4 text-[0.9375rem]" />
        </div>
      </div>
    </header>
  );
}
