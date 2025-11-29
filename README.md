Send Ryan a Bird

App loads last 12 images uploaded to Cloudflare R2 bucket.
User uploads image.
Tensorflow mobilenet model checks that image contains a bird.
Image is uploaded to R2 bucket via Cloudflare Worker, then Worker sends media message via Twilio.

## Architecture

- **Frontend**: React app hosted on Cloudflare Pages
- **Storage**: Cloudflare R2 for bird images
- **Backend**: Cloudflare Worker handling R2 operations and SMS via Twilio
- **Hosting**: Cloudflare Pages (static hosting) + Cloudflare Workers (API)

## Cloudflare Worker Endpoints

The Worker provides the following API endpoints:

- `GET /list` - Returns the last 12 images from R2 bucket
- `POST /upload` - Uploads an image to R2 bucket
- `POST /sms` - Sends SMS via Twilio with media attachment
- `GET /image/:filename` - Serves images from R2 bucket

## Storage Limits & Automatic Cleanup

The app is configured to stay within Cloudflare R2's free tier (10GB storage):

- **Maximum bucket size**: 9GB (leaving 1GB buffer for safety)
- **Maximum files**: 500 files
- **Automatic cleanup**: When storage reaches 85% capacity, oldest files are automatically deleted
- **File size limit**: 10MB per file

The system automatically manages storage by:
1. Checking bucket size before each upload
2. Cleaning up oldest files when approaching limits
3. Preventing uploads if bucket is at capacity

This ensures the app stays within the free tier and doesn't incur unexpected costs.

## Setup

### Prerequisites

1. Install Wrangler CLI: `npm install -g wrangler`
2. Login to Cloudflare: `wrangler login`
3. Node.js and npm installed

### Initial Setup

#### 1. Cloudflare Worker Configuration

1. Create R2 bucket:
   ```bash
   wrangler r2 bucket create sendryanabird-bucket
   ```

2. Update `wrangler.toml` with your bucket name (already configured)

3. Set Twilio secrets (you'll be prompted to enter each value):
   ```bash
   wrangler secret put TWILIO_ACCOUNT_SID
   wrangler secret put TWILIO_AUTH_TOKEN
   wrangler secret put TWILIO_PHONE_NUMBER
   ```
   Note: Phone number should be in E.164 format (e.g., `+18043921664`)

4. Deploy Worker:
   ```bash
   wrangler deploy
   ```

#### 2. Cloudflare Pages Configuration

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → Pages
2. Click "Create a project" → "Connect to Git"
3. Connect your GitHub/GitLab/Bitbucket repository
4. Configure build settings:
   - **Project name**: `sendryanabird`
   - **Production branch**: `main`
   - **Build command**: `npm run build`
   - **Build output directory**: `build`
   - **Root directory**: `/` (leave as default)
5. Add environment variable:
   - **Variable name**: `VITE_WORKER_URL`
   - **Value**: Your Worker URL (e.g., `https://sendryanabird-worker.your-subdomain.workers.dev`)

### Local Development

For local development, create a `.env` file in the root directory:

```
VITE_WORKER_URL=https://sendryanabird-worker.your-subdomain.workers.dev
```

Then run:
```bash
npm install
npm start
```

## Deployment

### Automatic Deployment (Production)

**The app automatically builds and deploys to production when you push to the `main` branch.**

Simply commit and push your changes:
```bash
git add .
git commit -m "Your commit message"
git push origin main
```

Cloudflare Pages will:
1. Detect the push to `main`
2. Install dependencies (`npm install`)
3. Build the app (`npm run build`)
4. Deploy to production automatically

You can monitor the build progress in the Cloudflare Pages dashboard.

### Manual Worker Deployment

If you make changes to the Worker code (`worker/index.js`), deploy manually:

```bash
wrangler deploy
```

### Environment Variables

- **Cloudflare Pages**: Set `VITE_WORKER_URL` in the Pages dashboard (Settings → Environment variables)
- **Cloudflare Worker**: Secrets are set via `wrangler secret put` commands (see Setup section)

Note: Images are served through the Worker at `/image/:filename`, so no separate R2 public URL configuration is needed.

## Migration from AWS

This app has been migrated from AWS (S3, Lambda, API Gateway) to Cloudflare (R2, Workers, Pages).

### What Changed

- **S3 → R2**: Object storage migrated to Cloudflare R2
- **Lambda → Workers**: Serverless functions migrated to Cloudflare Workers
- **API Gateway → Workers**: API endpoints now handled by Workers
- **Hostinger → Cloudflare Pages**: Static hosting moved to Cloudflare Pages with Git-based deployments
