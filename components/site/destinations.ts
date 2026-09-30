/**
 * Every page a visitor can reach, in the order the product explains itself.
 *
 * The nav and the 404 page both read this one list, so a page can never be in
 * the nav and missing from the 404, or the other way round. `label` is the
 * short form the nav shows; `title` and `blurb` are the longer form a person
 * who took a wrong turn needs to pick the page they meant.
 */
export const DESTINATIONS = [
  {
    href: "/",
    label: "What it does",
    title: "What Twiceheard does",
    blurb: "How a call works, and what the clinic sees for each field.",
  },
  {
    href: "/call",
    label: "Call the clinic",
    title: "Call the demo clinic",
    blurb: "Talk to the intake agent in your browser, the way a patient would.",
  },
  {
    href: "/desk",
    label: "Clinic desk",
    title: "Clinic desk",
    blurb: "Sign in at the front desk and read a finished chart, field by field.",
  },
] as const;

/** The page the visitor is on, and anything filed under it, is that section. */
export function isCurrent(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
