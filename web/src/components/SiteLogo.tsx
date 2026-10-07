// The SharpSlate logo, as on sharpslatesports.com: the S mark and the SharpSlate lettering.
// Each comes in two versions, light lettering for the dark theme and dark lettering for the
// light one; the stylesheet shows the one that fits the theme in use, and being lazy, the
// hidden one is never downloaded.
import mark from "../assets/sharpslate-mark.png";
import markOnLight from "../assets/sharpslate-mark-on-light.png";
import word from "../assets/sharpslate-word.png";
import wordOnLight from "../assets/sharpslate-word-on-light.png";

export const SITE_NAME = "SharpSlate Leagues";

/** The S mark alone, for tight spots like the phone's top bar. */
export function SiteMark({ size = 30 }: { size?: number }) {
  return (
    <span className="site-mark" aria-hidden="true">
      <img className="on-dark" src={mark} alt="" width={size} height={size} loading="lazy" />
      <img className="on-light" src={markOnLight} alt="" width={size} height={size} loading="lazy" />
    </span>
  );
}

/** The mark, the SharpSlate lettering and LEAGUES under it. `large` is for the sign-in and league pages. */
export function SiteLogo({ large }: { large?: boolean }) {
  const h = large ? 24 : 17;
  const w = Math.round((685 / 96) * h);
  return (
    <span className={`site-logo${large ? " large" : ""}`} role="img" aria-label={SITE_NAME}>
      <SiteMark size={large ? 44 : 30} />
      <span className="site-logo-text" aria-hidden="true">
        <img className="on-dark" src={word} alt="" width={w} height={h} loading="lazy" />
        <img className="on-light" src={wordOnLight} alt="" width={w} height={h} loading="lazy" />
        <span className="site-logo-sub">Leagues</span>
      </span>
    </span>
  );
}
