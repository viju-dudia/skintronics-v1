(() => {
    // Public payment details. Fill these with the owner's verified details before launch.
    // Put the matching QR image in assets/ (PNG, JPG, JPEG or WebP).
    const payment = {
        demo: true,
        upiId: 'skintronics-demo@invalid',
        recipientName: 'SKINTRONICS (sample)',
        qrImage: 'assets/skintronics-upi-demo.png'
    };

    const details = document.querySelector('[data-upi-details]');
    const unavailable = document.querySelector('[data-upi-unavailable]');
    const copy = document.querySelector('[data-upi-copy]');
    const status = document.querySelector('[data-upi-copy-status]');
    const id = payment.upiId.trim();
    const name = payment.recipientName.trim();
    if (!id || !name) return;

    document.querySelector('[data-upi-id]').textContent = id;
    document.querySelector('[data-upi-recipient]').textContent = name;
    details.hidden = false;
    unavailable.hidden = true;
    document.querySelector('[data-upi-demo]').hidden = !payment.demo;
    if (payment.demo) {
        document.querySelector('[data-upi-instructions]').textContent = 'These are sample details for preview. Contact SKINTRONICS for the actual payment details.';
        document.querySelector('[data-upi-qr-image]').alt = 'Demo QR code containing sample text; not for payment';
        document.querySelector('[data-upi-download]').textContent = 'Save demo QR code';
        document.querySelector('[data-upi-download]').download = 'skintronics-upi-demo';
        copy.textContent = 'Copy sample UPI ID';
    }

    if (/^assets\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/.test(payment.qrImage)) {
        const qr = document.querySelector('[data-upi-qr]');
        const image = document.querySelector('[data-upi-qr-image]');
        image.addEventListener('load', () => { qr.hidden = false; });
        image.addEventListener('error', () => {
            qr.hidden = true;
            status.textContent = payment.demo ? 'The demo QR code could not load. Contact SKINTRONICS for actual payment details.' : 'The QR code could not load. You can still pay using the UPI ID.';
        });
        document.querySelector('[data-upi-download]').href = payment.qrImage;
        image.src = payment.qrImage;
    }

    copy.addEventListener('click', async () => {
        copy.disabled = true;
        try {
            await navigator.clipboard.writeText(id);
            status.textContent = payment.demo ? 'Sample UPI ID copied. This ID cannot be used for payment.' : 'UPI ID copied. Paste it into your UPI app.';
        } catch {
            status.textContent = payment.demo ? 'Select and copy the sample UPI ID above. This ID cannot be used for payment.' : 'Select and copy the UPI ID above, then paste it into your UPI app.';
        } finally {
            copy.disabled = false;
        }
    });
})();
