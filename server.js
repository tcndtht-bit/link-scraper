/**
 * Link Scraper — headless browser для парсинга страниц товаров + анализ текста желаний.
 * API: GET /?url=... — парсинг страницы
 * POST /store-wish-text — сохранить текст желания, вернуть id
 * GET /wish-text?id=&analyze=1 — получить текст и/или анализ через LLM
 */
const express = require("express");
const puppeteer = require("puppeteer");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const TIMEOUT = 25000;
const WISH_TEXT_TTL = 10 * 60 * 1000; // 10 min

const wishTextStore = new Map();

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

const WISH_TEXT_PROMPT = `Текст начинается со слова «хочу». Извлеки данные. Верни ТОЛЬКО JSON:
{"name":"строка","price":число или null,"currency":"строка или null","size":"строка или null"}

Правила:
1. name — ТОЛЬКО название товара/желания (что хочет). БЕЗ слова «хочу». БЕЗ цены, размеров, валют. Примеры: «наушники AirPods Pro», «кроссовки Nike», «книга Сто лет одиночества». НЕ бери числа, цены, размеры в name.
2. price — ТОЛЬКО если явно указана сумма за товар (число рядом с руб, ₽, Br, BYN, $, USD, €, EUR, долларов, рублей). НЕ бери: год (2024), количество (2 штуки), размер (42). Иначе null.
3. currency — валюта из цены. Нормализуй: руб/RUB/₽ → ₽, BYN/Br/бун → Br, USD/$/долл → $, EUR/€/евр → €. Иначе null.
4. size — ТОЛЬКО размер одежды/обуви (42, XL, EU 43, US 10). Иначе null.`;

const VISION_PROMPT = `Проанализируй изображение и извлеки информацию о товаре. Верни ТОЛЬКО валидный JSON без пояснений:
{"name":"строка или N/A","price":число или null,"currency":"строка или null","size":"строка или null"}
1. name — название товара (существительное/фраза). Иначе "N/A".
2. price и currency — связка число + валюта (BYN, Br, ₽, $, €, руб, долл). Иначе null.
3. size — только для одежды/обуви (EU 25-50, XXS-XL). Иначе null.`;

// Fallback: regex-парсинг без LLM
function analyzeWishTextFallback(text) {
  let s = text.replace(/^хочу\s+/i, "").trim() || "Желание";
  let price = null;
  let currency = null;
  let size = null;
  const priceRe = /(\d[\d\s.]*)\s*(руб\.?|₽|Br|BYN|\$|USD|€|EUR|долларов?|рублей|бун\.?)/i;
  const m = s.match(priceRe);
  if (m) {
    const num = parseFloat(m[1].replace(/\s/g, "").replace(",", "."));
    if (!isNaN(num) && num < 1e9) {
      price = num;
      const c = m[2].toLowerCase();
      if (c.includes("руб") || c === "₽") currency = "₽";
      else if (c.includes("byn") || c.includes("бун")) currency = "Br";
      else if (c.includes("долл") || c === "$") currency = "$";
      else if (c.includes("eur") || c.includes("евр")) currency = "€";
      s = s.replace(priceRe, "").replace(/\s+/g, " ").trim();
    }
  }
  const sizeRe = /\b(XS|S|M|L|XL|XXL|EU\s*\d+|US\s*\d+|\d{2})\b/i;
  const sm = s.match(sizeRe);
  if (sm) {
    const sz = sm[1];
    if (/^\d{2}$/.test(sz) && parseInt(sz, 10) >= 35 && parseInt(sz, 10) <= 52) size = sz;
    else if (/^(XS|S|M|L|XL|XXL)$/i.test(sz) || /^(EU|US)\s*\d+/i.test(sz)) size = sz;
  }
  return { name: s || "Желание", price, currency, size };
}

async function analyzeWishText(text) {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY;
  if (!apiKey) return analyzeWishTextFallback(text);
  const isGroq = !!process.env.GROQ_API_KEY;
  const url = isGroq ? "https://api.groq.com/openai/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
  const model = isGroq ? "meta-llama/llama-4-scout-17b-16e-instruct" : "google/gemma-3-27b-it:free";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: WISH_TEXT_PROMPT + "\n\n" + text }],
      max_tokens: 300,
    }),
  });
  if (!res.ok) return analyzeWishTextFallback(text);
  const data = await res.json();
  const t = data.choices?.[0]?.message?.content;
  if (!t) return analyzeWishTextFallback(text);
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return analyzeWishTextFallback(text);
  try {
    const parsed = JSON.parse(m[0]);
    const cur = parsed.currency;
    const curMap = { BYN: "Br", Br: "Br", RUB: "₽", руб: "₽", USD: "$", EUR: "€", KZT: "₸" };
    return {
      name: parsed.name && String(parsed.name).trim() ? parsed.name : analyzeWishTextFallback(text).name,
      price: typeof parsed.price === "number" && !isNaN(parsed.price) ? parsed.price : null,
      currency: curMap[cur] || (typeof cur === "string" ? cur : null) || null,
      size: typeof parsed.size === "string" ? parsed.size : null,
    };
  } catch {
    return analyzeWishTextFallback(text);
  }
}

async function analyzeImage(imageBase64) {
  const apiKey =
    process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) return { name: "N/A", price: null, currency: null, size: null };

  // Groq
  if (process.env.GROQ_API_KEY) {
    try {
      const dataUrl = imageBase64.startsWith("data:")
        ? imageBase64
        : `data:image/jpeg;base64,${imageBase64}`;
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: VISION_PROMPT },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: 500,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const t = data.choices?.[0]?.message?.content;
        if (t) {
          const m = t.match(/\{[\s\S]*\}/);
          if (m) {
            const p = JSON.parse(m[0]);
            return {
              name: p.name && String(p.name).trim() ? p.name : "N/A",
              price: typeof p.price === "number" && !isNaN(p.price) ? p.price : null,
              currency: typeof p.currency === "string" ? p.currency : null,
              size: typeof p.size === "string" ? p.size : null,
            };
          }
        }
      }
    } catch (e) {
      console.warn("Groq vision error:", e.message);
    }
  }

  // OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const dataUrl = imageBase64.startsWith("data:")
        ? imageBase64
        : `data:image/jpeg;base64,${imageBase64}`;
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: "google/gemma-3-27b-it:free",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: VISION_PROMPT },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: 500,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const t = data.choices?.[0]?.message?.content;
        if (t) {
          const m = t.match(/\{[\s\S]*\}/);
          if (m) {
            const p = JSON.parse(m[0]);
            return {
              name: p.name && String(p.name).trim() ? p.name : "N/A",
              price: typeof p.price === "number" && !isNaN(p.price) ? p.price : null,
              currency: typeof p.currency === "string" ? p.currency : null,
              size: typeof p.size === "string" ? p.size : null,
            };
          }
        }
      }
    } catch (e) {
      console.warn("OpenRouter vision error:", e.message);
    }
  }

  // Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      const b64 = imageBase64.replace(/^data:[^;]+;base64,/, "");
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: VISION_PROMPT },
                  { inlineData: { mimeType: "image/jpeg", data: b64 } },
                ],
              },
            ],
          }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const t = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (t) {
          const m = t.match(/\{[\s\S]*\}/);
          if (m) {
            const p = JSON.parse(m[0]);
            return {
              name: p.name && String(p.name).trim() ? p.name : "N/A",
              price: typeof p.price === "number" && !isNaN(p.price) ? p.price : null,
              currency: typeof p.currency === "string" ? p.currency : null,
              size: typeof p.size === "string" ? p.size : null,
            };
          }
        }
      }
    } catch (e) {
      console.warn("Gemini vision error:", e.message);
    }
  }

  return { name: "N/A", price: null, currency: null, size: null };
}

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
    /"salePrice"\s*:\s*["']?(\d+(?:[.,]\d+)?)["']?/i,
    /"basePrice"\s*:\s*["']?(\d+(?:[.,]\d+)?)["']?/i,
    /"productPrice"\s*:\s*["']?(\d+(?:[.,]\d+)?)["']?/i,
    /data-price=["'](\d+(?:[.,]\d+)?)["']/i,
    /itemprop="price"\s+content=["'](\d+(?:[.,]\d+)?)["']/i,
    /__NEXT_DATA__[\s\S]*?"price"\s*:\s*["']?(\d+(?:[.,]\d+)?)["']?/i,
    /(?:__NUXT__|__INITIAL_STATE__|"product")\s*[:\}][\s\S]*?"price"\s*:\s*["']?(\d+(?:[.,]\d+)?)["']?/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const n = parseFloat(String(m[1]).replace(",", "."));
      if (!isNaN(n) && n > 0 && n < 1e9) return n;
    }
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

function extractFromJsonBlobs(html, baseUrl) {
  const out = { name: null, price: null, currency: null, image: null };
  const scriptBlocks = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  if (scriptBlocks) {
    for (const block of scriptBlocks) {
      const inner = block.replace(/<\/?script[^>]*>/gi, "");
      const nameM = inner.match(/"productName"\s*:\s*"((?:[^"\\]|\\.){5,200})"/);
      if (nameM && !out.name) out.name = nameM[1].replace(/\\"/g, '"').trim();
      if (!out.name) {
        const nameM2 = inner.match(/"name"\s*:\s*"((?:[^"\\]|\\.){5,200})"/);
        if (nameM2 && !/^(true|false|null|undefined|N\/A)$/i.test(nameM2[1])) out.name = nameM2[1].replace(/\\"/g, '"').trim();
      }
      const priceM = inner.match(/"price"\s*:\s*(\d+(?:\.\d+)?)/);
      if (priceM && !out.price) {
        const n = parseFloat(priceM[1]);
        if (n > 0 && n < 1e9) out.price = n;
      }
      const imgM = inner.match(/"image"\s*:\s*"((https?:\/\/[^"]+|\\/\\/[^"]+|\/[^"]+))"/);
      if (imgM && !out.image) {
        const url = imgM[1];
        out.image = url.startsWith("http") ? url : (url.startsWith("//") ? "https:" + url : new URL(url, baseUrl).href);
      }
      if (!out.image) {
        const imgM2 = inner.match(/"mainImage"\s*:\s*"((?:https?:\/\/[^"]+|\\/\\/[^"]+|\/[^"]+))"/);
        if (imgM2) {
          const u = imgM2[1];
          out.image = u.startsWith("http") ? u : (u.startsWith("//") ? "https:" + u : new URL(u, baseUrl).href);
        }
      }
    }
  }
  if (!out.currency && html.includes("BYN")) out.currency = "Br";
  if (!out.currency && html.includes("goldapple")) out.currency = "Br";
  return out;
}

function parse(html, targetUrl) {
  const title = extractTitle(html);
  const ogTitle = extractMeta(html, "og:title");
  const ogImage = extractMeta(html, "og:image");
  const ogPrice = extractMeta(html, "og:price:amount");
  const ogCurrency = extractMeta(html, "og:price:currency");
  const jsonLd = extractJsonLd(html);
  const blob = extractFromJsonBlobs(html, targetUrl);

  let name = ogTitle || (jsonLd && jsonLd.name) || blob.name || title || "N/A";
  let price = ogPrice ? parseFloat(ogPrice) : null;
  if (price == null && jsonLd && jsonLd.offers) {
    const off = Array.isArray(jsonLd.offers) ? jsonLd.offers[0] : jsonLd.offers;
    price = off ? (typeof off.price === "number" ? off.price : parseFloat(off.price)) : null;
  }
  if (price == null) price = blob.price;
  if (price == null) price = extractPriceFromHtml(html);

  let currency = ogCurrency || null;
  if (!currency && jsonLd && jsonLd.offers) {
    const off = Array.isArray(jsonLd.offers) ? jsonLd.offers[0] : jsonLd.offers;
    currency = off && (off.priceCurrency || off.currency);
  }
  if (!currency) currency = blob.currency;
  if (!currency) currency = extractCurrencyFromHtml(html);

  let size =
    (jsonLd && jsonLd.size) ||
    (jsonLd &&
      jsonLd.additionalProperty &&
      jsonLd.additionalProperty.find((p) => p.name === "Размер" || p.name === "Size")?.value) ||
    null;

  let imageUrl =
    ogImage ||
    (jsonLd && (Array.isArray(jsonLd.image) ? jsonLd.image[0] : jsonLd.image)) ||
    blob.image ||
    null;
  if (imageUrl && !imageUrl.startsWith("http")) imageUrl = new URL(imageUrl, targetUrl).href;

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
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.post("/store-wish-text", (req, res) => {
  const text = req.body?.text;
  if (!text || typeof text !== "string" || text.length > 2000) {
    return res.status(400).json({ error: "Invalid text" });
  }
  const id = randomId();
  wishTextStore.set(id, { text, expires: Date.now() + WISH_TEXT_TTL });
  setTimeout(() => wishTextStore.delete(id), WISH_TEXT_TTL);
  res.json({ id });
});

app.get("/wish-text", async (req, res) => {
  const id = req.query.id;
  const analyze = req.query.analyze === "1";
  const entry = wishTextStore.get(id);
  if (!entry) return res.status(404).json({ error: "Not found or expired" });
  if (!analyze) return res.json({ text: entry.text });
  const extracted = await analyzeWishText(entry.text);
  res.json({ text: entry.text, ...extracted });
});

const BUCKET = "wish-images";
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

app.post("/analyze-image", async (req, res) => {
  const body = req.body || {};
  let imageBase64 = body.image || body.base64;
  if (body.imageUrl && typeof body.imageUrl === "string") {
    try {
      const r = await fetch(body.imageUrl);
      if (!r.ok) throw new Error("Fetch failed");
      const buf = await r.arrayBuffer();
      imageBase64 = Buffer.from(buf).toString("base64");
    } catch (e) {
      return res.status(400).json({ name: "N/A", price: null, currency: null, size: null, error: e.message });
    }
  }
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return res.status(400).json({ name: "N/A", price: null, currency: null, size: null, error: "Missing image" });
  }
  try {
    const extracted = await analyzeImage(imageBase64);
    let imageUrl = null;
    if (supabase) {
      try {
        const rawB64 = imageBase64.replace(/^data:[^;]+;base64,/, "");
        const buf = Buffer.from(rawB64, "base64");
        const path = `${randomId()}_${Date.now()}.jpg`;
        const { data: uploadData, error } = await supabase.storage.from(BUCKET).upload(path, buf, {
          contentType: "image/jpeg",
          upsert: false,
        });
        if (!error && uploadData) {
          const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path);
          imageUrl = urlData?.publicUrl || null;
        }
      } catch (e) {
        console.warn("Supabase upload failed:", e.message);
      }
    }
    res.json({ ...extracted, image: imageUrl });
  } catch (e) {
    console.error("analyze-image error:", e);
    res.status(502).json({ name: "N/A", price: null, currency: null, size: null });
  }
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
    await new Promise((r) => setTimeout(r, 1500));
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
