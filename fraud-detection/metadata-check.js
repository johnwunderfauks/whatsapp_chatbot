const sharp = require('sharp');
const exifReader = require('exif-reader');

/**
 * Analyze image metadata for fraud signals
 */
async function analyzeImageMetadata(imageBuffer) {
  const signals = {
    exifPresent: false,
    aiSoftwareTag: false,
    whatsappStrippedExif: false,
    cameraInfo: null,
    timestamp: null,
    softwareName: null,
    redFlags: []
  };

  try {
    const metadata = await sharp(imageBuffer).metadata();
    
    if (metadata.exif) {
      signals.exifPresent = true;
      
      try {
        const exif = exifReader(metadata.exif);
        
        // Check for AI generation software tags
        const aiKeywords = [
          'stable diffusion', 'dall-e', 'dalle', 'midjourney', 
          'adobe firefly', 'ai generated', 'artificial intelligence',
          'stable-diffusion', 'pytorch', 'tensorflow'
        ];
        
        const software = (exif.Image?.Software || '').toLowerCase();
        signals.softwareName = exif.Image?.Software;
        
        if (aiKeywords.some(keyword => software.includes(keyword))) {
          signals.aiSoftwareTag = true;
          signals.redFlags.push(`AI software detected: ${exif.Image?.Software}`);
        }
        
        signals.cameraInfo = {
          make: exif.Image?.Make,
          model: exif.Image?.Model
        };
        
        signals.timestamp = exif.Image?.DateTime || exif.Photo?.DateTimeOriginal;
        
        if (!exif.Image?.Make && !exif.Image?.Model) {
          signals.redFlags.push('No camera make/model in EXIF');
        }
        
      } catch (exifError) {
        console.error('EXIF parsing error:', exifError);
      }
    } else {
      signals.whatsappStrippedExif = true;
      signals.redFlags.push('No EXIF metadata (WhatsApp may have stripped it)');
    }
    
    if (metadata.width && metadata.height) {
      if (metadata.width % 64 === 0 && metadata.height % 64 === 0) {
        signals.redFlags.push('Perfect 64-pixel alignment (AI generation pattern)');
      }
    }
    
  } catch (error) {
    console.error('Metadata analysis error:', error);
  }
  
  return signals;
}

/**
 * Check if image looks "too perfect"
 */
async function checkImageQuality(imageBuffer) {
  try {
    const stats = await sharp(imageBuffer).stats();
    const avgVariance = stats.channels.reduce((sum, ch) => sum + (ch.stdev || 0), 0) / stats.channels.length;
    const tooPerfect = avgVariance < 5;
    
    return {
      variance: avgVariance,
      tooPerfect,
      reason: tooPerfect ? 'Unusually low noise/variance (too clean)' : null
    };
  } catch (error) {
    console.error('Quality check error:', error);
    return { variance: null, tooPerfect: false, reason: null };
  }
}

module.exports = {
  analyzeImageMetadata,
  checkImageQuality
};