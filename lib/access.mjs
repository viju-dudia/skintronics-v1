import { CheckoutError } from './razorpay.mjs';

const certificates = new Map();
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

export async function authorizeAdmin(request, env, fetchAPI = fetch) {
    const domain = env.ACCESS_TEAM_DOMAIN || '';
    const audience = env.ACCESS_AUD || '';
    const allowed = (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) || !audience || !allowed.length) {
        throw new CheckoutError(503, 'Admin access is not configured. Complete the Cloudflare Access setup.');
    }
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || token.length > 16384) throw new CheckoutError(401, 'Sign in through Cloudflare Access to manage orders.');
    try {
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error();
        const header = decode(parts[0]);
        const claims = decode(parts[1]);
        const now = Date.now() / 1000;
        if (header.alg !== 'RS256' || typeof header.kid !== 'string' || claims.iss !== `https://${domain}`
            || !Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now))
            || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience)) throw new Error();
        let cached = certificates.get(domain);
        if (!cached || cached.expires <= Date.now() || !cached.keys.some((key) => key.kid === header.kid)) {
            const response = await fetchAPI(`https://${domain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
            if (!response.ok) throw new Error();
            const body = await response.json();
            if (!Array.isArray(body.keys)) throw new Error();
            cached = { keys: body.keys, expires: Date.now() + 300000 };
            certificates.set(domain, cached);
        }
        const jwk = cached.keys.find((key) => key.kid === header.kid && key.kty === 'RSA');
        if (!jwk) throw new Error();
        const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
        if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Buffer.from(parts[2], 'base64url'), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw new Error();
        const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
        if (!allowed.includes(email)) throw new CheckoutError(403, 'Your account does not have permission to manage this store.');
        return { email };
    } catch (error) {
        if (error instanceof CheckoutError) throw error;
        throw new CheckoutError(401, 'Your admin session could not be verified. Sign in again.');
    }
}
