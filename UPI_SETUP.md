# Direct UPI checkout

The initial storefront payment flow shows the owner's UPI ID and payment QR code. Customers send payment proof and delivery details to SKINTRONICS on Instagram; the owner checks the transfer and confirms the order manually.

At the owner's request, the current page shows clearly labeled dummy details and a demo QR. The QR contains sample text, not a payment URI. Replace these before accepting real payments.

## Add payment details

1. Set `upiId` and `recipientName` in the `payment` object at the top of `checkout.js` to the owner's verified details. Both are required to display the payment panel.
2. Put the matching payment QR image in `assets/`, using a filename such as `skintronics-upi-qr.png`. Supported formats are PNG, JPG, JPEG and WebP. Set `qrImage` to its relative path, for example `assets/skintronics-upi-qr.png`.
3. Scan the actual QR in a UPI app and check that it resolves to the same UPI ID and recipient. Use a QR without a fixed amount so an owner-approved Instagram discount can be paid correctly. Review both the standard ₹7,999 total and any discounted amount before launch.
4. Check the checkout on a phone and desktop, including copying the UPI ID and saving the QR. Clipboard copying needs HTTPS or localhost; customers can select the displayed ID if copying is unavailable.
5. Set `demo` to `false` after replacing and verifying all three sample values. Keep it `true` while showing dummy details.

The payment details are public. Do not include UPI PINs, bank login details or API secrets. If either the UPI ID or recipient name is blank, the page directs customers to Instagram and hides the payment panel. A missing QR image leaves the UPI ID available. The current dummy values are explicitly labeled as a preview and do not provide real payment details.

## Confirm orders

Customers are asked to send a screenshot or transaction reference, name, phone and complete India delivery address with PIN code. Verify receipt in the receiving account before confirming an order. The site does not verify UPI transfers, create order records or send confirmations for this flow. These purchases do not automatically populate the existing admin dashboard.

The summary remains one pink SM-2309 mask at ₹7,999 including GST, with free shipping across India. Customers must contact SKINTRONICS to confirm Instagram discounts or multiple-mask pricing before transferring payment.

## Hosting

The customer payment page works with static hosting, the Node server, or the existing Cloudflare build. QR files placed in `assets/` are included by `npm run build:cloudflare`. No Razorpay credentials are needed for the customer page. Keep `CHECKOUT_ENABLED=false` while using this initial flow.

The Razorpay backend and admin implementation remain in the repository for a later phase. `RAZORPAY_SETUP.md` and `ADMIN_SETUP.md` describe that later integration; enabling their environment settings does not change this UPI page back to Razorpay.
