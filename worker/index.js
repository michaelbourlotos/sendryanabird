/**
 * Cloudflare Worker for Send Ryan a Bird App
 * Handles R2 operations (list, upload) and SMS sending via Twilio
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
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

    // Convert base64 to ArrayBuffer
    const binaryString = atob(fileData);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Upload to R2
    await bucket.put(fileName, bytes, {
      httpMetadata: {
        contentType: contentType || 'image/jpeg',
      },
    });

    return new Response(
      JSON.stringify({ success: true, fileName }),
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

