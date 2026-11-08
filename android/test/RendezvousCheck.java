package com.derpfacejr.clowder;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Plain-JDK self-check for Rendezvous. Not part of the APK (lives outside android/src).
 * Compile with Rendezvous.java; run the class from the output directory. Exits 1 on any failure.
 */
public final class RendezvousCheck {
    private static final String KEY = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
    private static final String SEALED = "oKGio6SlpqeoqaqrwvNLRMeEdiYQfMsMmOsCvnW_xG0oG1qrCD6tnD8-tFAfpeuxjL7fQUkQrPjUU2BEdttS6O76ivdy1bTJ8QQ_W5x3ktSeGzEEox7oPxes_OJFGs1vjvLt";
    private static final String ORIGIN = "https://example.trycloudflare.com";
    private static final long AT = 1793283051000L;
    private static final String TOPIC = "clowder-0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final String RELAY = "https://ntfy.sh";

    private static int failures;

    public static void main(String[] args) throws Exception {
        String wrongKey = Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]);

        Rendezvous.Found known = Rendezvous.open(SEALED, KEY);
        check(known != null && ORIGIN.equals(known.origin) && known.at == AT, "known-answer vector");
        check(Rendezvous.open(flipByte(SEALED, 20), KEY) == null, "flipped byte gives null");
        check(Rendezvous.open(SEALED, wrongKey) == null, "wrong key gives null");
        check(Rendezvous.open(SEALED, "AAAA") == null, "short key gives null");
        check(Rendezvous.open("AAAA", KEY) == null, "short sealed gives null");
        check(Rendezvous.open(seal("{\"v\":1,\"origin\":\"http://example.com\",\"at\":5}", KEY), KEY) == null,
                "http origin inside a valid seal gives null");
        check(Rendezvous.open(seal("{\"v\":2,\"origin\":\"" + ORIGIN + "\",\"at\":5}", KEY), KEY) == null,
                "version 2 gives null");

        String older = seal("{\"v\":1,\"origin\":\"https://old.trycloudflare.com\",\"at\":100}", KEY);
        String newer = seal("{\"v\":1,\"origin\":\"" + ORIGIN + "\",\"at\":200}", KEY);
        String ndjson = "{\"id\":\"k1\",\"time\":1,\"event\":\"keepalive\"}\n"
                + "{\"id\":\"m1\",\"time\":2,\"event\":\"message\",\"topic\":\"" + TOPIC + "\",\"message\":\"" + older + "\"}\n"
                + "{\"id\":\"m2\",\"time\":3,\"event\":\"message\",\"topic\":\"" + TOPIC + "\",\"message\":\"" + newer + "\"}\n"
                + "not json at all\n";
        Rendezvous.Found picked = Rendezvous.latest(ndjson, KEY);
        check(picked != null && ORIGIN.equals(picked.origin) && picked.at == 200, "latest picks the newest message");
        check(Rendezvous.latest("{\"event\":\"keepalive\"}\n", KEY) == null, "latest with no messages gives null");
        check(Rendezvous.latest(null, KEY) == null, "latest of null gives null");

        check(Rendezvous.validOrigin(ORIGIN), "validOrigin accepts a trycloudflare origin");
        check(Rendezvous.validOrigin("https://town.example:8443"), "validOrigin accepts a port");
        check(!Rendezvous.validOrigin("http://example.trycloudflare.com"), "validOrigin rejects http");
        check(!Rendezvous.validOrigin(ORIGIN + "/"), "validOrigin rejects a trailing slash");
        check(!Rendezvous.validOrigin(ORIGIN + "/path"), "validOrigin rejects a path");
        check(!Rendezvous.validOrigin(ORIGIN + "?q=1"), "validOrigin rejects a query");
        check(!Rendezvous.validOrigin(ORIGIN + "#f"), "validOrigin rejects a fragment");
        check(!Rendezvous.validOrigin("https://town.example:0"), "validOrigin rejects port 0");
        check(!Rendezvous.validOrigin(null), "validOrigin rejects null");

        check(("https://ntfy.sh/" + TOPIC + "/json?poll=1&since=12h").equals(Rendezvous.pollUrl(RELAY, TOPIC)),
                "pollUrl builds the poll URL");
        check(Rendezvous.pollUrl("http://ntfy.sh", TOPIC) == null, "pollUrl rejects an http relay");
        check(Rendezvous.pollUrl(RELAY, "bad topic!") == null, "pollUrl rejects a bad topic");
        check(Rendezvous.pollUrl(RELAY, "") == null, "pollUrl rejects an empty topic");
        check(Rendezvous.pollUrl(RELAY, "a".repeat(65)) == null, "pollUrl rejects a 65-character topic");
        check(Rendezvous.pollUrl("https://ntfy.sh/x", TOPIC) == null, "pollUrl rejects a relay with a path");

        if (failures > 0) {
            System.out.println("FAIL RendezvousCheck: " + failures + " check(s) failed");
            System.exit(1);
        }
        System.out.println("OK RendezvousCheck: known-answer, tamper, key, latest, validOrigin and pollUrl checks passed");
    }

    private static void check(boolean ok, String name) {
        if (!ok) {
            failures++;
            System.out.println("FAIL " + name);
        }
    }

    private static String seal(String plain, String keyB64url) throws Exception {
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(Base64.getUrlDecoder().decode(keyB64url), "AES"),
                new GCMParameterSpec(128, iv));
        byte[] body = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        byte[] out = new byte[iv.length + body.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(body, 0, out, iv.length, body.length);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(out);
    }

    private static String flipByte(String sealed, int index) {
        byte[] box = Base64.getUrlDecoder().decode(sealed);
        box[index] ^= 0x01;
        return Base64.getUrlEncoder().withoutPadding().encodeToString(box);
    }
}
