/**
 * Cloudflare Worker for Send Ryan a Bird App
 * Handles R2 operations (list, upload) and SMS sending via Twilio
 */

// Security constants
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB max file size
const MAX_REQUEST_SIZE = 15 * 1024 * 1024; // 15MB max request size (base64 is ~33% larger)
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml',
  'image/tiff',
  'image/x-icon',
  'image/vnd.microsoft.icon',
];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.ico'];
const RATE_LIMIT_REQUESTS = 20; // Max requests per window
const RATE_LIMIT_WINDOW = 60000; // 1 minute window (in milliseconds)
const ALLOWED_SMS_RECIPIENT = '+17573030776'; // Only allow sending to this number

// Bucket size limits (Cloudflare R2 free tier: 10GB storage)
const MAX_BUCKET_SIZE = 9 * 1024 * 1024 * 1024; // 9GB limit (leaving 1GB buffer)
const MAX_FILES_IN_BUCKET = 500; // Maximum number of files to keep
const CLEANUP_THRESHOLD = 0.85; // Start cleanup when 85% of limit is reached

// Simple rate limiting store (in-memory, resets on Worker restart)
const rateLimitStore = new Map();

/**
 * Get CORS headers based on origin
 */
function getCorsHeaders(origin) {
  // Allow requests from Cloudflare Pages domains and localhost for development
  const allowedOrigins = [
    /^https:\/\/.*\.pages\.dev$/,
    /^https:\/\/.*\.cloudflareapp\.com$/,
    /^http:\/\/localhost:\d+$/,
  ];
  
  const isAllowed = !origin || allowedOrigins.some(pattern => pattern.test(origin));
  const allowOrigin = isAllowed ? (origin || '*') : '*'; // Fallback to * for public access
  
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/**
 * Check rate limit for an IP address
 */
function checkRateLimit(ip) {
  const now = Date.now();
  const key = ip;
  
  if (!rateLimitStore.has(key)) {
    rateLimitStore.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  const limit = rateLimitStore.get(key);
  
  // Reset if window expired
  if (now > limit.resetTime) {
    rateLimitStore.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  // Check if limit exceeded
  if (limit.count >= RATE_LIMIT_REQUESTS) {
    return false;
  }
  
  // Increment count
  limit.count++;
  return true;
}

/**
 * Sanitize filename to prevent path traversal and ensure safe naming
 */
function sanitizeFilename(fileName) {
  // Remove path separators and dangerous characters
  let sanitized = fileName
    .replace(/[/\\]/g, '') // Remove path separators
    .replace(/\.\./g, '') // Remove parent directory references
    .replace(/[^a-zA-Z0-9._-]/g, '_'); // Replace invalid chars with underscore
  
  // Ensure it starts with alphanumeric
  if (!/^[a-zA-Z0-9]/.test(sanitized)) {
    sanitized = 'file_' + sanitized;
  }
  
  // Limit length
  if (sanitized.length > 255) {
    const ext = sanitized.substring(sanitized.lastIndexOf('.'));
    sanitized = sanitized.substring(0, 255 - ext.length) + ext;
  }
  
  return sanitized;
}

/**
 * Validate file type
 */
function isValidImageType(contentType, fileName) {
  // Check MIME type
  if (contentType && ALLOWED_IMAGE_TYPES.includes(contentType.toLowerCase())) {
    return true;
  }
  
  // Check file extension as fallback
  const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
  return ALLOWED_EXTENSIONS.includes(ext);
}

/**
 * Get bucket size and file count
 */
async function getBucketStats(bucket) {
  try {
    const result = await bucket.list();
    let totalSize = 0;
    let fileCount = 0;
    
    for (const obj of result.objects) {
      totalSize += obj.size || 0;
      fileCount++;
    }
    
    // Handle pagination if there are more than 1000 objects
    let cursor = result.cursor;
    while (cursor && fileCount < MAX_FILES_IN_BUCKET * 2) {
      const nextResult = await bucket.list({ cursor });
      for (const obj of nextResult.objects) {
        totalSize += obj.size || 0;
        fileCount++;
      }
      cursor = nextResult.cursor;
    }
    
    return { totalSize, fileCount };
  } catch (error) {
    console.error('Error getting bucket stats:', error);
    return { totalSize: 0, fileCount: 0 };
  }
}

/**
 * Clean up old files to stay within limits
 */
async function cleanupOldFiles(bucket, targetSize, targetFileCount) {
  try {
    const result = await bucket.list();
    const allObjects = result.objects.map(obj => ({
      key: obj.key,
      size: obj.size || 0,
      uploaded: obj.uploaded instanceof Date ? obj.uploaded : new Date(obj.uploaded),
    }));
    
    // Handle pagination
    let cursor = result.cursor;
    while (cursor) {
      const nextResult = await bucket.list({ cursor });
      allObjects.push(...nextResult.objects.map(obj => ({
        key: obj.key,
        size: obj.size || 0,
        uploaded: obj.uploaded instanceof Date ? obj.uploaded : new Date(obj.uploaded),
      })));
      cursor = nextResult.cursor;
    }
    
    // Sort by date (oldest first)
    allObjects.sort((a, b) => a.uploaded - b.uploaded);
    
    let currentSize = allObjects.reduce((sum, obj) => sum + obj.size, 0);
    let currentCount = allObjects.length;
    const filesToDelete = [];
    
    // Delete oldest files until we're under limits
    for (const obj of allObjects) {
      if (currentSize <= targetSize && currentCount <= targetFileCount) {
        break;
      }
      filesToDelete.push(obj.key);
      currentSize -= obj.size;
      currentCount--;
    }
    
    // Delete files in batches
    for (const key of filesToDelete) {
      try {
        await bucket.delete(key);
        console.log(`Deleted old file: ${key}`);
      } catch (error) {
        console.error(`Error deleting file ${key}:`, error);
      }
    }
    
    return { deleted: filesToDelete.length, remainingSize: currentSize, remainingCount: currentCount };
  } catch (error) {
    console.error('Error cleaning up old files:', error);
    return { deleted: 0, remainingSize: 0, remainingCount: 0 };
  }
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get('Origin');
    const clientIP = request.headers.get('CF-Connecting-IP') || 
                     request.headers.get('X-Forwarded-For') || 
                     'unknown';

    // CORS headers
    const corsHeaders = getCorsHeaders(origin);

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Rate limiting (skip for image serving to allow public access)
    if (!path.startsWith('/image/')) {
      if (!checkRateLimit(clientIP)) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }),
          {
            status: 429,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }
    }

    try {
      // Route: List images from R2
      if (path === '/list' && request.method === 'GET') {
        return await handleListImages(env, corsHeaders);
      }

      // Route: Upload image to R2
      if (path === '/upload' && request.method === 'POST') {
        return await handleUploadImage(request, env, corsHeaders);
      }

      // Route: Send SMS via Twilio
      if (path === '/sms' && request.method === 'POST') {
        return await handleSendSMS(request, env, corsHeaders);
      }

      // Route: Serve images from R2
      if (path.startsWith('/image/') && request.method === 'GET') {
        return await handleServeImage(path, env, corsHeaders);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(
        JSON.stringify({ error: error.message }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }
  },
};

export default worker;

/**
 * List the last 4 images from R2 bucket
 */
async function handleListImages(env, corsHeaders) {
  try {
    const bucket = env.R2_BUCKET;
    if (!bucket) {
      throw new Error('R2_BUCKET not configured');
    }

    // List objects from R2
    const result = await bucket.list();
    
    // Sort by uploaded date (newest first) and take last 4
    const sortedObjects = result.objects
      .sort((a, b) => {
        const dateA = a.uploaded instanceof Date ? a.uploaded : new Date(a.uploaded);
        const dateB = b.uploaded instanceof Date ? b.uploaded : new Date(b.uploaded);
        return dateB - dateA;
      })
      .slice(0, 4)
      .map(obj => ({
        Key: obj.key,
        LastModified: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : obj.uploaded,
      }));

    return new Response(
      JSON.stringify({ images: sortedObjects }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error listing images:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to list images' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Upload image to R2 bucket
 */
async function handleUploadImage(request, env, corsHeaders) {
  try {
    const bucket = env.R2_BUCKET;
    if (!bucket) {
      throw new Error('R2_BUCKET not configured');
    }

    // Check request size
    const contentLength = request.headers.get('Content-Length');
    if (contentLength && parseInt(contentLength) > MAX_REQUEST_SIZE) {
      return new Response(
        JSON.stringify({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` }),
        {
          status: 413,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const body = await request.json();
    const { fileName, fileData, contentType } = body;

    if (!fileName || !fileData) {
      return new Response(
        JSON.stringify({ error: 'Missing fileName or fileData' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Validate file type
    if (!isValidImageType(contentType, fileName)) {
      return new Response(
        JSON.stringify({ 
          error: 'Invalid file type. Supported formats: JPEG, PNG, GIF, WebP, BMP, SVG, TIFF, ICO' 
        }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Sanitize filename
    const sanitizedFileName = sanitizeFilename(fileName);
    
    // Convert base64 to ArrayBuffer and check size
    let binaryString;
    try {
      binaryString = atob(fileData);
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Invalid base64 data' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Check decoded file size
    const fileSize = binaryString.length;
    if (fileSize > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` }),
        {
          status: 413,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Check bucket size before upload
    const stats = await getBucketStats(bucket);
    const projectedSize = stats.totalSize + fileSize;
    const projectedCount = stats.fileCount + 1;

    // Check if we're at capacity
    if (projectedSize > MAX_BUCKET_SIZE) {
      return new Response(
        JSON.stringify({ 
          error: 'Bucket storage limit reached. Please contact administrator or wait for cleanup.',
          currentSize: `${(stats.totalSize / 1024 / 1024 / 1024).toFixed(2)}GB`,
          maxSize: `${(MAX_BUCKET_SIZE / 1024 / 1024 / 1024).toFixed(2)}GB`
        }),
        {
          status: 507,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Cleanup old files if approaching limits
    if (projectedSize > MAX_BUCKET_SIZE * CLEANUP_THRESHOLD || projectedCount > MAX_FILES_IN_BUCKET) {
      const targetSize = MAX_BUCKET_SIZE * CLEANUP_THRESHOLD * 0.8; // Clean to 80% of threshold
      const targetCount = Math.floor(MAX_FILES_IN_BUCKET * 0.8);
      await cleanupOldFiles(bucket, targetSize, targetCount);
    }

    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const ext = sanitizedFileName.substring(sanitizedFileName.lastIndexOf('.'));
    const finalFileName = `bird-${timestamp}${ext}`;

    // Upload to R2
    await bucket.put(finalFileName, bytes, {
      httpMetadata: {
        contentType: contentType || 'image/jpeg',
      },
    });

    return new Response(
      JSON.stringify({ success: true, fileName: finalFileName }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error uploading image:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to upload image' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Send SMS via Twilio
 */
async function handleSendSMS(request, env, corsHeaders) {
  try {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = env;
    
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
      throw new Error('Twilio credentials not configured');
    }

    const body = await request.json();
    const { message, recipientPhoneNumber, mediaUrl } = body;

    if (!recipientPhoneNumber || !mediaUrl) {
      return new Response(
        JSON.stringify({ error: 'Missing recipientPhoneNumber or mediaUrl' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Validate recipient - only allow the configured recipient
    if (recipientPhoneNumber !== ALLOWED_SMS_RECIPIENT) {
      return new Response(
        JSON.stringify({ error: 'Invalid recipient phone number' }),
        {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Validate mediaUrl is from our Worker
    try {
      const mediaUrlObj = new URL(mediaUrl);
      if (!mediaUrlObj.pathname.startsWith('/image/')) {
        return new Response(
          JSON.stringify({ error: 'Invalid media URL' }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Invalid media URL format' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Create Basic Auth header for Twilio
    const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);

    // Prepare Twilio API request
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    
    const formData = new URLSearchParams();
    formData.append('From', TWILIO_PHONE_NUMBER);
    formData.append('To', recipientPhoneNumber);
    formData.append('Body', message || 'Check out this little beauty!');
    formData.append('MediaUrl', mediaUrl);

    const twilioResponse = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!twilioResponse.ok) {
      const errorText = await twilioResponse.text();
      console.error('Twilio error:', errorText);
      return new Response(
        JSON.stringify({ error: 'Failed to send SMS', details: errorText }),
        {
          status: twilioResponse.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const twilioData = await twilioResponse.json();

    return new Response(
      JSON.stringify({ success: true, messageSid: twilioData.sid }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error sending SMS:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to send SMS', details: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Serve images from R2 bucket
 */
async function handleServeImage(path, env, corsHeaders) {
  try {
    const bucket = env.R2_BUCKET;
    if (!bucket) {
      throw new Error('R2_BUCKET not configured');
    }

    // Extract filename from path (e.g., /image/bird-123.jpeg -> bird-123.jpeg)
    let filename = path.replace('/image/', '');
    
    if (!filename) {
      return new Response('Filename required', {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Sanitize filename to prevent path traversal
    filename = sanitizeFilename(filename);
    
    // Additional security: ensure filename doesn't contain path separators
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return new Response('Invalid filename', {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Get object from R2
    const object = await bucket.get(filename);

    if (!object) {
      return new Response('Image not found', {
        status: 404,
        headers: corsHeaders,
      });
    }

    // Get the content type from object metadata or default to image/jpeg
    const contentType = object.httpMetadata?.contentType || 'image/jpeg';

    // Return the image with appropriate headers
    return new Response(object.body, {
      headers: {
        ...corsHeaders,
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
      },
    });
  } catch (error) {
    console.error('Error serving image:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to serve image' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}

