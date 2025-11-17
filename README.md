Send Ryan a Bird

App loads last four images uploaded to Cloudflare R2 bucket.
User uploads image.
Tensorflow mobilenet model checks that image contains a bird.
Image is uploaded to R2 bucket via Cloudflare Worker, then Worker sends media message via Twilio.

## Architecture

- **Frontend**: React app hosted on Cloudflare Pages
- **Storage**: Cloudflare R2 for bird images
- **Backend**: Cloudflare Worker handling R2 operations and SMS via Twilio
- **Hosting**: Cloudflare Pages (static hosting) + Cloudflare Workers (API)

## Setup

### Environment Variables

Create a `.env` file in the root directory with the following variables:

```
# Cloudflare R2 Public URL
# Format: https://your-account-id.r2.cloudflarestorage.com/your-bucket-name
# Or use a custom domain if configured
REACT_APP_R2_PUBLIC_URL=https://your-r2-public-url.com

# Cloudflare Worker URL
# This will be your Worker's URL after deployment
# Format: https://sendryanabird-worker.your-subdomain.workers.dev
REACT_APP_WORKER_URL=https://your-worker.workers.dev
```

### Cloudflare Worker Configuration

1. Install Wrangler CLI: `npm install -g wrangler`
2. Login to Cloudflare: `wrangler login`
3. Create R2 bucket in Cloudflare dashboard
4. Update `wrangler.toml` with your bucket name
5. Set Twilio secrets:
   ```bash
   wrangler secret put TWILIO_ACCOUNT_SID
   wrangler secret put TWILIO_AUTH_TOKEN
   wrangler secret put TWILIO_PHONE_NUMBER
   ```
6. Deploy Worker: `wrangler deploy`

### Deployment

1. **Deploy Worker**: `cd` to project root and run `wrangler deploy`
2. **Deploy Frontend**: Connect your GitHub repo to Cloudflare Pages or use `wrangler pages deploy build`

## Migration from AWS

This app has been migrated from AWS (S3, Lambda, API Gateway) to Cloudflare (R2, Workers, Pages).
