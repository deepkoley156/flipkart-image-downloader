const express = require("express");
const path = require("path");
const axios = require("axios");
const archiver = require("archiver");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function cleanUrl(url) {
  if (!url) return "";

  let cleaned = url.replace(/&amp;/g, "&").trim();
  cleaned = cleaned.split("?")[0];

  cleaned = cleaned.replace(
    /\/(60|100|128|256|312|416|612|832|1000|2000)\/(60|100|128|256|312|416|612|832|1000|2000)\//g,
    "/832/832/"
  );

  return cleaned;
}

function isValidProductImage(url) {
  if (!url) return false;
  const u = url.toLowerCase();

  if (!u.includes("flixcart.com")) return false;
  if (!/\.(jpg|jpeg|png|webp)$/i.test(u)) return false;

  if (u.includes("logo")) return false;
  if (u.includes("captcha")) return false;
  if (u.includes("recaptcha")) return false;
  if (u.includes("fk-og-image")) return false;
  if (u.includes("promos")) return false;
  if (u.includes("icon")) return false;
  if (u.includes("brand")) return false;
  if (u.includes("rewards")) return false;
  if (u.includes("wishlist")) return false;
  if (u.includes("compare")) return false;
  if (u.includes("banner")) return false;
  if (u.includes("offer")) return false;
  if (u.includes("ads")) return false;
  if (u.includes("review")) return false;
  if (u.includes("rating")) return false;
  if (u.includes("seller")) return false;
  if (u.includes("store")) return false;

  if (u.includes("/60/60/")) return false;
  if (u.includes("/100/100/")) return false;
  if (u.includes("/128/128/")) return false;

  return true;
}

function scoreImage(url) {
  const u = url.toLowerCase();
  let score = 0;

  if (u.includes("/2000/2000/")) score += 300;
  if (u.includes("/1000/1000/")) score += 240;
  if (u.includes("/832/832/")) score += 180;
  if (u.includes("/612/612/")) score += 120;
  if (u.includes("/416/416/")) score += 80;
  if (u.includes("/312/312/")) score += 40;

  if (u.includes("gallery")) score += 25;
  if (u.includes("product")) score += 20;
  if (u.includes("image")) score += 10;

  return score;
}

function getMetaContent(html, key, attr = "property") {
  const regex = new RegExp(
    `<meta[^>]+${attr}=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const match = html.match(regex);
  return match ? cleanUrl(match[1]) : "";
}

function dedupeImages(images) {
  const out = [];
  const seen = new Set();

  for (const img of images) {
    const fileName = (img.split("/").pop() || "").toLowerCase();
    const key = fileName.replace(/\.(jpg|jpeg|png|webp)$/i, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(img);
  }

  return out;
}

async function extractFlipkartData(url) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
    locale: "en-US"
  });

  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    const finalUrl = page.url();
    const title = await page.title();
    const html = await page.content();

    const lowerHtml = html.toLowerCase();
    const lowerTitle = (title || "").toLowerCase();

    if (
      lowerHtml.includes("captcha") ||
      lowerHtml.includes("recaptcha") ||
      lowerHtml.includes("security check") ||
      lowerHtml.includes("enter the characters") ||
      lowerTitle.includes("captcha") ||
      lowerTitle.includes("recaptcha")
    ) {
      throw new Error("Flipkart blocked this request with CAPTCHA");
    }

    const extracted = await page.evaluate(() => {
      const normalize = (u) => (u || "").replace(/&amp;/g, "&").trim();
      const mainSet = new Set();
      const thumbSet = new Set();

      const addImg = (img, set) => {
        if (!img) return;

        if (img.src) set.add(normalize(img.src));

        const srcset = img.getAttribute("srcset");
        if (srcset) {
          srcset.split(",").forEach((part) => {
            const u = part.trim().split(" ")[0];
            if (u) set.add(normalize(u));
          });
        }
      };

      // Try to find only the primary product media/gallery area
      const mainGallerySelectors = [
        'div[class*="_2E1FGS"] img',
        'div[class*="_3kidJX"] img',
        'div[class*="_1BweB8"] img',
        'div[class*="_2r_T1I"] img',
        'img[class*="_396cs4"]',
        'img[class*="_2r_T1I"]'
      ];

      mainGallerySelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((img) => addImg(img, mainSet));
      });

      // Limit thumbnail collection to likely gallery side only
      const thumbContainers = [
        'ul img',
        'li img',
        'div[class*="_1AuMiq"] img',
        'div[class*="CXW8mj"] img'
      ];

      thumbContainers.forEach((selector) => {
        document.querySelectorAll(selector).forEach((img) => {
          const rect = img.getBoundingClientRect();
          if (rect.width >= 35 && rect.height >= 35 && rect.width <= 250 && rect.height <= 250) {
            addImg(img, thumbSet);
          }
        });
      });

      return {
        main: Array.from(mainSet),
        thumbs: Array.from(thumbSet)
      };
    });

    const metaCandidates = [
      getMetaContent(html, "og:image", "property"),
      getMetaContent(html, "twitter:image", "name")
    ].filter(Boolean);

    let mainImages = extracted.main
      .map(cleanUrl)
      .filter(Boolean)
      .filter(isValidProductImage)
      .sort((a, b) => scoreImage(b) - scoreImage(a));

    mainImages = dedupeImages(mainImages);

    let thumbImages = extracted.thumbs
      .map(cleanUrl)
      .filter(Boolean)
      .filter(isValidProductImage)
      .sort((a, b) => scoreImage(b) - scoreImage(a));

    thumbImages = dedupeImages(thumbImages);

    let metaImages = metaCandidates
      .map(cleanUrl)
      .filter(Boolean)
      .filter(isValidProductImage)
      .sort((a, b) => scoreImage(b) - scoreImage(a));

    metaImages = dedupeImages(metaImages);

    // STRICT PRIORITY:
    // 1. main gallery images only
    // 2. thumbnail gallery images only if needed
    // 3. meta image only if still needed
    let finalImages = dedupeImages(mainImages);

    if (finalImages.length < 2) {
      finalImages = dedupeImages([...finalImages, ...thumbImages]);
    }

    if (finalImages.length < 1) {
      finalImages = dedupeImages([...finalImages, ...metaImages]);
    }

    // Keep very strict limit to avoid related products
    finalImages = finalImages.slice(0, 4);

    if (!finalImages.length) {
      throw new Error("No valid product images found");
    }

    return {
      title,
      finalUrl,
      images: finalImages
    };
  } finally {
    await browser.close();
  }
}

app.post("/api/extract", async (req, res) => {
  try {
    const url = (req.body.url || "").trim();

    if (!url) {
      return res.status(400).json({ error: "Product URL missing" });
    }

    if (!/flipkart\.com/i.test(url)) {
      return res.status(400).json({ error: "Only Flipkart URLs are allowed" });
    }

    const data = await extractFlipkartData(url);
    res.json(data);
  } catch (err) {
    console.error("EXTRACT ERROR:", err);
    res.status(500).json({
      error: err.message || "Extraction failed"
    });
  }
});

app.post("/api/download-zip", async (req, res) => {
  try {
    const images = Array.isArray(req.body.images) ? req.body.images : [];
    const title = (req.body.title || "flipkart-images").replace(/[^\w\-]+/g, "_");

    if (!images.length) {
      return res.status(400).json({ error: "No images to zip" });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${title}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);

    for (let i = 0; i < images.length; i++) {
      const imageUrl = images[i];
      try {
        const response = await axios.get(imageUrl, {
          responseType: "arraybuffer",
          timeout: 30000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
          }
        });

        const extMatch = imageUrl.match(/\.(jpg|jpeg|png|webp)$/i);
        const ext = extMatch ? extMatch[1].toLowerCase() : "jpg";

        archive.append(Buffer.from(response.data), {
          name: `image-${i + 1}.${ext}`
        });
      } catch (e) {
        console.log("Skipping image:", imageUrl);
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error("ZIP ERROR:", err);
    res.status(500).json({
      error: err.message || "ZIP creation failed"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});