package dev.contingency.probe;

import android.app.Instrumentation;
import android.os.Bundle;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.util.Base64;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Isolated feasibility helper. Never logs request bodies or exception details. */
public final class Probe extends Instrumentation {
    private UiDevice device;
    private String token, target, session;
    private String observation = "", signature = "", imageHash = "";
    private boolean stopped, failCaptureOnce;
    private Set<String> targets = new HashSet<>();

    @Override public void onCreate(Bundle arguments) {
        token = arguments.getString("token", "");
        target = arguments.getString("target", "");
        session = UUID.randomUUID().toString();
        start();
    }
    @Override public void onStart() {
        if (token.length() < 32 || target.isEmpty()) { finish(1, new Bundle()); return; }
        device = UiDevice.getInstance(this);
        try (ServerSocket server = new ServerSocket(8765, 1, InetAddress.getByName("127.0.0.1"))) {
            Bundle ready = new Bundle(); ready.putString("ready", "true"); sendStatus(0, ready);
            while (!stopped) {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(15000);
                    BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                    String line = readRequest(reader);
                    if (line == null || line.length() > 65536) { invalidate(); continue; }
                    JSONObject request = new JSONObject(line);
                    JSONObject response = new JSONObject().put("id", request.optString("id")).put("session", session).put("version", 1);
                    try {
                        if (!token.equals(request.optString("token"))) throw new Failure("unauthorized");
                        response.put("result", handle(request));
                    } catch (Failure failure) {
                        invalidate(); response.put("error", failure.code);
                    } catch (Exception failure) {
                        invalidate(); response.put("error", "helper_failed");
                    }
                    socket.getOutputStream().write((response.toString() + "\n").getBytes(StandardCharsets.UTF_8));
                } catch (Exception failure) { invalidate(); }
            }
        } catch (Exception failure) { invalidate(); }
        finish(0, new Bundle());
    }
    private String readRequest(Reader reader) throws Exception {
        StringBuilder line = new StringBuilder();
        for (int c; (c = reader.read()) != -1;) {
            if (c == '\n') return line.toString();
            if (line.length() >= 65536) throw new Failure("request_limit");
            line.append((char)c);
        }
        return null;
    }
    private void invalidate() { observation = ""; targets.clear(); }
    private static final class Failure extends Exception {
        final String code;
        Failure(String code) { this.code = code; }
    }
    private void owner() throws Exception {
        AccessibilityNodeInfo root = getUiAutomation().getRootInActiveWindow();
        if (root == null || root.getPackageName() == null) throw new Failure("ownership_ambiguous");
        String foreground = root.getPackageName().toString();
        root.recycle();
        // System dialogs deliberately fail closed until their purpose can be classified.
        if (!target.equals(foreground) || !target.equals(device.getCurrentPackageName())) throw new Failure("ownership_denied");
    }
    private String fingerprint() throws Exception {
        return hash(nodes(true).toString().getBytes(StandardCharsets.UTF_8));
    }
    private JSONArray nodes() throws Exception { return nodes(false); }
    private JSONArray nodes(boolean internal) throws Exception {
        JSONArray result = new JSONArray();
        AccessibilityNodeInfo root = getUiAutomation().getRootInActiveWindow();
        if (root == null) throw new Failure("capture_failed");
        walk(root, result, 0, internal);
        return result;
    }
    private void walk(AccessibilityNodeInfo node, JSONArray result, int depth, boolean internal) throws Exception {
        try {
            if (depth > 64 || result.length() > 2000) throw new Failure("capture_limit");
            String id = node.getViewIdResourceName();
            Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
            // Never export text/content descriptions: target apps can mirror private input anywhere.
            JSONObject record = new JSONObject().put("target", id == null ? "" : id)
                .put("role", String.valueOf(node.getClassName())).put("editable", node.isEditable())
                .put("clickable", node.isClickable()).put("enabled", node.isEnabled())
                .put("bounds", new JSONArray(new int[]{bounds.left, bounds.top, bounds.right, bounds.bottom}));
            if (internal) record.put("text", String.valueOf(node.getText())).put("description", String.valueOf(node.getContentDescription()));
            result.put(record);
            for (int i = 0; i < node.getChildCount(); i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) walk(child, result, depth + 1, internal);
            }
        } finally { node.recycle(); }
    }
    private void fill(String id, String value) throws Exception {
        AccessibilityNodeInfo root = getUiAutomation().getRootInActiveWindow();
        if (root == null) throw new Failure("ownership_ambiguous");
        List<AccessibilityNodeInfo> matches = root.findAccessibilityNodeInfosByViewId(id);
        try {
            if (matches.size() != 1) throw new Failure("target_ambiguous");
            AccessibilityNodeInfo node = matches.get(0);
            if (!node.isEditable() || !node.isEnabled()) throw new Failure("input_failed");
            Bundle arguments = new Bundle();
            arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
            if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) throw new Failure("input_failed");
            if (!node.refresh() || !value.contentEquals(node.getText() == null ? "" : node.getText())) throw new Failure("input_unverified");
        } finally { for (AccessibilityNodeInfo node : matches) node.recycle(); root.recycle(); }
    }
    private byte[] screenshot() throws Exception {
        if (failCaptureOnce) { failCaptureOnce = false; throw new Failure("capture_failed"); }
        Bitmap image = getUiAutomation().takeScreenshot();
        if (image == null) throw new Failure("capture_failed");
        try (ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            if (!image.compress(Bitmap.CompressFormat.PNG, 100, bytes)) throw new Failure("capture_failed");
            return bytes.toByteArray();
        } finally { image.recycle(); }
    }
    private String hash(byte[] bytes) throws Exception {
        return Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes), Base64.NO_WRAP);
    }
    private JSONObject handle(JSONObject request) throws Exception {
        if (request.getInt("version") != 1) throw new Failure("protocol_incompatible");
        String op = request.getString("op");
        if (op.equals("hello")) {
            if (request.getInt("version") != 1) throw new Failure("protocol_incompatible");
            return new JSONObject().put("capabilities", new JSONArray(Arrays.asList("semantic", "screenshot", "coordinate", "private-input", "fault-injection")))
                .put("api", android.os.Build.VERSION.SDK_INT).put("target", target);
        }
        if (!request.optString("session").equals(session)) throw new Failure("session_stale");
        if (op.equals("close")) { invalidate(); stopped = true; return new JSONObject(); }
        if (op.equals("invalidate")) { invalidate(); return new JSONObject(); }
        if (op.equals("launch")) {
            if (!target.equals(request.getString("target"))) throw new Failure("launch_unauthorized");
            android.content.Intent intent = getContext().getPackageManager().getLaunchIntentForPackage(target);
            if (intent == null) throw new Failure("launch_unavailable");
            invalidate(); intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(intent);
            return new JSONObject().put("dispatched", true);
        }
        owner();
        // Explicit diagnostic available only in this isolated prototype.
        if (op.equals("fault_capture")) { invalidate(); failCaptureOnce = true; return new JSONObject(); }
        if (op.equals("observe")) {
            invalidate(); device.waitForIdle(5000);
            JSONArray tree = nodes(true);
            String version = hash(tree.toString().getBytes(StandardCharsets.UTF_8));
            for (int i = 0; i < tree.length(); i++) {
                tree.getJSONObject(i).remove("text"); tree.getJSONObject(i).remove("description");
            }
            byte[] image = screenshot(); owner();
            if (!version.equals(fingerprint())) throw new Failure("capture_changed");
            signature = version; imageHash = hash(image); observation = UUID.randomUUID().toString();
            for (int i = 0; i < tree.length(); i++) targets.add(tree.getJSONObject(i).getString("target"));
            return new JSONObject().put("observation", observation).put("nodes", tree)
                .put("package", target).put("width", device.getDisplayWidth()).put("height", device.getDisplayHeight())
                .put("screenshot", Base64.encodeToString(image, Base64.NO_WRAP));
        }
        if (!op.equals("action")) throw new Failure("unsupported_operation");
        if (observation.isEmpty() || !observation.equals(request.getString("observation"))) throw new Failure("observation_stale");
        if (!signature.equals(fingerprint())) throw new Failure("observation_stale");
        String kind = request.getString("kind");
        if (kind.equals("coordinate")) {
            int x = request.getInt("x"), y = request.getInt("y");
            if (x < 0 || y < 0 || x >= device.getDisplayWidth() || y >= device.getDisplayHeight()) throw new Failure("invalid_coordinate");
            if (!imageHash.equals(hash(screenshot()))) throw new Failure("observation_stale");
            invalidate(); if (!device.click(x, y)) throw new Failure("input_failed");
        } else {
            String id = request.getString("target");
            if (id.isEmpty() || !targets.contains(id)) throw new Failure("target_stale");
            List<UiObject2> matches = device.findObjects(By.res(id));
            if (matches.size() != 1) throw new Failure("target_ambiguous");
            UiObject2 object = matches.get(0);
            if (!object.isEnabled()) throw new Failure("input_failed");
            if (!kind.equals("click") && !kind.equals("fill")) throw new Failure("unsupported_action");
            invalidate();
            if (kind.equals("click")) object.click(); else {
                // UiObject2.setText in 2.3.0 logs the value. Use the semantic framework action.
                fill(id, request.getString("value"));
            }
        }
        owner();
        return new JSONObject().put("dispatched", true);
    }
}
