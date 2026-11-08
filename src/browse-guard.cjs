'use strict';
// The cats' browser's page guard (security pass H2), loaded by the Playwright MCP server with --init-page for each tab of a browse run
// (tool-runtimes.ts). A top-level page on this computer or its LAN never opens: the navigation is stopped before its request, and a redirect
// that got there anyway (Playwright's origin filter does not see redirects) is sent on to about:blank. Navigation rule for Always allow: a run
// that skipped its card under a site's Always allow (CLOWDER_BROWSE_SITE) is held to that site and its subdomains the same way, so moving
// off the site never widens what the owner allowed. Pages on the site may still load scripts and images from other hosts. A run the owner
// allowed on its card goes where its task leads, except this computer and the LAN.
const lan = (process.env.CLOWDER_BROWSE_LAN || '').split(';').filter(Boolean);
const site = process.env.CLOWDER_BROWSE_SITE || '';

function allowed(url, o = {lan, site}) {
  let u;
  try { u = new URL(url); } catch { return true; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '0.0.0.0' || h === '[::1]' || h.startsWith('[::ffff:7f') || o.lan.includes(h)) return false;
  return !o.site || h === o.site || h.endsWith('.' + o.site);
}

module.exports = async ({page}) => {
  await page.route('**', route => {
    const r = route.request();
    return r.isNavigationRequest() && r.frame() === page.mainFrame() && !allowed(r.url()) ? route.abort('blockedbyclient') : route.fallback();
  });
  page.on('framenavigated', frame => { if (frame === page.mainFrame() && !allowed(frame.url())) page.goto('about:blank').catch(() => {}); });
};
module.exports.allowed = allowed;
