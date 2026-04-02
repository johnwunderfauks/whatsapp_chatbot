const fs = require("fs");
const path = require("path");
const vision = require("@google-cloud/vision");

let cachedClient = null;

function resolveCredentialsPath() {
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!p) {
    throw new Error(
      "Missing GOOGLE_APPLICATION_CREDENTIALS. Set it to the absolute path of your Google service account JSON file."
    );
  }

  const resolved = path.resolve(p);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(
      `Google Vision credentials file not found: ${resolved}`
    );
  }

  return resolved;
}

function getVisionClient() {
  if (cachedClient) return cachedClient;

  const keyFilename = resolveCredentialsPath();

  cachedClient = new vision.ImageAnnotatorClient({
    keyFilename,
  });

  return cachedClient;
}

const MOCK_OCR_TEXT = `
FAIRPRICE FINEST
Lot 1 Tampines Mall, 10 Tampines Central 1, Singapore 529536
Tel: 6786 1234  GST Reg No: 197902560R

Receipt No: FP-2024-98234
Date: 25/03/2024   Time: 14:23

Qty  Description              Price
  2  Chicken Breast 500g      7.90
  1  Brown Rice 5kg           9.50
  3  Greek Yogurt 150g        5.85
  1  Olive Oil 750ml         12.50
  1  Mixed Salad Bag          3.20
--------------------------------------
Subtotal                     39.00 S
GST 9%                        3.51 S
======================================
TOTAL                        42.51 S
======================================
Cash                         50.00
Change                        7.49

Thank you for shopping at FairPrice!
`.trim();

async function extractReceiptText(imageBuffer) {
  if (process.env.MOCK_EXTERNAL_APIS === "true") {
    return MOCK_OCR_TEXT;
  }
  const client = getVisionClient();
  const [result] = await client.textDetection(imageBuffer);
  return result?.fullTextAnnotation?.text || "";
}

module.exports = {
  getVisionClient,
  extractReceiptText,
};