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

async function extractReceiptText(imageBuffer) {
  const client = getVisionClient();
  const [result] = await client.textDetection(imageBuffer);
  return result?.fullTextAnnotation?.text || "";
}

module.exports = {
  getVisionClient,
  extractReceiptText,
};