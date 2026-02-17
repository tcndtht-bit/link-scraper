/**
 * Link Scraper — headless browser для парсинга страниц товаров.
 * Используется как fallback, когда Cloudflare Worker не может загрузить страницу.
 * API: GET /?url=https://...
 */
const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEOUT = 25000;

function extractMeta(html, name) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re1 = new RegExp(
    `<meta[^>]+(?:property|name)=["']${esc(name)}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const m1 = html.match(re1);
  if (m1) return m1[1];
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${esc(name)}["']`,
    "i"
  );
  const m2 = html.match(re2);
  return m2 ? m2[1] : null;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : null;
}

function extractPriceFromHtml(html) {
  const patterns = [
    /"price"\s*:\s*["']?(\d+(?:[.,]\d+)?)["']?/i,
    /"price"\s*:\s*(\d+(?:[.,]\d+)?)/,
    /"currentPrice"\s*:\s*["']?(\d+(?:[.,]\d+)?)["']?/i,
    /data-price=["'](\d+(?:[.,]\d+)?)["']/i,
    /itemprop="price"\s+content=["'](\d+(?:[.,]\d+)?)["']/i,
    /__NEXT_DATA__[\s\S]*?"price"\s*:\s*["']?(\d+(?:[.,]\d+)?)["']?/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return parseFloat(String(m[1]).replace(",", "."));
  }
  return null;
}

function extractCurrencyFromHtml(html) {
  const m1 = html.match(/"priceCurrency"\s*:\s*["']([A-Z]{3})["']/i);
  if (m1) {
    const c = m1[1];
    if (/BYN|Br/i.test(c)) return "Br";
    if (/RUB/i.test(c)) return "₽";
    if (/USD/i.test(c)) return "$";
    if (/EUR/i.test(c)) return "€";
    if (/KZT/i.test(c)) return "₸";
    return c;
  }
  const m2 = html.match(/\b(BYN|Br|₽|руб\.?|RUB|USD|\$|EUR|€)\b/i);
  if (m2) {
    const c = m2[1];
    if (/BYN|Br/i.test(c)) return "Br";
    if (/RUB|₽|руб/i.test(c)) return "₽";
    if (/USD|\$/i.test(c)) return "$";
    if (/EUR|€/i.test(c)) return "€";
  }
  return null;
}

function findProductInJsonLd(obj) {
  if (!obj) return null;
  if (obj["@type"] === "Product" || String(obj["@type"] || "").includes("Product"))
    return obj;
  if (Array.isArray(obj)) return obj.find((x) => findProductInJsonLd(x));
  if (obj["@graph"]) return findProductInJsonLd(obj["@graph"]);
  return null;
}

function extractJsonLd(html) {
  const scripts = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const m of scripts) {
    try {
      const parsed = JSON.parse(m[1]);
      const product = findProductInJsonLd(parsed);
      if (product) return product;
    } catch {}
  }
  return null;
}

function parse(html, targetUrl) {
  const title = extractTitle(html);
  const ogTitle = extractMeta(html, "og:title");
  const ogImage = extractMeta(html, "og:image");
  const ogDesc = extractMeta(html, "og:description");
  const ogPrice = extractMeta(html, "og:price:amount");
  const ogCurrency = extractMeta(html, "og:price:currency");
  const jsonLd = extractJsonLd(html);

  let name = ogTitle || (jsonLd && jsonLd.name) || title || "N/A";
  let price = ogPrice ? parseFloat(ogPrice) : null;
  if (price == null && jsonLd && jsonLd.offers) {
    const off = Array.isArray(jsonLd.offers) ? jsonLd.offers[0] : jsonLd.offers;
    price = off ? (typeof off.price === "number" ? off.price : parseFloat(off.price)) : null;
  }
  if (price == null) price = extractPriceFromHtml(html);

  let currency = ogCurrency || null;
  if (!currency && jsonLd && jsonLd.offers) {
    const off = Array.isArray(jsonLd.offers) ? jsonLd.offers[0] : jsonLd.offers;
    currency = off && (off.priceCurrency || off.currency);
  }
  if (!currency) currency = extractCurrencyFromHtml(html);

  let size =
    (jsonLd && jsonLd.size) ||
    (jsonLd &&
      jsonLd.additionalProperty &&
      jsonLd.additionalProperty.find((p) => p.name === "Размер" || p.name === "Size")?.value) ||
    null;

  const imageUrl =
    ogImage ||
    (jsonLd && (Array.isArray(jsonLd.image) ? jsonLd.image[0] : jsonLd.image)) ||
    null;

  return {
    name: typeof name === "string" ? name : "N/A",
    price: typeof price === "number" && !isNaN(price) ? price : null,
    currency: typeof currency === "string" ? currency : null,
    size: typeof size === "string" ? size : null,
    link: targetUrl,
    image: imageUrl,
  };
}

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== "string") {
    return res.status(400).json({ error: "Missing url query parameter" });
  }
  if (!targetUrl.startsWith("https://")) {
    return res.status(400).json({ error: "Only https URLs allowed" });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.goto(targetUrl, {
      waitUntil: "networkidle2",
      timeout: TIMEOUT,
    });
    const html = await page.content();
    const result = parse(html, targetUrl);

    if (result.image) {
      try {
        const imgUrl = result.image.startsWith("http")
          ? result.image
          : new URL(result.image, targetUrl).href;
        const imgResp = await page.goto(imgUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
        if (imgResp && imgResp.ok()) {
          const buf = await imgResp.buffer();
          const ct = imgResp.headers()["content-type"] || "image/jpeg";
          if (/^image\/(jpeg|png|webp|gif)/i.test(ct)) {
            result.imageBase64 = `data:${ct};base64,${buf.toString("base64")}`;
          }
        }
      } catch (e) {
        console.warn("Image fetch failed:", e.message);
      }
    }
    result.imageBase64 = result.imageBase64 || null;
    res.json(result);
  } catch (e) {
    console.error("Scraper error:", e);
    res.status(502).json({
      name: "N/A",
      price: null,
      currency: null,
      size: null,
      link: targetUrl,
      image: null,
      imageBase64: null,
      _fallback: true,
      _error: e.message || String(e),
    });
  } finally {
    if (browser) await browser.close();
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Link Scraper running on port ${PORT}`);
});
