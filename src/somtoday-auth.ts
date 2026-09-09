// Somtoday OAuth2 (PKCE) client.
//
// IMPORTANT CAVEAT: this reproduces the login POST that Somtoday's own
// native app performs against https://inloggen.somtoday.nl/. That works for
// schools where Somtoday hosts the login form itself. Schools that federate
// login through an external identity provider (Microsoft Entra ID / Azure AD,
// SURFconext, etc.) present an extra redirect + form that this simple POST
// flow cannot follow, and will fail here. If that's your school, this
// module won't work and you'll need to stick to the public iCal feed
// (calendar.ts) for now — homework/cancellation-status won't be available
// without a browser-based login.
//
// Token lifetime: access_token expires in 3600s. We persist the
// refresh_token in KV and silently refresh ~5 minutes before expiry, so as
// long as this Worker gets invoked at least once every so often, you should
// never see a login prompt again — until Somtoday itself invalidates the
// refresh token (e.g. after a long period of total inactivity, or a
// school-side password reset).

export interface SomtodayCreds {
  username: string;
  password: string;
  tenantUuid: string; // school UUID from https://servers.somtoday.nl/organisaties.json
}

/** Manual token bootstrap: instead of the (fragile, unverified) password
 * login below, you capture a working access_token + refresh_token pair
 * once from your own logged-in browser session (DevTools -> Network ->
 * any api.somtoday.nl request -> Headers -> "authorization: Bearer ...";
 * the refresh_token isn't visible in headers, but IndexedDB/localStorage
 * under the somtoday origin holds it under an oidc-client key) and paste
 * them in as Worker secrets. This is the recommended path — it doesn't
 * depend on us correctly replaying Somtoday's login form, which varies by
 * school and can include SSO we can't automate at all. */
export async function getAccessTokenFromBootstrap(
  kv: KVNamespace, refreshToken: string
): Promise<string> {
  const stored = await kv.get<{ access_token: string; refresh_token: string; expires_at: number }>(
    "somtoday_tokens", "json"
  );
  if (stored && stored.expires_at - Date.now() > 5 * 60 * 1000) {
    return stored.access_token;
  }
  const rtToUse = stored?.refresh_token || refreshToken;
  const fresh = await refresh(rtToUse);
  await kv.put("somtoday_tokens", JSON.stringify(fresh));
  return fresh.access_token;
}

interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

// Confirmed live from a real captured refresh_token JWT (2026-09-09):
// iss "https://somtoday.nl", client_id "somtoday-leerling-web",
// refresh token lifetime exactly 8 hours (28800s) from issuance. That 8h
// window — not "nothing was refreshing" — is almost certainly the real
// reason logins felt like they expired constantly: whatever client you
// were using wasn't refreshing inside that window. As long as this Worker
// (via its cron trigger) uses the refresh token at least once every 8
// hours, Somtoday issues a fresh refresh_token each time (rotation) and
// the session should never lapse.
const TOKEN_ENDPOINT = "https://somtoday.nl/oauth2/token";
const AUTH_ENDPOINT = "https://inloggen.somtoday.nl/oauth2/authorize";
const CLIENT_ID = "somtoday-leerling-web";
const REDIRECT_URI = "somtodayleerling://oauth/callback";
const KV_KEY = "somtoday_tokens";

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64url(verifierBytes.buffer);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(digest) };
}

/** Look up a school's tenant UUID by (partial, case-insensitive) name. */
export async function findTenant(schoolNameQuery: string): Promise<{ uuid: string; name: string }[]> {
  const res = await fetch("https://servers.somtoday.nl/organisaties.json");
  const orgs: [string, string, string][] = await res.json();
  const q = schoolNameQuery.toLowerCase();
  return orgs
    .filter(([, name]) => name.toLowerCase().includes(q))
    .map(([uuid, name]) => ({ uuid, name }));
}

/** Full username/password login. Fragile — see module caveat above. */
async function passwordLogin(creds: SomtodayCreds): Promise<TokenSet> {
  const { verifier, challenge } = await pkcePair();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)).buffer);

  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("tenant_uuid", creds.tenantUuid);
  authUrl.searchParams.set("scope", "openid");

  const jar = new CookieJar();
  const step1 = await fetchWithJar(authUrl.toString(), { redirect: "manual" }, jar);
  const loginActionUrl = step1.headers.get("location") || authUrl.toString();
  const loginPage = await fetchWithJar(loginActionUrl, { redirect: "manual" }, jar);
  const html = await loginPage.text();

  const formAction = extractFormAction(html) || loginActionUrl;

  const body = new URLSearchParams({
    username: creds.username,
    password: creds.password,
  });

  const loginRes = await fetchWithJar(formAction, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, jar);

  let location = loginRes.headers.get("location");
  let hops = 0;
  let code: string | null = null;
  while (location && hops < 5) {
    if (location.startsWith(REDIRECT_URI)) {
      code = new URL(location).searchParams.get("code");
      break;
    }
    const next = await fetchWithJar(location, { redirect: "manual" }, jar);
    location = next.headers.get("location");
    hops++;
  }

  if (!code) {
    throw new Error(
      "Somtoday login did not return an authorization code. This usually means your " +
      "school uses an external SSO login page (Microsoft/SURFconext) that this direct " +
      "login flow can't automate, or the username/password/tenant is wrong."
    );
  }

  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  });

  if (!tokenRes.ok) {
    throw new Error(`Somtoday token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }

  const json = await tokenRes.json<{ access_token: string; refresh_token: string; expires_in: number }>();
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
  };
}

async function refresh(refreshToken: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Somtoday token refresh failed: ${res.status} ${await res.text()}`);
  const json = await res.json<{ access_token: string; refresh_token: string; expires_in: number }>();
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
  };
}

/** Get a valid access token, refreshing or logging in as needed, using KV to
 * persist across invocations so we don't re-login every request. */
export async function getAccessToken(kv: KVNamespace, creds: SomtodayCreds): Promise<string> {
  const stored = await kv.get<TokenSet>(KV_KEY, "json");

  if (stored && stored.expires_at - Date.now() > 5 * 60 * 1000) {
    return stored.access_token;
  }

  if (stored?.refresh_token) {
    try {
      const fresh = await refresh(stored.refresh_token);
      await kv.put(KV_KEY, JSON.stringify(fresh));
      return fresh.access_token;
    } catch {
      // refresh_token itself expired/revoked — fall through to full login
    }
  }

  const fresh = await passwordLogin(creds);
  await kv.put(KV_KEY, JSON.stringify(fresh));
  return fresh.access_token;
}

// --- tiny cookie jar + helpers, since Workers' fetch doesn't persist cookies ---

class CookieJar {
  private jar = new Map<string, string>();
  apply(headers: Headers) {
    if (this.jar.size === 0) return;
    headers.set("Cookie", [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "));
  }
  capture(headers: Headers) {
    const setCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const sc of setCookie) {
      const [pair] = sc.split(";");
      const eq = pair.indexOf("=");
      if (eq > -1) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}

async function fetchWithJar(url: string, init: RequestInit, jar: CookieJar): Promise<Response> {
  const headers = new Headers(init.headers);
  jar.apply(headers);
  const res = await fetch(url, { ...init, headers });
  jar.capture(res.headers);
  return res;
}

function extractFormAction(html: string): string | null {
  const m = html.match(/<form[^>]+action="([^"]+)"/i);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}
