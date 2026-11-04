'use strict';

/**
 * Authentification très simple à un seul mot de passe (usage personnel).
 *
 * - Le mot de passe n'est jamais stocké côté navigateur.
 * - La session est un cookie HttpOnly signé (HMAC-SHA256).
 * - Si SESSION_SECRET est absent, la clé est dérivée de APP_PASSWORD :
 *   changer le mot de passe invalide alors toutes les sessions.
 */

const crypto = require('node:crypto');
const { config } = require('./config');

const COOKIE_NAME = 'tdz_session';
const TOKEN_VERSION = 1;
const DAY_MS = 86_400_000;

let cachedSecret = null;

function getSigningKey() {
  if (cachedSecret) return cachedSecret;
  let material = null;
  if (config.sessionSecret) {
    material = `secret:${config.sessionSecret}`;
  } else if (config.appPassword) {
    material = `password:${config.appPassword}`;
  }
  if (!material) return null;
  cachedSecret = crypto.createHash('sha256').update(material).digest();
  return cachedSecret;
}

function sign(payloadBase64Url) {
  const key = getSigningKey();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(payloadBase64Url).digest('base64url');
}

function isPasswordConfigured() {
  return Boolean(config.appPassword);
}

/** Comparaison à temps constant (on compare des empreintes de taille fixe). */
function verifyPassword(candidate) {
  if (!isPasswordConfigured() || typeof candidate !== 'string' || candidate.length > 512) {
    return false;
  }
  const provided = crypto.createHash('sha256').update(candidate).digest();
  const expected = crypto.createHash('sha256').update(config.appPassword).digest();
  return crypto.timingSafeEqual(provided, expected);
}

function createSessionToken(now = Date.now()) {
  if (!getSigningKey()) return null;
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    v: TOKEN_VERSION,
    iat: issuedAt,
    exp: issuedAt + config.sessionTtlDays * 86_400,
    n: crypto.randomBytes(9).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(encoded);
  return signature ? `${encoded}.${signature}` : null;
}

function verifySessionToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1024) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return false;

  const expected = sign(encoded);
  if (!expected) return false;
  const providedBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) return false;
  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return false;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!payload || payload.v !== TOKEN_VERSION) return false;
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds) return false;
  if (!Number.isFinite(payload.iat) || payload.iat > nowSeconds + 300) return false;
  return true;
}

/** Parse l'en-tête Cookie sans dépendance externe. */
function parseCookies(headerValue) {
  const result = {};
  if (typeof headerValue !== 'string' || !headerValue) return result;
  for (const part of headerValue.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name || Object.prototype.hasOwnProperty.call(result, name)) continue;
    let value = part.slice(index + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // On garde la valeur brute si le pourcentage-encodage est cassé.
    }
    result[name] = value;
  }
  return result;
}

/** Lit et valide la session depuis la requête. */
function isAuthenticated(req) {
  if (!isPasswordConfigured()) return false;
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  return Boolean(token && verifySessionToken(token));
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
  };
}

function setSessionCookie(req, res) {
  const token = createSessionToken();
  if (!token) return false;
  res.cookie(COOKIE_NAME, token, {
    ...cookieOptions(req),
    maxAge: config.sessionTtlDays * DAY_MS,
  });
  return true;
}

function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
}

module.exports = {
  COOKIE_NAME,
  isPasswordConfigured,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  isAuthenticated,
  setSessionCookie,
  clearSessionCookie,
};
