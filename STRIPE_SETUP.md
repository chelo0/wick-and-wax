# Stripe Integration - Quick Setup Guide

## Overview
Wick & Wax uses Stripe for subscription payments. This guide helps you configure it with real keys.

## Prerequisites
- Stripe account (live mode)
- Stripe CLI installed (for webhooks during development)
- Server running on `http://localhost:3000`

## Step 1: Get Stripe Keys

### Live Secret Key
1. Go to https://dashboard.stripe.com/apikeys
2. Switch to **Live mode** (toggle in top right)
3. Copy **Secret key** (starts with `sk_live_...`)
4. Paste it in `.env` as `STRIPE_SECRET_KEY`

### Webhook Secret
For development without public domain:

1. Install Stripe CLI:
   ```bash
   # Windows (PowerShell)
   scoop install stripe
   # Or download from: https://stripe.com/docs/stripe-cli
   ```

2. Login to Stripe:
   ```bash
   stripe login
   ```

3. Start webhook tunnel:
   ```bash
   stripe listen --forward-to localhost:3000/api/webhooks/stripe
   ```

4. Copy the `whsec_...` value from the output

5. Paste it in `.env` as `STRIPE_WEBHOOK_SECRET`

## Step 2: Configure Environment Variables

Edit your `.env` file:

```env
# Stripe payment integration (LIVE KEYS)
STRIPE_SECRET_KEY="sk_live_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
FRONTEND_URL="http://localhost:3000"

# Server configuration
PORT=3000
NODE_ENV=production
```

## Step 3: Test the Integration

### Start the server
```bash
cd C:\Users\ganta\Projects\wick-and-wax
node server.ts
```

### Test checkout flow
1. Open http://localhost:3000
2. Login with a test account
3. Select a paid plan (Pro or Business)
4. Complete the checkout with a real card
5. After payment, you should be redirected back with success message

### Monitor webhooks
In a separate terminal:
```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

You should see the `checkout.session.completed` event when payment succeeds.

## Step 4: Production Deployment

When deploying to production:

1. Use live keys in `.env`
2. Set up webhook endpoint in Stripe Dashboard:
   - URL: `https://yourdomain.com/api/webhooks/stripe`
   - Events: `checkout.session.completed`
3. Copy webhook secret to `.env`
4. Set `NODE_ENV=production`

## Troubleshooting

### "Invalid API Key" error
- Make sure you're using `sk_live_...` not `sk_test_...`
- Check that the key is correctly copied in `.env`

### Webhook not received
- Make sure Stripe CLI is running: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
- Check that server is running on port 3000
- Verify `STRIPE_WEBHOOK_SECRET` matches the one from Stripe CLI

### Payment succeeds but plan not updated
- Check server logs for webhook errors
- Verify webhook endpoint is receiving events
- Check that `STRIPE_WEBHOOK_SECRET` is set correctly

## Security Notes

- **NEVER** commit `.env` to git
- **NEVER** share your `sk_live_...` key publicly
- Use environment variables in production, not `.env` files
- Rotate keys immediately if compromised

## Support

If you need help:
1. Check server logs for errors
2. Verify all environment variables are set
3. Test with Stripe test cards first: https://stripe.com/docs/testing
