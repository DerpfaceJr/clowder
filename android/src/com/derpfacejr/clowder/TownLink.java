package com.derpfacejr.clowder;

import android.net.Uri;

import java.util.Locale;

/** Pure link rules: which pairing links Clowder accepts and how a town origin is derived from them. */
final class TownLink {
    private TownLink() {
    }

    /** Parses typed or shared text into an https link, or returns null. */
    static Uri parse(String raw) {
        if (raw == null) {
            return null;
        }
        Uri uri = Uri.parse(raw.trim());
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getHost().isEmpty()) {
            return null;
        }
        return uri;
    }

    /** Reads an incoming VIEW link: https as-is, or clowder://open?url=<encoded https link>. */
    static Uri fromDeepLink(Uri data) {
        if (data == null) {
            return null;
        }
        if ("clowder".equalsIgnoreCase(data.getScheme())) {
            return parse(data.getQueryParameter("url"));
        }
        return parse(data.toString());
    }

    /** True for the hosts the app connects to without asking: *.trycloudflare.com and *.ts.net. */
    static boolean isKnownHost(Uri uri) {
        String host = uri.getHost();
        return host != null && (host.endsWith(".trycloudflare.com") || host.endsWith(".ts.net"));
    }

    /** scheme://host[:port], lower-cased host. The fragment and path are dropped. */
    static String origin(Uri uri) {
        StringBuilder out = new StringBuilder(uri.getScheme().toLowerCase(Locale.ROOT))
                .append("://")
                .append(uri.getHost().toLowerCase(Locale.ROOT));
        if (uri.getPort() != -1) {
            out.append(':').append(uri.getPort());
        }
        return out.toString();
    }
}
