# Razorpay checkout

The site now uses Razorpay Standard Checkout. A Node.js server creates the Razorpay order, stores the delivery address privately, verifies the payment signature, checks capture status, and records the confirmed payment. The browser cannot set the charged price.

## Local setup

1. Use Node.js 24 or newer. There are no third-party server dependencies to install.
2. Copy `.env.example` to `.env` locally. This file is ignored by Git. Keep all secrets in `.env` or your hosting provider's secret settings, never in HTML, browser JavaScript, or chat.
3. Generate **test** API keys in your Razorpay dashboard. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
4. Confirm the mask's selling price, shipping charge, additional tax, stock availability, and delivery country. Set the amounts as **integer paise** in `PRODUCT_PRICE_PAISE`, `SHIPPING_PAISE`, and `TAX_PAISE`. Use zero only for a confirmed zero additional charge. An unknown amount must stay blank.
5. Set `SHIPPING_COUNTRY` to the confirmed two-letter country code. This version sells one SM-2309 mask in INR with a fixed shipping charge for that country. Destination-dependent rates, multiple quantities, other currencies, and discounts require additional implementation and confirmed business rules.
6. Set `CHECKOUT_ENABLED=true` when those details are ready, then run `npm start`.
7. Open [local checkout](http://127.0.0.1:4173/checkout.html). Test mode is visibly labelled and never represented as a real purchase.

Restart `npm start` after changing `.env`. Do not run a generic static file server over this project after adding credentials or customer data; the included server exposes only approved storefront files.

## Payment capture and webhooks

- Configure automatic capture in Razorpay's payment capture settings. An authorized payment is shown as pending until the API reports `captured`; authorization alone never confirms the purchase.
- Add a webhook for `payment.captured` and `order.paid` at `https://YOUR-DOMAIN/api/razorpay/webhook`. The domain here is a placeholder; use the actual deployed origin.
- Set a separate `RAZORPAY_WEBHOOK_SECRET` locally/on the server and the same value in the Razorpay webhook settings. The handler checks the HMAC against the original request bytes before reading the event.
- Repeated events are safe: a paid record is not rewritten or downgraded by an older authorization event. Browser verification and webhooks serialize updates to the same order.
- The checkout can recover a missing browser callback through **Check payment status**, or by reloading the page in the same browser. A private, HttpOnly session cookie identifies the order for seven days. Reloads and retries reuse the order rather than creating a second charge.

## Hosting and order fulfilment

Run `npm start` on a **single Node process with persistent private storage**, behind HTTPS. This implementation is not a static-only or ephemeral serverless deployment. Set `APP_ORIGIN` to the exact public HTTPS origin, `HOST` to the host's listening interface, and `PORT` as required by the host. A live key also requires HTTPS and a webhook secret before checkout will enable.

Set `ORDER_DATA_DIR` to a private persistent directory and back it up. Records contain customer contact/address details, the exact quote, Razorpay order ID, payment ID, test/live mode, and state. These records and the `.env` file are not served by the included web server. Keep them out of source control and any public static-hosting directory.

Fulfilment is manual: use records with `state: "paid"` and `testMode: false`, reconcile them against Razorpay before dispatch, and use the recorded delivery address. The integration does not send dispatch emails, create shipping labels, manage inventory quantities, or automate refunds. Retention/access policies for customer records and the owner's shipping/returns/warranty/privacy information still need to be set. Publish the confirmed purchase terms before accepting live orders.

For multiple application instances, replace the file store and process-local locks with a shared transactional database. The server applies request limits by its direct peer IP; configure appropriate per-customer limits at your trusted reverse proxy when deploying.

## Verification

Run `npm test`. Tests use fictional fixtures and an injected gateway; they do not contact Razorpay or charge money. They cover server-controlled amounts, repeated order requests, validation, forged payment signatures, amount/currency mismatch, authorization versus capture, session ownership, webhook signatures and duplicates, restart recovery, and private-file access.

The implementation was also checked in a browser at 320, 768, 1024, and 1440 pixels with simulated Razorpay callbacks, covering validation, cancellation/retry, payment failure, pending capture, success/reload, and network recovery. This development environment denied network access to the actual checkout script (`net::ERR_NETWORK_ACCESS_DENIED`), so a real Razorpay modal and merchant transaction have not yet been verified.

Before live activation, use real Razorpay **test** credentials to complete a test payment, cancel/retry, reload during confirmation, and confirm both webhook delivery and the saved record. That merchant-account end-to-end test remains pending until credentials and confirmed amounts are supplied. Replace test keys with live keys only after the merchant account and commercial details are ready.

## Official references

- [Standard Checkout integration and signature verification](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/)
- [Fetch payments for an order](https://razorpay.com/docs/api/orders/fetch-payments/)
- [Webhook signature validation and duplicate events](https://razorpay.com/docs/webhooks/validate-test/)
