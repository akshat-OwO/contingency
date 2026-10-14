package dev.contingency.privatetext;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/**
 * Enters one private value into one bound field, then exits.
 *
 * The value arrives over an authenticated loopback socket, never as an
 * instrumentation argument. Nothing here logs: request bodies, values, and
 * exception details stay inside this process.
 */
public final class PrivateText extends Instrumentation {
    static final String PROTOCOL = "contingency-private-text-v1";
    private static final int ACCEPT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 10_000;
    private static final int MAX_REQUEST_BYTES = 16_384;
    private static final int MAX_DEPTH = 128;
    private static final int MAX_NODES = 5_000;

    private String token = "";
    private String target = "";

    private static final class Failure extends Exception {
        final String code;
        Failure(String code) { super(code, null, false, false); this.code = code; }
    }

    @Override public void onCreate(Bundle arguments) {
        token = arguments.getString("token", "");
        target = arguments.getString("target", "");
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        result.putString("protocol", PROTOCOL);
        if (token.length() < 32 || target.isEmpty()) {
            result.putString("error", "request_invalid");
            finish(1, result);
            return;
        }
        UiAutomation automation = null;
        try {
            // Keep the user's own accessibility services running.
            automation = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        } catch (RuntimeException busy) {
            // Android permits one UiAutomation connection; another helper holds it.
        }
        if (automation == null) {
            result.putString("error", "automation_busy");
            finish(1, result);
            return;
        }
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            server.setSoTimeout(ACCEPT_TIMEOUT_MS);
            Bundle ready = new Bundle();
            ready.putString("protocol", PROTOCOL);
            ready.putString("port", String.valueOf(server.getLocalPort()));
            sendStatus(0, ready);
            try (Socket socket = server.accept()) {
                socket.setSoTimeout(READ_TIMEOUT_MS);
                serve(socket, automation);
            }
        } catch (Exception closed) {
            result.putString("error", "transport_failed");
        }
        finish(0, result);
    }

    private void serve(Socket socket, UiAutomation automation) throws Exception {
        InputStream input = socket.getInputStream();
        OutputStream output = socket.getOutputStream();
        boolean[] sent = { false };
        String id = "";
        JSONObject response = new JSONObject().put("protocol", PROTOCOL);
        try {
            JSONObject bind = new JSONObject(readLine(input));
            id = bind.optString("id");
            authorize(bind, "bind");
            Binding binding = new Binding(bind.getJSONObject("target"));
            // The value crosses to the device only after the bound field is found.
            // Bind fixes the window: fill refuses any other window, even from the same app.
            binding.find(automation, target).recycle();
            write(output, new JSONObject().put("protocol", PROTOCOL).put("id", id).put("bound", true));
            JSONObject fill = new JSONObject(readLine(input));
            id = fill.optString("id");
            authorize(fill, "fill");
            fill(automation, binding, fill.getString("value"), sent);
            response.put("outcome", "verified");
        } catch (Failure failure) {
            response.put("error", failure.code);
        } catch (Exception failure) {
            response.put("error", sent[0] ? "input_failed" : "request_invalid");
        }
        write(output, response.put("id", id).put("inputSent", sent[0]));
    }

    private void authorize(JSONObject request, String op) throws Failure {
        if (!PROTOCOL.equals(request.optString("protocol"))) throw new Failure("protocol_incompatible");
        if (!MessageDigest.isEqual(
                token.getBytes(StandardCharsets.UTF_8),
                request.optString("token").getBytes(StandardCharsets.UTF_8))) {
            throw new Failure("unauthorized");
        }
        if (!op.equals(request.optString("op"))) throw new Failure("request_invalid");
    }

    private static void write(OutputStream output, JSONObject message) throws Exception {
        output.write((message.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        output.flush();
    }

    private static String readLine(InputStream input) throws Exception {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        for (int c; (c = input.read()) != -1;) {
            if (c == '\n') return line.toString(StandardCharsets.UTF_8.name());
            if (line.size() >= MAX_REQUEST_BYTES) throw new Failure("request_invalid");
            line.write(c);
        }
        throw new Failure("request_invalid");
    }

    private static void fill(UiAutomation automation, Binding binding, String value, boolean[] sent) throws Exception {
        // Re-resolve immediately before input: the field may have changed since bind.
        AccessibilityNodeInfo node = binding.find(automation, binding.packageName);
        if (node.getWindowId() != binding.windowId) throw new Failure("window_changed");
        try {
            Bundle arguments = new Bundle();
            arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
            // From here the value may have reached the field. The host never retries.
            sent[0] = true;
            if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) throw new Failure("input_failed");
            if (!node.refresh()) throw new Failure("input_unverified");
            CharSequence text = node.getText();
            if (text == null || !value.contentEquals(text)) throw new Failure("input_unverified");
        } finally {
            node.recycle();
        }
    }

    /** One editable field, identified by the observation that bound it. */
    private static final class Binding {
        final String packageName;
        final String resourceId;
        final String className;
        final Rect bounds;
        final boolean password;
        int windowId = -1;

        Binding(JSONObject target) throws Exception {
            packageName = target.getString("package");
            resourceId = target.isNull("resourceId") ? null : target.getString("resourceId");
            className = target.getString("className");
            JSONArray edges = target.getJSONArray("bounds");
            bounds = new Rect(edges.getInt(0), edges.getInt(1), edges.getInt(2), edges.getInt(3));
            password = target.getBoolean("password");
        }

        AccessibilityNodeInfo find(UiAutomation automation, String app) throws Failure {
            if (!packageName.equals(app)) throw new Failure("field_mismatch");
            AccessibilityNodeInfo root = automation.getRootInActiveWindow();
            if (root == null || root.getPackageName() == null || !app.contentEquals(root.getPackageName())) {
                throw new Failure("foreground_changed");
            }
            if (windowId == -1) {
                windowId = root.getWindowId();
            } else if (root.getWindowId() != windowId) {
                throw new Failure("window_changed");
            }
            List<AccessibilityNodeInfo> matches = new ArrayList<>();
            collect(root, matches, 0, new int[] { 0 });
            if (matches.size() != 1) throw new Failure("field_mismatch");
            AccessibilityNodeInfo node = matches.get(0);
            if (!node.isEnabled() || !node.isVisibleToUser()) throw new Failure("field_mismatch");
            return node;
        }

        private void collect(AccessibilityNodeInfo node, List<AccessibilityNodeInfo> matches, int depth, int[] visited)
                throws Failure {
            if (depth > MAX_DEPTH || ++visited[0] > MAX_NODES) throw new Failure("field_mismatch");
            Rect actual = new Rect();
            node.getBoundsInScreen(actual);
            String id = node.getViewIdResourceName();
            if (node.isEditable()
                    && actual.equals(bounds)
                    && className.contentEquals(String.valueOf(node.getClassName()))
                    && (resourceId == null ? id == null : resourceId.equals(id))
                    && node.isPassword() == password) {
                matches.add(node);
            }
            for (int i = 0; i < node.getChildCount(); i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) collect(child, matches, depth + 1, visited);
            }
        }
    }
}
