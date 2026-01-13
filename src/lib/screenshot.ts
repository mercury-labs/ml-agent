import { mkdirSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

export type ScreenshotCaptureOptions = {
  url: string;
  outputPath: string;
  fullPage?: boolean;
  selector?: string;
  waitFor?: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  waitMs?: number;
  timeoutMs?: number;
  width: number;
  height: number;
};

export type ScreenshotResult = {
  path: string;
  bytes: number;
  url: string;
  width: number;
  height: number;
  fullPage: boolean;
  selector?: string;
};

export async function captureScreenshot(options: ScreenshotCaptureOptions): Promise<ScreenshotResult> {
  const targetUrl = normalizeTargetUrl(options.url);
  const fullPage = Boolean(options.fullPage);
  const timeoutMs = options.timeoutMs ?? 30_000;

  ensureDirectory(options.outputPath);

  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: options.width, height: options.height }
  });

  try {
    await page.goto(targetUrl, { waitUntil: options.waitUntil ?? "load", timeout: timeoutMs });

    if (options.waitFor) {
      await page.waitForSelector(options.waitFor, { timeout: timeoutMs });
    }

    if (options.waitMs && options.waitMs > 0) {
      await page.waitForTimeout(options.waitMs);
    }

    if (options.selector) {
      const locator = page.locator(options.selector).first();
      await locator.waitFor({ state: "visible", timeout: timeoutMs });
      await locator.screenshot({ path: options.outputPath });
    } else {
      await page.screenshot({ path: options.outputPath, fullPage });
    }
  } finally {
    await browser.close();
  }

  const stats = await fs.stat(options.outputPath);

  return {
    path: options.outputPath,
    bytes: stats.size,
    url: targetUrl,
    width: options.width,
    height: options.height,
    fullPage,
    selector: options.selector
  };
}

export function createTempScreenshotPath(): string {
  const name = `slack-lists-screenshot-${Date.now()}.png`;
  return path.join(os.tmpdir(), name);
}

export function ensurePngPath(filePath: string): string {
  if (path.extname(filePath)) {
    return filePath;
  }
  return `${filePath}.png`;
}

function ensureDirectory(filePath: string): void {
  const dir = path.dirname(filePath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
}

function normalizeTargetUrl(input: string): string {
  if (/^[a-zA-Z]+:\/\//.test(input)) {
    return input;
  }

  if (input.startsWith("~")) {
    const resolved = path.join(os.homedir(), input.slice(1));
    return pathToFileURL(path.resolve(resolved)).toString();
  }

  if (input.startsWith("/") || input.startsWith(".")) {
    return pathToFileURL(path.resolve(input)).toString();
  }

  return `https://${input}`;
}

async function loadPlaywright(): Promise<typeof import("playwright")> {
  try {
    return await import("playwright");
  } catch (error) {
    const message =
      "Playwright is required for screenshots. Install it with `npm install playwright` and run `npx playwright install chromium`.";
    const wrapped = new Error(message);
    (wrapped as { cause?: unknown }).cause = error;
    throw wrapped;
  }
}
