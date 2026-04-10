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

  // Remove query for better duplicate matching
  cleaned = cleaned.split("?")[0];

  // Normalize image sizes to higher size for duplicate control
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

  // reject non-product/common bad images
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

  // reject tiny image sizes
  if (u.includes("/60/60/")) return false;
  if (u.includes("/100/100/")) return false;
  if (u.includes("/128/128/")) return false;

  return true;
}

function scoreImage(url) {
  const u = url.toLowerCase();
  let score = 0;

  if (u.includes("/2000/2000/")) score += 300;
  if (u.includes("/1000/1000/")) score += 220;
  if (u.includes("/832/832/")) score += 180;
  if (u.includes("/612/612/")) score += 120;
  if (u.includes("/416/416/")) score += 80;
  if (u.includes("/312/312/")) score += 40;
  if (u.includes("/256/256/")) score += 20;

  if (u.includes("/128/128/")) score -= 100;
  if (u.includes("/100/100/")) score -= 150;
  if (u.includes("/60/60/")) score -= 200;

  if (u.includes("image")) score += 10;
  if (u.includes("product")) score += 10;
  if (u.includes("gallery")) score += 10;

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

    const imageUrls = await page.evaluate(() => {
      const urls = new Set();

      document.querySelectorAll("img").forEach((img) => {
        if (img.src) urls.add(img.src);

        const srcset = img.getAttribute("srcset");
        if (srcset) {
          srcset.split(",").forEach((part) => {
            const u = part.trim().split(" ")[0];
            if (u) urls.add(u);
          });
        }
      });

      const htmlText = document.documentElement.outerHTML;
      const rawMatches =
        htmlText.match(/https?:\/\/(?:rukmini|rukminim)\d*\.flixcart\.com\/[^"' <>\s)]+/gi) || [];
      rawMatches.forEach((u) => urls.add(u));

      return Array.from(urls);
    });

    const metaCandidates = [
      getMetaContent(html, "og:image", "property"),
      getMetaContent(html, "twitter:image", "name")
    ].filter(Boolean);

    const allCandidates = [...new Set([...imageUrls, ...metaCandidates])]
      .map(cleanUrl)
      .filter(Boolean);

    const cleaned = [...new Set(allCandidates)]
      .filter(isValidProductImage)
      .sort((a, b) => scoreImage(b) - scoreImage(a));

    const finalImages = [];
    const seenKeys = new Set();

    for (const img of cleaned) {
      const parts = img.split("/");
      const fileName = (parts[parts.length - 1] || "").toLowerCase();
      const key = fileName.replace(/\.(jpg|jpeg|png|webp)$/i, "");

      if (!key) continue;
      if (seenKeys.has(key)) continue;

      seenKeys.add(key);
      finalImages.push(img);
    }

    const filteredMainImages = finalImages.slice(0, 3);

    if (!filteredMainImages.length) {
      throw new Error("No valid product images found");
    }

    return {
      title,
      finalUrl,
      images: filteredMainImages
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