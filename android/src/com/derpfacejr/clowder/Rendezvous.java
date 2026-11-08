package com.derpfacejr.clowder;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import java.util.Base64;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Pure rules for the rendezvous. A town posts its current address to a public relay, sealed with a key
 * this device already holds. No android.* imports, so RendezvousCheck runs on a plain JDK.
 */
final class Rendezvous {
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final int KEY_BYTES = 32;
    private static final Pattern ORIGIN = Pattern.compile("https://[A-Za-z0-9.-]+(:[0-9]{1,5})?");
    private static final Pattern TOPIC = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    // ponytail: regex field reads, not a JSON parser. The plaintext and ntfy lines are fixed shapes; a
    // parser would be the larger, riskier path. Swap for a parser if the shapes ever grow.
    private static final Pattern PLAIN_VERSION = Pattern.compile("\"v\"\\s*:\\s*1\\b");
    private static final Pattern PLAIN_ORIGIN = Pattern.compile("\"origin\"\\s*:\\s*\"([^\"\\\\]*)\"");
    private static final Pattern PLAIN_AT = Pattern.compile("\"at\"\\s*:\\s*(\\d{1,18})\\b");
    private static final Pattern EVENT_MESSAGE = Pattern.compile("\"event\"\\s*:\\s*\"message\"");
    private static final Pattern MESSAGE = Pattern.compile("\"message\"\\s*:\\s*\"([A-Za-z0-9_-]+)\"");

    /** The address a town posted, and when. */
    static final class Found {
        final String origin;
        final long at;

        Found(String origin, long at) {
            this.origin = origin;
            this.at = at;
        }
    }

    private Rendezvous() {
    }

    /** Opens one sealed message (iv || ciphertext || tag). Returns null on any failure. */
    static Found open(String sealed, String keyB64url) {
        if (sealed == null || keyB64url == null) {
            return null;
        }
        try {
            byte[] key = Base64.getUrlDecoder().decode(keyB64url);
            byte[] box = Base64.getUrlDecoder().decode(sealed);
            if (key.length != KEY_BYTES || box.length < IV_BYTES + TAG_BITS / 8) {
                return null;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"),
                    new GCMParameterSpec(TAG_BITS, Arrays.copyOfRange(box, 0, IV_BYTES)));
            byte[] plain = cipher.doFinal(box, IV_BYTES, box.length - IV_BYTES);
            return plaintext(new String(plain, StandardCharsets.UTF_8));
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            return null;
        }
    }

    /** The newest valid message in an ndjson poll. Keepalives, garbage and undecryptable lines are skipped. */
    static Found latest(String ndjson, String keyB64url) {
        if (ndjson == null) {
            return null;
        }
        Found best = null;
        for (String line : ndjson.split("\n")) {
            if (!EVENT_MESSAGE.matcher(line).find()) {
                continue;
            }
            Matcher message = MESSAGE.matcher(line);
            if (!message.find()) {
                continue;
            }
            Found found = open(message.group(1), keyB64url);
            if (found != null && (best == null || found.at > best.at)) {
                best = found;
            }
        }
        return best;
    }

    /** https://host[:port] only: no path, query, fragment or user info. */
    static boolean validOrigin(String origin) {
        if (origin == null || !ORIGIN.matcher(origin).matches()) {
            return false;
        }
        int colon = origin.indexOf(':', "https://".length());
        if (colon < 0) {
            return true;
        }
        int port = Integer.parseInt(origin.substring(colon + 1));
        return port >= 1 && port <= 65535;
    }

    /** The ntfy poll URL for a relay (https origin, trailing slash allowed) and topic, or null. */
    static String pollUrl(String relay, String topic) {
        if (relay == null || topic == null || !TOPIC.matcher(topic).matches()) {
            return null;
        }
        String base = relay.endsWith("/") ? relay.substring(0, relay.length() - 1) : relay;
        if (!validOrigin(base)) {
            return null;
        }
        return base + "/" + topic + "/json?poll=1&since=12h";
    }

    private static Found plaintext(String json) {
        if (!PLAIN_VERSION.matcher(json).find()) {
            return null;
        }
        Matcher origin = PLAIN_ORIGIN.matcher(json);
        Matcher at = PLAIN_AT.matcher(json);
        if (!origin.find() || !at.find() || !validOrigin(origin.group(1))) {
            return null;
        }
        return new Found(origin.group(1), Long.parseLong(at.group(1)));
    }
}
