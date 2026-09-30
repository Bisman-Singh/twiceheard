// Prints docs/deck.html to docs/deck.pdf.
//
// The deck is HTML so its figures can be checked against the repository the same way
// every other claim is, and so a correction is a one line diff rather than a new binary.
// The page box is set in the stylesheet, so nothing here decides the size: `preferCSSPageSize`
// hands that to `@page` and the slides come out at the dimensions the deck asks for.
//
// Usage: node scripts/deck-pdf.mjs [in] [out]
import { chromium } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const IN = resolve(process.argv[2] ?? "docs/deck.html");
const OUT = resolve(process.argv[3] ?? "docs/deck.pdf");

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(IN).href, { waitUntil: "networkidle" });
await page.pdf({ path: OUT, preferCSSPageSize: true, printBackground: true });
await browser.close();
console.warn(OUT);
