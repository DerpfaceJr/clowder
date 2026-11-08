// The Instagram professional accounts a Facebook login token reaches through its Pages, so Clowder can set up one Instagram
// connector per account without the owner copying ids. Only graph.facebook.com is called, always with explicit fields, so no Page
// token ever comes back, and the token never appears in an error.
export type InstagramAccount = {id: string; username: string; page: string};
/** Why a token reaches no account: how many Pages it reaches, and the permissions Facebook has not granted it that listing needs. */
export type InstagramGaps = {pages: number; missing: string[]};

export const INSTAGRAM_TOKEN = 'INSTAGRAM_ACCESS_TOKEN', INSTAGRAM_ID = 'INSTAGRAM_ACCOUNT_ID';
/** A connector whose settings name both an Instagram token and an account id is an Instagram connector. */
export const isInstagramConnector = (vars: string[]) => vars.includes(INSTAGRAM_TOKEN) && vars.includes(INSTAGRAM_ID);

async function graphBody(path: string, token: string, fetchImpl: typeof fetch, version: string): Promise<any> {
  const v = /^v\d{1,2}\.\d$/.test(version) ? version : 'v22.0';
  const res = await fetchImpl(`https://graph.facebook.com/${v}/${path}`, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(15_000)});
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    const said = String(body?.error?.message ?? `HTTP ${res.status}`).split(token).join('[hidden]').slice(0, 200);
    throw new Error(`Facebook did not list your accounts: ${said}`);
  }
  return body;
}
const graph = async (path: string, token: string, fetchImpl: typeof fetch, version: string): Promise<any[]> => {
  const body = await graphBody(path, token, fetchImpl, version);
  return Array.isArray(body?.data) ? body.data : [];
};

export async function instagramAccounts(token: string, fetchImpl: typeof fetch = fetch, version = 'v22.0'): Promise<InstagramAccount[]> {
  const pages = await graph(`me/accounts?fields=${encodeURIComponent('name,instagram_business_account{id,username}')}&limit=100`, token, fetchImpl, version);
  return pages.flatMap((p: any) => {
    const ig = p?.instagram_business_account;
    return typeof ig?.id === 'string' && /^\d{5,25}$/.test(ig.id) && typeof ig.username === 'string' && /^[A-Za-z0-9._]{1,30}$/.test(ig.username)
      ? [{id: ig.id, username: ig.username, page: String(p.name ?? '').slice(0, 100)}] : [];
  });
}

/** Listing Pages needs pages_show_list; reading their Instagram account needs instagram_basic; Pages a business portfolio owns are only
 *  listed with business_management, so that one is named only when no Page came back. */
export async function instagramGaps(token: string, fetchImpl: typeof fetch = fetch, version = 'v22.0'): Promise<InstagramGaps> {
  const [pages, perms] = await Promise.all([graph('me/accounts?fields=id&limit=100', token, fetchImpl, version), graph('me/permissions', token, fetchImpl, version)]);
  const granted = new Set(perms.filter((p: any) => p?.status === 'granted').map((p: any) => String(p.permission)));
  const needed = ['pages_show_list', 'instagram_basic', ...(pages.length ? [] : ['business_management'])];
  return {pages: pages.length, missing: needed.filter(p => !granted.has(p))};
}

/** When the token stops working, from Graph debug_token (expires_at in seconds; 0 means never), or null when Facebook does not say. The token
 *  inspects itself, which Facebook allows for the app's own developer; for anyone else this is null and no expiry warning comes (UNRESOLVED). */
export async function instagramTokenExpiry(token: string, fetchImpl: typeof fetch = fetch, version = 'v22.0'): Promise<number | null> {
  try {
    const at = (await graphBody(`debug_token?input_token=${encodeURIComponent(token)}`, token, fetchImpl, version))?.data?.expires_at;
    return typeof at === 'number' && at > 0 ? at * 1000 : null;
  } catch { return null; }
}
