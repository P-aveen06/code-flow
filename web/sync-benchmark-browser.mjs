/** Drive headless system Chrome and return one navigation timing per input line. */
import { basename } from "node:path";
import { createInterface } from "node:readline";
import puppeteer from "puppeteer-core";

const browserPath = process.env.CODEFLOW_CHROME_PATH
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const headlessShell = basename(browserPath) === "chrome-headless-shell";
const singleProcess = headlessShell && process.platform === "darwin";
let browser;
let stage = "launch";
try {
  const args = ["--no-sandbox", "--disable-breakpad", "--disable-crash-reporter",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"];
  if (singleProcess) args.push("--single-process");

  browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: headlessShell ? "shell" : true,
    pipe: true,
    userDataDir: process.argv[2],
    args,
  });
  // On macOS, single-process headless shell supports only its default context.
  let sharedPage;
  let session;
  if (singleProcess) {
    [sharedPage] = await browser.pages();
    await sharedPage.setCacheEnabled(false);
    session = await sharedPage.createCDPSession();
  }
  console.log(JSON.stringify({
    browser: await browser.version(),
    mode: singleProcess ? "single-process headless shell with storage reset" : "fresh browser contexts",
  }));
  stage = "navigation";
  for await (const line of createInterface({ input: process.stdin })) {
    const { url, variant, repos } = JSON.parse(line);
    const context = singleProcess ? null : await browser.createBrowserContext();
    try {
      const page = sharedPage ?? await context.newPage();
      if (session) {
        await session.send("Storage.clearDataForOrigin", {
          origin: new URL(url).origin,
          storageTypes: "all",
        });
      }
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      const ready = await page.waitForFunction((mode, count) => {
        const section = document.querySelector(".repositories");
        if (section?.querySelector(".variant-preview__status code")?.textContent !== `sync=${mode}`
            || section.querySelectorAll(".repo-list > li").length !== count) return null;
        const switches = Array.from(section.querySelectorAll('[role="switch"]'));
        const expected = { manual_button: 0, per_repo_toggle: count, global_toggle: 1 }[mode];
        if (switches.length !== expected || switches.some(el => el.getAttribute("aria-disabled") === "true")) {
          return null;
        }
        return { ms: performance.now(), navigation: performance.timeOrigin };
      }, { timeout: 10000 }, variant, repos);
      console.log(JSON.stringify(await ready.jsonValue()));
      if (sharedPage) await sharedPage.goto("about:blank");
    } finally {
      await context?.close();
    }
  }
} catch {
  const error = stage === "launch"
    ? "Chrome could not launch. Check CODEFLOW_CHROME_PATH and the host's headless Chrome permissions."
    : "Chrome did not render the expected repository list and sync controls.";
  console.log(JSON.stringify({ error }));
  process.exitCode = 1;
} finally {
  await browser?.close();
}
