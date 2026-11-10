package com.derpfacejr.clowder;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.OpenableColumns;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * One app for the town. It keeps the town's origin (scheme, host, port) in SharedPreferences and
 * shows the town in a WebView. A new pairing link replaces the saved origin. Once paired, the device
 * keeps its token and follows the town to its new address through the relay when the old one stops answering.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "clowder";
    private static final String KEY_ORIGIN = "origin";
    // The device token and the relay key are kept sealed by Vault. The plain keys are read only to migrate them.
    private static final String KEY_DEVICE = "device.sealed";
    private static final String KEY_DEVICE_PLAIN = "device";
    private static final String KEY_RELAY = "relay";
    private static final String KEY_TOPIC = "topic";
    private static final String KEY_RELAY_KEY = "relayKey.sealed";
    private static final String KEY_RELAY_KEY_PLAIN = "relayKey";
    private static final String DEVICE_COOKIE = "__Host-town_device";
    private static final Pattern DEVICE_TOKEN = Pattern.compile("[0-9a-f]{64}");
    private static final int TIMEOUT_MS = 10_000;
    private static final long LOOKUP_GAP_MS = 20_000;
    // The town's upload cap (src/uploads.ts UPLOAD_CAP): a longer shared file is not read past it or sent.
    private static final int UPLOAD_CAP = 20 * 1024 * 1024;
    private static final int UPLOAD_TIMEOUT_MS = 120_000;
    // The town words its own answers; these are for when it is not asked. TOO_BIG is the town's own wording of the cap.
    private static final String TOO_BIG = "This file is larger than the 20 MB limit.";
    private static final String UNREADABLE = "Clowder could not read that file.";
    private static final String SAVED = "Saved to the gallery: ";

    private SharedPreferences prefs;
    private String origin;
    private String savedDevice;
    private String savedRelayKey;
    private WebView web;
    private ScrollView panel;
    private TextView message;
    private EditText field;
    private Button retry;
    private boolean errorMode;
    private boolean visible;
    private boolean rendezvousDue = true;
    private boolean rendezvousRunning;
    private boolean resumeLookup = true;
    private boolean lookupRunning;
    private long nextLookupAt;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable retryTask = this::retryTown;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        origin = prefs.getString(KEY_ORIGIN, null);
        sealPlain(KEY_DEVICE_PLAIN, KEY_DEVICE);
        sealPlain(KEY_RELAY_KEY_PLAIN, KEY_RELAY_KEY);
        savedDevice = Vault.open(prefs.getString(KEY_DEVICE, null));
        savedRelayKey = Vault.open(prefs.getString(KEY_RELAY_KEY, null));

        if (getActionBar() != null) {
            getActionBar().setBackgroundDrawable(new ColorDrawable(getColor(R.color.cream)));
        }

        web = new WebView(this);
        configureWeb();
        panel = buildPanel();
        FrameLayout stage = new FrameLayout(this);
        stage.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        stage.addView(panel, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(stage);

        Uri incoming = incomingLink(getIntent());
        setIntent(new Intent());
        if (incoming != null) {
            acceptLink(incoming);
        } else if (origin != null) {
            loadTown(origin);
        } else {
            showSetup(R.string.setup_message, false);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri incoming = incomingLink(intent);
        if (incoming != null) {
            acceptLink(incoming);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        visible = false;
        handler.removeCallbacks(retryTask);
        refreshDevice();
        web.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        web.onResume();
        resumeLookup = true;
        refreshDevice();
        if (errorMode && canFollow()) {
            scheduleRetry(0);
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (panel.getVisibility() == View.VISIBLE) {
            if (origin != null && !errorMode) {
                showWeb();
            } else {
                finish();
            }
            return;
        }
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        finish();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.main, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        int id = item.getItemId();
        if (id == R.id.menu_change_link) {
            showSetup(R.string.setup_message, false);
            return true;
        }
        if (id == R.id.menu_reload) {
            if (origin != null) {
                loadTown(origin);
            } else {
                showSetup(R.string.setup_message, false);
            }
            return true;
        }
        if (id == R.id.menu_details) {
            showDetails();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    /** The facts behind "Clowder cannot find my town": the address, the sign-in cookie, the saved token and the relay. */
    private void showDetails() {
        String cookie = origin == null ? null : CookieManager.getInstance().getCookie(origin);
        String text = getString(R.string.details_town, origin == null ? getString(R.string.details_none) : origin) + "\n"
                + getString(R.string.details_cookie, yesNo(deviceToken(cookie) != null)) + "\n"
                + getString(R.string.details_saved, yesNo(savedDevice != null)) + "\n"
                + getString(R.string.details_follow, yesNo(canFollow()));
        new AlertDialog.Builder(this)
                .setTitle(R.string.menu_details)
                .setMessage(text)
                .setPositiveButton(android.R.string.ok, null)
                .show();
    }

    private String yesNo(boolean value) {
        return getString(value ? R.string.yes : R.string.no);
    }

    /** Pulls a pairing link out of a VIEW (https or clowder://open) or SEND (shared text) intent. A SEND with a file uploads it instead. */
    private Uri incomingLink(Intent intent) {
        if (intent == null) {
            return null;
        }
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            Uri link = TownLink.fromDeepLink(intent.getData());
            if (link == null) {
                toast(R.string.bad_link);
            }
            return link;
        }
        if (Intent.ACTION_SEND.equals(action)) {
            // Any app can send this activity anything, so a stream that is not a Uri is ignored rather than cast.
            Object file = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (file instanceof Uri) {
                shareFile((Uri) file);
                return null;
            }
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null) {
                for (String part : text.split("\\s+")) {
                    Uri link = TownLink.parse(part);
                    if (link != null) {
                        return link;
                    }
                }
            }
            toast(R.string.bad_link);
        }
        return null;
    }

    private void acceptLink(Uri link) {
        if (TownLink.isKnownHost(link)) {
            connect(link);
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.confirm_title)
                .setMessage(getString(R.string.confirm_message, link.getHost()))
                .setPositiveButton(R.string.confirm_use, (d, which) -> connect(link))
                .setNegativeButton(R.string.cancel, (d, which) -> restore())
                .setOnCancelListener(d -> restore())
                .show();
    }

    private void restore() {
        if (origin != null) {
            loadTown(origin);
        } else {
            showSetup(R.string.setup_message, false);
        }
    }

    /** Saves the origin, then loads the full link so the #pair= fragment completes pairing. */
    private void connect(Uri link) {
        String next = TownLink.origin(link);
        boolean changed = origin != null && !origin.equals(next);
        origin = next;
        prefs.edit().putString(KEY_ORIGIN, origin).apply();
        rendezvousDue = true;
        field.setText("");
        web.clearHistory();
        web.loadUrl(link.toString());
        showWeb();
        if (changed) {
            toast(R.string.town_updated);
        }
    }

    private void loadTown(String townOrigin) {
        web.loadUrl(townOrigin + "/");
        showWeb();
    }

    private void showWeb() {
        errorMode = false;
        panel.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
    }

    private void showSetup(int messageRes, boolean withRetry) {
        errorMode = withRetry;
        message.setText(messageRes);
        retry.setVisibility(withRetry ? View.VISIBLE : View.GONE);
        web.setVisibility(View.GONE);
        panel.setVisibility(View.VISIBLE);
    }

    private void showError() {
        showSetup(R.string.error_message, true);
    }

    private void connectFromField() {
        Uri link = TownLink.parse(field.getText().toString());
        if (link == null) {
            toast(R.string.bad_link);
            return;
        }
        acceptLink(link);
    }

    /** The town did not load. Looks for its new address when this device can, else shows the plain error. */
    private void townUnreachable() {
        if (!canFollow()) {
            showError();
            return;
        }
        showSetup(R.string.offline_message, true);
        startLookup();
    }

    /** True once this device has a token and the relay details, so it can follow the town. */
    private boolean canFollow() {
        return origin != null && savedDevice != null && hasRelay();
    }

    /** True once the relay, topic and key are saved. */
    private boolean hasRelay() {
        return Rendezvous.pollUrl(prefs.getString(KEY_RELAY, null), prefs.getString(KEY_TOPIC, null)) != null
                && savedRelayKey != null;
    }

    /** Polls the relay on a worker thread, at most once per LOOKUP_GAP_MS. */
    private void startLookup() {
        long now = SystemClock.elapsedRealtime();
        if (lookupRunning) {
            return;
        }
        if (now < nextLookupAt) {
            scheduleRetry(nextLookupAt - now);
            return;
        }
        nextLookupAt = now + LOOKUP_GAP_MS;
        lookupRunning = true;
        String asked = origin;
        String poll = Rendezvous.pollUrl(prefs.getString(KEY_RELAY, null), prefs.getString(KEY_TOPIC, null));
        String key = savedRelayKey;
        new Thread(() -> {
            Reply reply = get(poll, null);
            Rendezvous.Found found = reply.status == HttpURLConnection.HTTP_OK
                    ? Rendezvous.latest(reply.body, key) : null;
            String newer = found != null && !found.origin.equals(asked) ? found.origin : null;
            boolean alive = newer == null && get(asked + "/", null).status == HttpURLConnection.HTTP_OK;
            runOnUiThread(() -> finishLookup(asked, newer, alive));
        }).start();
    }

    private void finishLookup(String asked, String newer, boolean alive) {
        lookupRunning = false;
        if (isDestroyed() || !errorMode || !asked.equals(origin)) {
            return;
        }
        if (newer != null) {
            switchTown(newer);
        } else if (alive) {
            loadTown(origin);
        } else {
            scheduleRetry(LOOKUP_GAP_MS);
        }
    }

    /** Moves this device's cookie to the town's new address, then saves and loads it. */
    private void switchTown(String next) {
        String cookie = DEVICE_COOKIE + "=" + savedDevice
                + "; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000";
        CookieManager cookies = CookieManager.getInstance();
        cookies.setCookie(next, cookie, stored -> {
            cookies.flush();
            if (isDestroyed()) {
                return;
            }
            if (!Boolean.TRUE.equals(stored)) {
                scheduleRetry(LOOKUP_GAP_MS);
                return;
            }
            origin = next;
            prefs.edit().putString(KEY_ORIGIN, next).apply();
            web.clearHistory();
            toast(R.string.town_updated);
            loadTown(next);
        });
    }

    private void retryTown() {
        if (errorMode && canFollow()) {
            startLookup();
        }
    }

    private void scheduleRetry(long delayMs) {
        if (!visible) {
            return;
        }
        handler.removeCallbacks(retryTask);
        handler.postDelayed(retryTask, delayMs);
    }

    /** A page of the town finished or changed history. Keeps the saved token current. */
    private void townPageSeen(String url) {
        if (url != null && isTown(Uri.parse(url))) {
            refreshDevice();
        }
    }

    /** Saves the device token when the town set a new one, then fetches the relay details if they are due. */
    private void refreshDevice() {
        if (origin == null) {
            return;
        }
        String token = deviceToken(CookieManager.getInstance().getCookie(origin));
        if (token != null && !token.equals(savedDevice)) {
            String sealed = Vault.seal(token);
            if (sealed != null) {
                prefs.edit().putString(KEY_DEVICE, sealed).apply();
            }
            savedDevice = token;
        }
        String device = savedDevice;
        if (device == null || rendezvousRunning) {
            return;
        }
        // Once per resume, the relay details are asked for again while they are missing, even when not due.
        boolean retryMissing = resumeLookup && !hasRelay();
        resumeLookup = false;
        if (!rendezvousDue && !retryMissing) {
            return;
        }
        rendezvousDue = false;
        rendezvousRunning = true;
        String asked = origin;
        new Thread(() -> {
            Reply reply = get(asked + "/api/remote/rendezvous", device);
            runOnUiThread(() -> finishRendezvous(asked, reply));
        }).start();
    }

    private void finishRendezvous(String asked, Reply reply) {
        rendezvousRunning = false;
        if (isDestroyed() || !asked.equals(origin)) {
            return;
        }
        if (reply.status == HttpURLConnection.HTTP_NOT_FOUND) {
            prefs.edit().remove(KEY_RELAY).remove(KEY_TOPIC).remove(KEY_RELAY_KEY).apply();
            savedRelayKey = null;
        } else if (reply.status == HttpURLConnection.HTTP_OK) {
            saveRelay(reply.body);
        } else {
            // No answer (offline), or a tunnel or server error: due again on the next page or resume.
            rendezvousDue = true;
        }
    }

    private void saveRelay(String body) {
        try {
            JSONObject info = new JSONObject(body);
            String relay = info.getString("relay");
            String topic = info.getString("topic");
            String key = info.getString("key");
            String sealed = key.isEmpty() ? null : Vault.seal(key);
            if (Rendezvous.pollUrl(relay, topic) != null && sealed != null) {
                prefs.edit().putString(KEY_RELAY, relay).putString(KEY_TOPIC, topic)
                        .putString(KEY_RELAY_KEY, sealed).apply();
                savedRelayKey = key;
            }
        } catch (JSONException e) {
            // Keep the details already saved.
        }
    }

    /**
     * Moves a value saved in plain prefs by an older version into its sealed key. The plain copy is removed
     * only after the sealed copy is on disk and opens to the same value; on any failure it stays for the next start.
     */
    private void sealPlain(String plainKey, String sealedKey) {
        String plain = prefs.getString(plainKey, null);
        if (plain == null) {
            return;
        }
        // A sealed value that already opens was written after the plain one, so it wins.
        if (Vault.open(prefs.getString(sealedKey, null)) == null) {
            String sealed = Vault.seal(plain);
            if (sealed == null || !prefs.edit().putString(sealedKey, sealed).commit()
                    || !plain.equals(Vault.open(prefs.getString(sealedKey, null)))) {
                return;
            }
        }
        prefs.edit().remove(plainKey).commit();
    }

    private boolean isTown(Uri url) {
        return "https".equals(url.getScheme()) && url.getHost() != null
                && origin != null && origin.equals(TownLink.origin(url));
    }

    /** The device token out of a Cookie header string, or null unless it is 64 lower-case hex. */
    private static String deviceToken(String cookies) {
        if (cookies == null) {
            return null;
        }
        for (String part : cookies.split(";")) {
            String pair = part.trim();
            if (pair.startsWith(DEVICE_COOKIE + "=")) {
                String token = pair.substring(DEVICE_COOKIE.length() + 1);
                return DEVICE_TOKEN.matcher(token).matches() ? token : null;
            }
        }
        return null;
    }

    /** One GET on a worker thread. The body comes back only for a 200. Status -1 means no answer. */
    private static Reply get(String url, String device) {
        if (url == null) {
            return new Reply(-1, null);
        }
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            // A request that carries the device cookie never follows a redirect to another host.
            conn.setInstanceFollowRedirects(device == null);
            if (device != null) {
                conn.setRequestProperty("Cookie", DEVICE_COOKIE + "=" + device);
            }
            int status = conn.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                return new Reply(status, null);
            }
            return new Reply(status, readText(conn.getInputStream()));
        } catch (IOException e) {
            return new Reply(-1, null);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    /**
     * A file shared from another app (plan 11.22) goes to the town's owner upload route on a worker thread, with this device's
     * cookie. The town decides: a viewer device is refused there, and the town's own words are shown. Only content:// is read.
     */
    private void shareFile(Uri file) {
        String town = origin;
        String device = savedDevice != null ? savedDevice
                : town == null ? null : deviceToken(CookieManager.getInstance().getCookie(town));
        if (town == null || device == null) {
            toast(R.string.setup_message);
            return;
        }
        if (!"content".equals(file.getScheme())) {
            return;
        }
        new Thread(() -> {
            String said = upload(town, device, file);
            runOnUiThread(() -> Toast.makeText(this, said, Toast.LENGTH_LONG).show());
        }).start();
    }

    /** Reads the shared file, never past UPLOAD_CAP, and posts it. Returns what to tell the owner: the town's own words when it answered. */
    private String upload(String town, String device, Uri file) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (InputStream in = getContentResolver().openInputStream(file)) {
            if (in == null) {
                return UNREADABLE;
            }
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) != -1) {
                bytes.write(buffer, 0, n);
                if (bytes.size() > UPLOAD_CAP) {
                    return TOO_BIG;
                }
            }
        } catch (IOException | SecurityException e) {
            return UNREADABLE;
        }
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(town + "/api/uploads").openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(UPLOAD_TIMEOUT_MS);
            // A request that carries the device cookie never follows a redirect to another host.
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(bytes.size());
            conn.setRequestProperty("Cookie", DEVICE_COOKIE + "=" + device);
            // The tunnel gateway takes a write only with the town's own Origin and the action header, as the town page sends them.
            conn.setRequestProperty("Origin", town);
            conn.setRequestProperty("X-Town-Action", "owner");
            conn.setRequestProperty("Content-Type", "application/octet-stream");
            // The name is a title only; the town stores the file under its own id.
            conn.setRequestProperty("X-File-Name", URLEncoder.encode(displayName(file), "UTF-8").replace("+", "%20"));
            try (OutputStream out = conn.getOutputStream()) {
                bytes.writeTo(out);
            }
            int status = conn.getResponseCode();
            InputStream body = status < 400 ? conn.getInputStream() : conn.getErrorStream();
            JSONObject reply = new JSONObject(body == null ? "{}" : readText(body));
            return status == HttpURLConnection.HTTP_OK ? SAVED + reply.optString("title")
                    : reply.optString("error", getString(R.string.offline_message));
        } catch (IOException | JSONException e) {
            return getString(R.string.offline_message);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    /** The shared file's name as the sending app gives it. */
    private String displayName(Uri file) {
        try (Cursor row = getContentResolver().query(file, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (row != null && row.moveToFirst() && !row.isNull(0)) {
                return row.getString(0);
            }
        } catch (RuntimeException e) {
            // A provider without the column: the last path segment below.
        }
        String last = file.getLastPathSegment();
        return last == null || last.isEmpty() ? "Shared file" : last;
    }

    private static String readText(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream stream = in) {
            byte[] buffer = new byte[4096];
            int n;
            while ((n = stream.read(buffer)) != -1) {
                out.write(buffer, 0, n);
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static final class Reply {
        final int status;
        final String body;

        Reply(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    private void configureWeb() {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setSupportMultipleWindows(false);
        // Lets the town page know it is inside this app, so it hides "Get the Android app".
        // The page also checks for ClowderAndroid, so both tokens stay.
        settings.setUserAgentString(settings.getUserAgentString() + " ClowderAndroid ClowderApp");
        // WebView remote debugging is never enabled in this app.

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new TownClient());
    }

    private void openOutside(Uri url) {
        Intent intent = new Intent(Intent.ACTION_VIEW, url);
        if ("https".equals(url.getScheme()) || "http".equals(url.getScheme())) {
            // Pick a browser explicitly, so a link to another town address does not reopen this app.
            intent.setSelector(new Intent(Intent.ACTION_VIEW)
                    .addCategory(Intent.CATEGORY_BROWSABLE)
                    .setData(Uri.parse("http://")));
        }
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            toast(R.string.no_app_for_link);
        }
    }

    private final class TownClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (isTown(url)) {
                return false;
            }
            String scheme = url.getScheme();
            if ("https".equals(scheme) || "http".equals(scheme) || "mailto".equals(scheme) || "tel".equals(scheme)) {
                openOutside(url);
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            townPageSeen(url);
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            townPageSeen(url);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                townUnreachable();
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            // A closed tunnel can answer with a Cloudflare 5xx page instead of a network error. A 404 counts
            // only for the town's root, so a missing page inside the town does not show the offline screen.
            if (!request.isForMainFrame()) {
                return;
            }
            int status = response.getStatusCode();
            boolean root = "/".equals(request.getUrl().getPath());
            if (status >= 500 || (status == HttpURLConnection.HTTP_NOT_FOUND && root)) {
                townUnreachable();
            }
        }
    }

    private ScrollView buildPanel() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(getColor(R.color.cream));
        scroll.setFillViewport(true);

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        int pad = dp(24);
        column.setPadding(pad, dp(36), pad, pad);
        scroll.addView(column, new ScrollView.LayoutParams(ScrollView.LayoutParams.MATCH_PARENT,
                ScrollView.LayoutParams.WRAP_CONTENT));

        ImageView icon = new ImageView(this);
        icon.setImageResource(R.mipmap.ic_launcher);
        column.addView(icon, new LinearLayout.LayoutParams(dp(96), dp(96)));

        TextView title = new TextView(this);
        title.setText(R.string.app_name);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        title.setTypeface(null, Typeface.BOLD);
        title.setTextColor(getColor(R.color.ink));
        title.setGravity(Gravity.CENTER);
        column.addView(title, matchWidth(dp(8)));

        message = new TextView(this);
        message.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        message.setTextColor(getColor(R.color.ink));
        message.setGravity(Gravity.CENTER);
        column.addView(message, matchWidth(dp(12)));

        field = new EditText(this);
        field.setHint(R.string.paste_hint);
        field.setSingleLine(true);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setImeOptions(EditorInfo.IME_ACTION_GO);
        field.setTextColor(getColor(R.color.ink));
        field.setBackground(rounded(getColor(R.color.field), getColor(R.color.outline)));
        field.setPadding(dp(14), dp(12), dp(14), dp(12));
        field.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO) {
                connectFromField();
                return true;
            }
            return false;
        });
        column.addView(field, matchWidth(dp(24)));

        Button connect = button(R.string.connect);
        connect.setOnClickListener(v -> connectFromField());
        column.addView(connect, matchWidth(dp(12)));

        retry = button(R.string.retry);
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(v -> {
            if (origin != null) {
                loadTown(origin);
            }
        });
        column.addView(retry, matchWidth(dp(12)));

        return scroll;
    }

    private Button button(int textRes) {
        Button button = new Button(this);
        button.setText(textRes);
        button.setAllCaps(false);
        button.setTextColor(getColor(R.color.cream));
        button.setBackground(rounded(getColor(R.color.green), 0));
        return button;
    }

    private GradientDrawable rounded(int fill, int stroke) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(12));
        if (stroke != 0) {
            drawable.setStroke(dp(1), stroke);
        }
        return drawable;
    }

    private LinearLayout.LayoutParams matchWidth(int topMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = topMargin;
        return params;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                getResources().getDisplayMetrics()));
    }

    private void toast(int textRes) {
        Toast.makeText(this, textRes, Toast.LENGTH_LONG).show();
    }
}
