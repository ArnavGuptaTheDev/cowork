// Generates a VAPID key pair for Web Push. Prints values only to your terminal: never commit them.
// Output format matches what `web-push generate-vapid-keys` prints (base64url).
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

console.log(`VAPID_PUBLIC_KEY=${b64url(pub)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
