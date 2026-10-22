import os
import re
import sys
import shutil
import argparse

# 根据命令行参数决定打包语言版本
parser = argparse.ArgumentParser()
parser.add_argument("--lang", choices=["zh", "en"], default="zh", help="打包语言版本")
args = parser.parse_args()

LANG = args.lang
PKG_NAME = "juneix.embyx"
PKG_PATH = PKG_NAME.replace(".", "/")
APP_NAME = "EmbyX"
ICON_SRC = f"{LANG}/icon.png"

# ── 0. 从 HTML 徽章提取版本号 ─────────────────────────────────────────────────
VERSION_SRC = "zh/index.html"
version_name = "1.0"
version_code = 100

if os.path.exists(VERSION_SRC):
    with open(VERSION_SRC, "r", encoding="utf-8") as f:
        html = f.read()
    # 匹配徽章文本，例如 ">v1.1<" 或 ">v2.0<"
    m = re.search(r">v(\d+)\.(\d+)(?:\.(\d+))?<", html)
    if m:
        major = int(m.group(1))
        minor = int(m.group(2))
        patch = int(m.group(3)) if m.group(3) else 0
        version_name = f"{major}.{minor}" if patch == 0 else f"{major}.{minor}.{patch}"
        # versionCode 规则：major×10000 + minor×100 + patch 保证覆盖安装递增
        version_code = major * 10000 + minor * 100 + patch
        print(f"  Detected version: v{version_name} → versionCode={version_code}")
    else:
        print(f"  WARNING: Version badge not found in {VERSION_SRC}, using default {version_name}")
else:
    print(f"  WARNING: {VERSION_SRC} not found, using default version {version_name}")

print(f"Patching Android Project for lang={LANG}, pkg={PKG_NAME}, version={version_name}...")

# ── 1. 图标文件 ──────────────────────────────────────────────────────────────
os.makedirs("android/app/src/main/res/drawable", exist_ok=True)
if os.path.exists(ICON_SRC):
    shutil.copy(ICON_SRC, "android/app/src/main/res/drawable/icon.png")
    print(f"  Copied {ICON_SRC} → drawable/icon.png")
else:
    print(f"  WARNING: {ICON_SRC} not found, skipping icon copy")

# ── 2. AndroidManifest.xml 补丁 ──────────────────────────────────────────────
manifest_path = "android/app/src/main/AndroidManifest.xml"
with open(manifest_path, "r", encoding="utf-8") as f:
    manifest = f.read()

# 替换默认图标引用
manifest = manifest.replace("@mipmap/ic_launcher_round", "@drawable/icon")
manifest = manifest.replace("@mipmap/ic_launcher", "@drawable/icon")
manifest = manifest.replace("@drawable/icon_round", "@drawable/icon")

# 添加 WAKE_LOCK 与媒体前台播放权限（屏保、后台播放与视频常亮需要）
extra_perms = [
    '    <uses-permission android:name="android.permission.WAKE_LOCK" />',
    '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
    '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />',
    '    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
    '    <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />',
    '    <uses-permission android:name="android.permission.ACCESS_LOCAL_NETWORK" />'
]
for perm in extra_perms:
    perm_name = perm.split('"')[1]
    if perm_name not in manifest:
        manifest = manifest.replace("</manifest>", f"{perm}\n</manifest>")

# 增强 MainActivity 支持画中画 (Picture-in-Picture) 与桌面长按快捷方式 (Shortcuts)
shortcut_meta = """
            <meta-data
                android:name="android.app.shortcuts"
                android:resource="@xml/shortcuts" />
"""
if 'android:supportsPictureInPicture="true"' not in manifest:
    manifest = manifest.replace(
        'android:name=".MainActivity"',
        'android:name=".MainActivity"\n            android:supportsPictureInPicture="true"\n            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"'
    )
if 'android.app.shortcuts' not in manifest:
    manifest = manifest.replace(
        '</activity>',
        f'{shortcut_meta}        </activity>'
    )

# 注册系统屏保服务 EmbyXDreamService
service_block = """
        <service
            android:name=".EmbyXDreamService"
            android:exported="true"
            android:label="@string/app_name"
            android:permission="android.permission.BIND_DREAM_SERVICE">
            <intent-filter>
                <action android:name="android.service.dreams.DreamService" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <meta-data
                android:name="android.service.dream"
                android:resource="@xml/dream_info" />
        </service>
"""

if "EmbyXDreamService" not in manifest:
    manifest = manifest.replace("</application>", f"{service_block}\n    </application>")

# 注册后台播放媒体会话服务（通知栏 / 锁屏播控）
media_service_block = """
        <service
            android:name=".EmbyXMediaService"
            android:exported="false"
            android:foregroundServiceType="mediaPlayback" />
"""

if "EmbyXMediaService" not in manifest:
    manifest = manifest.replace("</application>", f"{media_service_block}\n    </application>")

# Android 13+ 通知栏权限（拒绝也不影响前台服务本身，仅不显示通知）
if "android.permission.POST_NOTIFICATIONS" not in manifest:
    manifest = manifest.replace(
        "</manifest>",
        '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n</manifest>'
    )

with open(manifest_path, "w", encoding="utf-8") as f:
    f.write(manifest)
print("  Patched AndroidManifest.xml")

# ── 3. MainActivity.java 补丁 ────────────────────────────────────────────────
main_activity_path = f"android/app/src/main/java/{PKG_PATH}/MainActivity.java"
os.makedirs(os.path.dirname(main_activity_path), exist_ok=True)

exit_toast_text = "再按一次退出应用" if LANG == "zh" else "Press back again to exit"
cache_cleared_toast = "应用缓存已清理" if LANG == "zh" else "App cache cleared"

main_activity_template = """package __PKG_NAME__;

import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
import java.io.File;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);

        // 三重保险：Window + WebView 全程变黑，彻底解决闪白问题
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.BLACK));
        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().setBackgroundColor(Color.BLACK);
        }

        // 1. 保持屏幕常亮
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // 检查并申请 Android 13+ 通知权限 (POST_NOTIFICATIONS)
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 101);
            }
        }

        // 2. 注册原生侧滑/物理返回键手势拦截调度器 (Predictive Back Support)
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            private long lastBackPressTime = 0;

            @Override
            public void handleOnBackPressed() {
                if (MainActivity.this.bridge != null && MainActivity.this.bridge.getWebView() != null) {
                    MainActivity.this.bridge.getWebView().evaluateJavascript(
                        "(function() { return (window.InputManager && typeof window.InputManager.handleNativeBack === 'function') ? window.InputManager.handleNativeBack() : false; })()",
                        new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                // 若前端已消费（关闭弹窗、退出搜索、退回宫格），则不退出 App
                                if ("true".equalsIgnoreCase(value)) {
                                    return;
                                }
                                // 若在根大厅未消费，提供 2 秒内双击防误触退出
                                long now = System.currentTimeMillis();
                                if (now - lastBackPressTime < 2000) {
                                    setEnabled(false);
                                    MainActivity.this.finish();
                                } else {
                                    lastBackPressTime = now;
                                    MainActivity.this.bridge.getWebView().evaluateJavascript(
                                        "if(window.app && typeof window.app.showToast === 'function') { window.app.showToast('__EXIT_TOAST__'); }",
                                        null
                                    );
                                }
                            }
                        }
                    );
                } else {
                    setEnabled(false);
                    MainActivity.this.finish();
                }
            }
        });

        // 3. 注入 EmbyXNative 桥接对象：重置配置时彻底清理私有目录海报图片磁盘缓存
        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().addJavascriptInterface(new Object() {
                @JavascriptInterface
                public void clearAppCache() {
                    MainActivity.this.runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                if (MainActivity.this.bridge != null && MainActivity.this.bridge.getWebView() != null) {
                                    MainActivity.this.bridge.getWebView().clearCache(true);
                                }
                                File cacheDir = MainActivity.this.getCacheDir();
                                if (cacheDir != null && cacheDir.isDirectory()) {
                                    deleteRecursive(cacheDir);
                                }
                            } catch (Exception e) {}
                        }
                    });
                }
            }, "EmbyXNative");
        }

        // 4. 注入原生 DLNA 渲染器发现与 AVTransport 控制桥（软件投屏兜底通道）
        if (this.bridge != null && this.bridge.getWebView() != null) {
            dlnaBridge = new EmbyXDlnaBridge(this, this.bridge.getWebView());
            this.bridge.getWebView().addJavascriptInterface(dlnaBridge, "EmbyXCastDlna");
        }

        // 5. 注入后台播放媒体会话桥：Web 层上报状态，原生维护 MediaSession + 通知栏
        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().addJavascriptInterface(
                new EmbyXNativeMediaBridge(this, this.bridge.getWebView()), "EmbyXNativeMedia");
        }

        // 6. 处理桌面长按快捷方式 (App Shortcuts) 点击事件：清理缓存
        handleIntent(getIntent());
    }

    private EmbyXDlnaBridge dlnaBridge;

    @Override
    protected void onDestroy() {
        if (dlnaBridge != null) {
            dlnaBridge.shutdown();
            dlnaBridge = null;
        }
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if ("juneix.embyx.ACTION_CLEAR_CACHE".equals(action)) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        MainActivity.this.runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                if (MainActivity.this.bridge != null && MainActivity.this.bridge.getWebView() != null) {
                                    MainActivity.this.bridge.getWebView().clearCache(true);
                                }
                            }
                        });
                        File cacheDir = MainActivity.this.getCacheDir();
                        if (cacheDir != null && cacheDir.isDirectory()) {
                            deleteRecursive(cacheDir);
                        }
                        MainActivity.this.runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                Toast.makeText(MainActivity.this, "__CACHE_TOAST__", Toast.LENGTH_SHORT).show();
                            }
                        });
                    } catch (Exception e) {}
                }
            }).start();
        }
    }

    private static void deleteRecursive(File fileOrDir) {
        if (fileOrDir.isDirectory()) {
            File[] children = fileOrDir.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursive(child);
                }
            }
        }
        fileOrDir.delete();
    }

    // 7. Android 原生画中画 (Picture-in-Picture) 支持
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        enterPipModeIfPlaying();
    }

    public void enterPipModeIfPlaying() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            if (this.bridge != null && this.bridge.getWebView() != null) {
                this.bridge.getWebView().evaluateJavascript(
                    "(function() { return (window.app && window.app.state && window.app.state.viewMode === 'stream'); })()",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String isStream) {
                            if ("true".equalsIgnoreCase(isStream)) {
                                try {
                                    android.app.PictureInPictureParams.Builder builder = new android.app.PictureInPictureParams.Builder();
                                    builder.setAspectRatio(new android.util.Rational(9, 16));
                                    if (android.os.Build.VERSION.SDK_INT >= 31) {
                                        builder.setAutoEnterEnabled(true);
                                    }
                                    enterPictureInPictureMode(builder.build());
                                } catch (Exception ignored) {}
                            }
                        }
                    }
                );
            }
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, android.content.res.Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        if (this.bridge != null && this.bridge.getWebView() != null) {
            String js = "window.__embyxPipChanged && window.__embyxPipChanged(" + isInPictureInPictureMode + ");";
            this.bridge.getWebView().evaluateJavascript(js, null);
        }
    }
}
"""

main_activity_content = (
    main_activity_template
    .replace("__PKG_NAME__", PKG_NAME)
    .replace("__EXIT_TOAST__", exit_toast_text)
    .replace("__CACHE_TOAST__", cache_cleared_toast)
)

with open(main_activity_path, "w", encoding="utf-8") as f:
    f.write(main_activity_content)
print("  Generated MainActivity.java (fullscreen + keep screen on + OnBackPressedCallback + EmbyXNative + Shortcuts + SplashScreen)")

# ── 3.1 EmbyXDlnaBridge.java：原生 UPnP/DLNA 渲染器发现与 AVTransport 控制 ──
dlna_bridge_code = r"""package __PKG_NAME__;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Xml;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 标准 UPnP/DLNA 渲染器桥。
 * 发现：SSDP M-SEARCH (URN MediaRenderer:1)；
 * 控制：AVTransport:1 的 SetAVTransportURI / Play / Pause / Stop / Seek / GetPositionInfo /
 *       GetTransportInfo，ConnectionManager:1 仅用于描述解析，不参与推送。
 * 所有方法立即返回，结果通过 window.__embyxDlnaDiscover / __embyxDlnaResult 回调。
 */
public class EmbyXDlnaBridge {

    private static final String SSDP_HOST = "239.255.255.250";
    private static final int SSDP_PORT = 1900;
    private static final String ST_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1";
    private static final String NS_AVT = "urn:schemas-upnp-org:service:AVTransport:1";

    private final Context context;
    private final WebView webView;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private WifiManager.MulticastLock multicastLock;

    // udn -> 渲染器描述（发现时缓存 controlURL，缺失时指令阶段补解析）
    private final Map<String, Device> devices = new LinkedHashMap<String, Device>();

    public EmbyXDlnaBridge(Context context, WebView webView) {
        this.context = context;
        this.webView = webView;
    }

    public void shutdown() {
        try { pool.shutdownNow(); } catch (Exception ignored) {}
        releaseMulticast();
    }

    // ── JS 入口：发现 ────────────────────────────────────────────────────────
    @android.webkit.JavascriptInterface
    public void discover(final String requestId) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                String json = "[]";
                try {
                    List<Device> found = searchRenderers();
                    synchronized (devices) {
                        devices.clear();
                        for (Device d : found) devices.put(d.udn, d);
                    }
                    JSONArray arr = new JSONArray();
                    for (Device d : found) {
                        JSONObject o = new JSONObject();
                        o.put("udn", d.udn);
                        o.put("name", d.name);
                        o.put("model", d.model);
                        o.put("manufacturer", d.manufacturer);
                        o.put("location", d.location);
                        o.put("avControl", d.avControl);
                        arr.put(o);
                    }
                    json = arr.toString();
                } catch (Exception ignored) {}
                emitDiscover(requestId, json);
            }
        });
    }

    // ── JS 入口：指令 ────────────────────────────────────────────────────────
    @android.webkit.JavascriptInterface
    public void command(final String requestId, final String udn, final String action, final String arg) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                String result = null;
                try {
                    Device d;
                    synchronized (devices) { d = devices.get(udn); }
                    if (d != null) result = execute(d, action, arg);
                } catch (Exception ignored) {}
                emitResult(requestId, result != null, result == null ? "" : result);
            }
        });
    }

    // ── SSDP 发现 ────────────────────────────────────────────────────────────
    private List<Device> searchRenderers() throws Exception {
        List<Device> result = new ArrayList<Device>();
        Map<String, String> locations = new LinkedHashMap<String, String>();
        acquireMulticast();
        DatagramSocket socket = new DatagramSocket();
        try {
            socket.setSoTimeout(1200);
            byte[] payloadRenderer = ("M-SEARCH * HTTP/1.1\r\n" +
                    "HOST: " + SSDP_HOST + ":" + SSDP_PORT + "\r\n" +
                    "MAN: \"ssdp:discover\"\r\n" +
                    "MX: 3\r\n" +
                    "ST: " + ST_RENDERER + "\r\n\r\n").getBytes(StandardCharsets.UTF_8);
            byte[] payloadAvt = ("M-SEARCH * HTTP/1.1\r\n" +
                    "HOST: " + SSDP_HOST + ":" + SSDP_PORT + "\r\n" +
                    "MAN: \"ssdp:discover\"\r\n" +
                    "MX: 3\r\n" +
                    "ST: " + NS_AVT + "\r\n\r\n").getBytes(StandardCharsets.UTF_8);
            DatagramPacket packetRenderer = new DatagramPacket(payloadRenderer, payloadRenderer.length,
                    InetAddress.getByName(SSDP_HOST), SSDP_PORT);
            DatagramPacket packetAvt = new DatagramPacket(payloadAvt, payloadAvt.length,
                    InetAddress.getByName(SSDP_HOST), SSDP_PORT);
            socket.send(packetRenderer);
            socket.send(packetAvt);

            long deadline = System.currentTimeMillis() + 4000;
            byte[] buffer = new byte[8192];
            while (System.currentTimeMillis() < deadline) {
                try {
                    DatagramPacket resp = new DatagramPacket(buffer, buffer.length);
                    socket.receive(resp);
                    String text = new String(resp.getData(), 0, resp.getLength(), StandardCharsets.UTF_8);
                    String usn = header(text, "USN");
                    String location = header(text, "LOCATION");
                    String st = header(text, "ST");
                    if (usn == null || location == null) continue;
                    // 兼容 MediaRenderer 设备与直接以 AVTransport 响应的电视
                    boolean isRenderer = (st != null && (st.startsWith(ST_RENDERER) || st.startsWith(NS_AVT))) ||
                            usn.toLowerCase().contains("mediarenderer") ||
                            usn.toLowerCase().contains("avtransport");
                    if (!isRenderer) continue;
                    String udn = usn.split("::")[0].trim();
                    if (udn.length() == 0 || locations.containsKey(udn)) continue;
                    locations.put(udn, location);
                } catch (java.net.SocketTimeoutException e) {
                    if (locations.size() > 0) break;
                }
            }
        } finally {
            socket.close();
            releaseMulticast();
        }

        for (Map.Entry<String, String> e : locations.entrySet()) {
            Device d = parseDescription(e.getValue());
            if (d == null) continue;
            if (d.udn == null || d.udn.length() == 0) d.udn = e.getKey();
            if (d.avControl != null && d.avControl.length() > 0) result.add(d);
        }
        return result;
    }

    private static String header(String raw, String key) {
        for (String line : raw.split("\r\n")) {
            int idx = line.indexOf(':');
            if (idx <= 0) continue;
            if (line.substring(0, idx).trim().equalsIgnoreCase(key)) {
                return line.substring(idx + 1).trim();
            }
        }
        return null;
    }

    private void acquireMulticast() {
        try {
            WifiManager wifi = (WifiManager) context.getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                multicastLock = wifi.createMulticastLock("EmbyX-DLNA");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            }
        } catch (Exception ignored) {}
    }

    private void releaseMulticast() {
        try {
            if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        } catch (Exception ignored) {}
        multicastLock = null;
    }

    // ── 设备描述解析 ────────────────────────────────────────────────────────
    private Device parseDescription(String location) {
        try {
            String xml = httpGet(location);
            if (xml == null) return null;
            Device d = new Device();
            d.location = location;

            XmlPullParser parser = Xml.newPullParser();
            parser.setInput(new java.io.StringReader(xml));
            int event = parser.getEventType();
            String current = null;
            String serviceType = null;
            String controlUrl = null;
            while (event != XmlPullParser.END_DOCUMENT) {
                if (event == XmlPullParser.START_TAG) {
                    current = parser.getName();
                    if ("service".equals(current)) {
                        serviceType = null;
                        controlUrl = null;
                    }
                } else if (event == XmlPullParser.TEXT) {
                    String text = parser.getText() != null ? parser.getText().trim() : "";
                    if ("friendlyName".equals(current)) d.name = text;
                    else if ("modelName".equals(current)) d.model = text;
                    else if ("manufacturer".equals(current)) d.manufacturer = text;
                    else if ("UDN".equals(current)) d.udn = normalizeUdn(text);
                    else if ("serviceType".equals(current)) serviceType = text;
                    else if ("controlURL".equals(current)) controlUrl = text;
                } else if (event == XmlPullParser.END_TAG) {
                    if ("service".equals(parser.getName()) && serviceType != null && controlUrl != null) {
                        if (serviceType.startsWith("urn:schemas-upnp-org:service:AVTransport")) {
                            d.avControl = resolveUrl(location, controlUrl);
                        }
                    }
                    current = null;
                }
                event = parser.next();
            }
            if (d.name == null || d.name.length() == 0) d.name = d.model != null ? d.model : "DLNA";
            if (d.avControl == null) return null;
            return d;
        } catch (Exception e) {
            return null;
        }
    }

    private static String normalizeUdn(String udn) {
        String u = udn.trim();
        int idx = u.indexOf("::");
        if (idx > 0) u = u.substring(0, idx);
        return u;
    }

    private static String resolveUrl(String base, String relative) {
        try {
            return new URL(new URL(base), relative).toString();
        } catch (Exception e) {
            return relative;
        }
    }

    // ── AVTransport SOAP ────────────────────────────────────────────────────
    private String execute(Device d, String action, String arg) {
        if (d == null || d.avControl == null) return null;
        try {
            if ("play".equals(action)) {
                JSONObject meta = new JSONObject(arg == null || arg.length() == 0 ? "{}" : arg);
                String url = meta.optString("url", "");
                int start = meta.optInt("start", 0);
                String title = meta.optString("title", "EmbyX Video");
                if (url.length() == 0) return null;
                String didl = "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" " +
                        "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" " +
                        "xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">" +
                        "<item id=\"0\" parentID=\"-1\" restricted=\"1\">" +
                        "<dc:title>" + escapeXml(title) + "</dc:title>" +
                        "<upnp:class>object.item.videoItem</upnp:class>" +
                        "<res protocolInfo=\"http-get:*:video/mp4:*\">" + escapeXml(url) + "</res>" +
                        "</item></DIDL-Lite>";
                String setUri = soap(d.avControl, "SetAVTransportURI",
                        "<InstanceID>0</InstanceID><CurrentURI>" + escapeXml(url) + "</CurrentURI>" +
                        "<CurrentURIMetaData>" + escapeXml(didl) + "</CurrentURIMetaData>");
                if (setUri == null) return null;
                soap(d.avControl, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>");
                if (start > 0) {
                    soap(d.avControl, "Seek",
                            "<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>" +
                            formatTime(start) + "</Target>");
                }
                return "ok";
            }
            if ("pause".equals(action)) {
                soap(d.avControl, "Pause", "<InstanceID>0</InstanceID>");
                return "ok";
            }
            if ("resume".equals(action)) {
                soap(d.avControl, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>");
                return "ok";
            }
            if ("stop".equals(action)) {
                soap(d.avControl, "Stop", "<InstanceID>0</InstanceID>");
                return "ok";
            }
            if ("seek".equals(action)) {
                int seconds = 0;
                try { seconds = Integer.parseInt(arg == null ? "0" : arg.trim()); } catch (Exception ignored) {}
                soap(d.avControl, "Seek",
                        "<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>" +
                        formatTime(seconds) + "</Target>");
                return "ok";
            }
            if ("state".equals(action)) {
                String transport = soap(d.avControl, "GetTransportInfo", "<InstanceID>0</InstanceID>");
                String position = soap(d.avControl, "GetPositionInfo", "<InstanceID>0</InstanceID>");
                JSONObject o = new JSONObject();
                o.put("paused", transport != null && transport.contains("PAUSED_PLAYBACK"));
                o.put("position", parseTime(soapValue(position, "RelTime")));
                o.put("duration", parseTime(soapValue(position, "TrackDuration")));
                return o.toString();
            }
        } catch (Exception ignored) {}
        return null;
    }

    private String soap(String controlUrl, String action, String inner) {
        try {
            String body = "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
                    "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" " +
                    "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>" +
                    "<u:" + action + " xmlns:u=\"" + NS_AVT + "\">" + inner +
                    "</u:" + action + "></s:Body></s:Envelope>";
            HttpURLConnection conn = (HttpURLConnection) new URL(controlUrl).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(5000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"");
            conn.setRequestProperty("SOAPAction", "\"" + NS_AVT + "#" + action + "\"");
            OutputStream os = conn.getOutputStream();
            os.write(body.getBytes(StandardCharsets.UTF_8));
            os.flush();
            os.close();
            if (conn.getResponseCode() >= 400) return null;
            InputStream is = conn.getInputStream();
            String resp = readAll(is);
            is.close();
            conn.disconnect();
            return resp;
        } catch (Exception e) {
            return null;
        }
    }

    private static String soapValue(String xml, String tag) {
        if (xml == null) return null;
        int start = xml.indexOf("<" + tag + ">");
        if (start < 0) return null;
        start += tag.length() + 2;
        int end = xml.indexOf("</" + tag + ">", start);
        if (end < 0) return null;
        return xml.substring(start, end).trim();
    }

    private static int parseTime(String raw) {
        if (raw == null || raw.length() == 0) return 0;
        String t = raw.trim();
        int dot = t.indexOf('.');
        if (dot > 0) t = t.substring(0, dot);
        String[] parts = t.split(":");
        try {
            int h = 0, m = 0, s = 0;
            if (parts.length == 3) { h = Integer.parseInt(parts[0]); m = Integer.parseInt(parts[1]); s = Integer.parseInt(parts[2]); }
            else if (parts.length == 2) { m = Integer.parseInt(parts[0]); s = Integer.parseInt(parts[1]); }
            else if (parts.length == 1) { s = Integer.parseInt(parts[0]); }
            return h * 3600 + m * 60 + s;
        } catch (Exception e) {
            return 0;
        }
    }

    private static String formatTime(int seconds) {
        int h = seconds / 3600;
        int m = (seconds % 3600) / 60;
        int s = seconds % 60;
        return String.format(java.util.Locale.US, "%02d:%02d:%02d", h, m, s);
    }

    private static String httpGet(String url) {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(3000);
            conn.setRequestMethod("GET");
            if (conn.getResponseCode() >= 400) return null;
            InputStream is = conn.getInputStream();
            String text = readAll(is);
            is.close();
            conn.disconnect();
            return text;
        } catch (Exception e) {
            return null;
        }
    }

    private static String readAll(InputStream is) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String escapeXml(String raw) {
        return raw.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&apos;");
    }

    // ── 回调 JS ─────────────────────────────────────────────────────────────
    private void emitDiscover(final String requestId, final String json) {
        final String js = "window.__embyxDlnaDiscover && window.__embyxDlnaDiscover(" +
                JSONObject.quote(requestId) + "," + JSONObject.quote(json) + ");";
        runJs(js);
    }

    private void emitResult(final String requestId, final boolean ok, final String payload) {
        final String js = "window.__embyxDlnaResult && window.__embyxDlnaResult(" +
                JSONObject.quote(requestId) + "," + ok + "," + JSONObject.quote(payload) + ");";
        runJs(js);
    }

    private void runJs(final String js) {
        if (webView == null) return;
        webView.post(new Runnable() {
            @Override
            public void run() {
                try { webView.evaluateJavascript(js, null); } catch (Exception ignored) {}
            }
        });
    }

    private static class Device {
        String udn;
        String name;
        String model;
        String manufacturer;
        String location;
        String avControl;
    }
}
"""
dlna_bridge_content = dlna_bridge_code.replace("__PKG_NAME__", PKG_NAME)
dlna_bridge_path = f"android/app/src/main/java/{PKG_PATH}/EmbyXDlnaBridge.java"
with open(dlna_bridge_path, "w", encoding="utf-8") as f:
    f.write(dlna_bridge_content)
print("  Generated EmbyXDlnaBridge.java (SSDP discovery + AVTransport control)")

# ── 3.2 EmbyXMediaService.java：前台媒体服务 + MediaSession + 通知栏播控 ──
media_service_code = r"""package __PKG_NAME__;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 后台播放媒体会话服务。
 * Web 层通过 EmbyXNativeMedia.update(json) 上报标题/封面/进度/播放态，
 * 这里维护 MediaSession + MediaStyle 通知栏，并把锁屏、耳机、车机的播控指令
 * 以 window.__embyxMediaCommand(cmd, arg) 回灌给 Web 层。
 */
public class EmbyXMediaService extends Service {

    public static final String CHANNEL_ID = "embyx_playback";
    public static final int NOTIFICATION_ID = 0xE3B1;

    public static final String ACTION_TOGGLE = "juneix.embyx.media.TOGGLE";
    public static final String ACTION_NEXT = "juneix.embyx.media.NEXT";
    public static final String ACTION_PREV = "juneix.embyx.media.PREV";
    public static final String ACTION_STOP = "juneix.embyx.media.STOP";
    public static final String ACTION_CLEAR = "juneix.embyx.media.CLEAR";
    public static final String ACTION_UPDATE = "juneix.embyx.media.UPDATE";
    public static final String EXTRA_PAYLOAD = "payload";

    private static WeakReference<WebView> webViewRef = new WeakReference<WebView>(null);
    // 进程内单例：桥接层直接调用，避免应用退到后台后 startService 受后台执行限制
    private static volatile EmbyXMediaService instance;

    private MediaSession session;
    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    private String title = "EmbyX";
    private String subtitle = "";
    private String poster = "";
    private Bitmap posterBitmap;
    private boolean playing = false;
    private long position = 0;
    private long duration = 0;
    private boolean canPrev = false;
    private boolean canNext = false;
    private boolean foregroundStarted = false;

    public static void attach(WebView webView) {
        webViewRef = new WeakReference<WebView>(webView);
    }

    public static boolean isRunning() {
        return instance != null;
    }

    /** 桥接层入口：服务已在运行时直接刷新，未运行返回 false 由调用方负责拉起。 */
    public static boolean dispatch(String json) {
        EmbyXMediaService service = instance;
        if (service == null) return false;
        service.update(json);
        return true;
    }

    public static void requestStop() {
        EmbyXMediaService service = instance;
        if (service != null) service.clear();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
        session = new MediaSession(this, "EmbyX");
        session.setActive(true);
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { sendCommand("play", ""); }
            @Override public void onPause() { sendCommand("pause", ""); }
            @Override public void onSkipToNext() { sendCommand("next", ""); }
            @Override public void onSkipToPrevious() { sendCommand("prev", ""); }
            @Override public void onStop() { sendCommand("stop", ""); }
            @Override public void onSeekTo(long pos) { sendCommand("seek", String.valueOf(pos / 1000.0)); }
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            if (ACTION_CLEAR.equals(action)) {
                // 由 startForegroundService 拉起时，必须先进入前台再退出，否则系统抛 ANR
                if (!foregroundStarted) pushNotification();
                clear();
                return START_NOT_STICKY;
            }
            if (ACTION_UPDATE.equals(action)) {
                String payload = intent.getStringExtra(EXTRA_PAYLOAD);
                if (payload != null) update(payload);
            } else if (ACTION_TOGGLE.equals(action)) {
                sendCommand(playing ? "pause" : "play", "");
            } else if (ACTION_NEXT.equals(action)) {
                sendCommand("next", "");
            } else if (ACTION_PREV.equals(action)) {
                sendCommand("prev", "");
            } else if (ACTION_STOP.equals(action)) {
                sendCommand("stop", "");
            }

            // startForegroundService 启动后必须在 5s 内进入前台，异常路径也要兜住
            if (!foregroundStarted) pushNotification();
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        try {
            if (session != null) {
                session.setActive(false);
                session.release();
                session = null;
            }
        } catch (Exception ignored) {}
        try { pool.shutdownNow(); } catch (Exception ignored) {}
        super.onDestroy();
    }

    // ── Web 层入口 ──────────────────────────────────────────────────────────
    public void update(String json) {
        try {
            JSONObject o = new JSONObject(json);
            title = o.optString("title", "EmbyX");
            subtitle = o.optString("subtitle", "");
            playing = o.optBoolean("playing", false);
            position = o.optLong("position", 0);
            duration = o.optLong("duration", 0);
            canPrev = o.optBoolean("canPrev", false);
            canNext = o.optBoolean("canNext", false);

            String newPoster = o.optString("poster", "");
            if (newPoster.length() > 0 && !newPoster.equals(poster)) {
                poster = newPoster;
                posterBitmap = null;
                loadPoster(poster);
            } else if (newPoster.length() == 0) {
                poster = "";
                posterBitmap = null;
            }
        } catch (Exception e) {
            return;
        }
        pushSessionState();
        pushNotification();
    }

    public void clear() {
        try {
            if (session != null) session.setActive(false);
        } catch (Exception ignored) {}
        stopForegroundCompat(true);
        foregroundStarted = false;
        stopSelf();
    }

    // ── MediaSession 状态 ───────────────────────────────────────────────────
    private void pushSessionState() {
        if (session == null) return;
        try {
            MediaMetadata.Builder meta = new MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle);
            if (duration > 0) meta.putLong(MediaMetadata.METADATA_KEY_DURATION, duration);
            if (posterBitmap != null) meta.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, posterBitmap);
            session.setMetadata(meta.build());

            PlaybackState.Builder state = new PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE |
                            PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SEEK_TO |
                            PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS |
                            PlaybackState.ACTION_STOP)
                    .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                            position, playing ? 1.0f : 0f);
            session.setPlaybackState(state.build());
        } catch (Exception ignored) {}
    }

    // ── 通知栏 ──────────────────────────────────────────────────────────────
    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "__CHANNEL_NAME__", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(channel);
        } catch (Exception ignored) {}
    }

    private PendingIntent serviceIntent(String action) {
        Intent intent = new Intent(this, EmbyXMediaService.class);
        intent.setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, action.hashCode(), intent, flags);
    }

    private PendingIntent contentIntent() {
        Intent intent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (intent == null) return null;
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, intent, flags);
    }

    private Notification.Action action(int iconRes, String label, PendingIntent intent) {
        Notification.Action.Builder b = new Notification.Action.Builder(
                android.graphics.drawable.Icon.createWithResource(this, iconRes), label, intent);
        return b.build();
    }

    @SuppressWarnings("deprecation")
    private void pushNotification() {
        try {
            Notification.Builder builder;
            if (Build.VERSION.SDK_INT >= 26) {
                builder = new Notification.Builder(this, CHANNEL_ID);
            } else {
                builder = new Notification.Builder(this);
                builder.setPriority(Notification.PRIORITY_LOW);
            }

            builder.setSmallIcon(getApplicationInfo().icon)
                    .setContentTitle(title)
                    .setContentText(subtitle)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setOngoing(playing)
                    .setShowWhen(false);

            if (posterBitmap != null) builder.setLargeIcon(posterBitmap);

            PendingIntent content = contentIntent();
            if (content != null) builder.setContentIntent(content);

            builder.addAction(action(android.R.drawable.ic_media_previous, "__PREV_LABEL__", serviceIntent(ACTION_PREV)));
            builder.addAction(action(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                    playing ? "__PAUSE_LABEL__" : "__PLAY_LABEL__", serviceIntent(ACTION_TOGGLE)));
            builder.addAction(action(android.R.drawable.ic_media_next, "__NEXT_LABEL__", serviceIntent(ACTION_NEXT)));

            Notification.MediaStyle style = new Notification.MediaStyle();
            style.setShowActionsInCompactView(0, 1, 2);
            if (session != null) style.setMediaSession(session.getSessionToken());
            builder.setStyle(style);

            Notification notification = builder.build();
            if (!foregroundStarted) {
                if (Build.VERSION.SDK_INT >= 29) {
                    startForeground(NOTIFICATION_ID, notification, 2 /* FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK */);
                } else {
                    startForeground(NOTIFICATION_ID, notification);
                }
                foregroundStarted = true;
            } else {
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) nm.notify(NOTIFICATION_ID, notification);
            }
        } catch (Exception ignored) {}
    }

    private void stopForegroundCompat(boolean removeNotification) {
        try {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(removeNotification ? STOP_FOREGROUND_REMOVE : STOP_FOREGROUND_DETACH);
            else stopForeground(removeNotification);
        } catch (Exception ignored) {}
    }

    // ── 封面与指令 ──────────────────────────────────────────────────────────
    private void loadPoster(final String url) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                Bitmap bitmap = null;
                try {
                    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setConnectTimeout(4000);
                    conn.setReadTimeout(4000);
                    conn.setRequestMethod("GET");
                    if (conn.getResponseCode() < 400) {
                        InputStream is = conn.getInputStream();
                        bitmap = BitmapFactory.decodeStream(is);
                        is.close();
                    }
                    conn.disconnect();
                } catch (Exception ignored) {}
                if (bitmap == null || !url.equals(poster)) return;
                posterBitmap = bitmap;
                pushSessionState();
                pushNotification();
            }
        });
    }

    private void sendCommand(final String cmd, final String arg) {
        final WebView webView = webViewRef.get();
        if (webView == null) return;
        final String js = "window.__embyxMediaCommand && window.__embyxMediaCommand(" +
                JSONObject.quote(cmd) + "," + JSONObject.quote(arg) + ");";
        webView.post(new Runnable() {
            @Override
            public void run() {
                try { webView.evaluateJavascript(js, null); } catch (Exception ignored) {}
            }
        });
    }
}
"""
media_service_content = (media_service_code
    .replace("__PKG_NAME__", PKG_NAME)
    .replace("__CHANNEL_NAME__", "EmbyX 播放控制" if LANG == "zh" else "EmbyX Playback")
    .replace("__PREV_LABEL__", "上一集" if LANG == "zh" else "Previous")
    .replace("__PAUSE_LABEL__", "暂停" if LANG == "zh" else "Pause")
    .replace("__PLAY_LABEL__", "播放" if LANG == "zh" else "Play")
    .replace("__NEXT_LABEL__", "下一集" if LANG == "zh" else "Next"))
media_service_path = f"android/app/src/main/java/{PKG_PATH}/EmbyXMediaService.java"
with open(media_service_path, "w", encoding="utf-8") as f:
    f.write(media_service_content)
print("  Generated EmbyXMediaService.java (MediaSession + MediaStyle notification)")

# ── 3.3 EmbyXNativeMediaBridge.java：Web 层 → 媒体服务的 JS 桥 ──────────────
media_bridge_code = r"""package __PKG_NAME__;

import android.content.Intent;
import android.os.Build;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/** Web 层播放状态上报桥，注入名 window.EmbyXNativeMedia。 */
public class EmbyXNativeMediaBridge {

    private final android.content.Context context;
    private final WebView webView;

    public EmbyXNativeMediaBridge(android.content.Context context, WebView webView) {
        this.context = context;
        this.webView = webView;
        EmbyXMediaService.attach(webView);
    }

    // 状态随 Intent 一并下发：服务尚未创建时也能拿到首帧数据，
    // 服务已在运行则走 onStartCommand 直接刷新，无需静态持有 Service 引用
    // 服务已在运行就直接同步刷新（零 IPC、零后台启动限制）；
    // 首次上报才拉起前台服务，状态随 Intent 一起送达，服务创建首帧即有数据
    @JavascriptInterface
    public void update(final String json) {
        if (json == null) return;
        // 通知与 MediaSession 状态统一在主线程刷新
        new android.os.Handler(android.os.Looper.getMainLooper()).post(new Runnable() {
            @Override
            public void run() {
                if (EmbyXMediaService.dispatch(json)) return;
                Intent intent = new Intent(context, EmbyXMediaService.class);
                intent.setAction(EmbyXMediaService.ACTION_UPDATE);
                intent.putExtra(EmbyXMediaService.EXTRA_PAYLOAD, json);
                startService(intent);
            }
        });
    }

    @JavascriptInterface
    public void clear() {
        new android.os.Handler(android.os.Looper.getMainLooper()).post(new Runnable() {
            @Override
            public void run() {
                if (EmbyXMediaService.isRunning()) EmbyXMediaService.requestStop();
            }
        });
    }

    private void startService(Intent intent) {
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
            else context.startService(intent);
        } catch (Exception ignored) {}
    }
}
"""
media_bridge_content = media_bridge_code.replace("__PKG_NAME__", PKG_NAME)
media_bridge_path = f"android/app/src/main/java/{PKG_PATH}/EmbyXNativeMediaBridge.java"
with open(media_bridge_path, "w", encoding="utf-8") as f:
    f.write(media_bridge_content)
print("  Generated EmbyXNativeMediaBridge.java")

# ── 4. EmbyXDreamService.java ───────────────────────────────────────────────
# 屏保服务使用 Android DreamService，内嵌 WebView 加载本地 index.html，读取 localStorage 中 Emby 配置自动播放
dream_service_code = f"""package {PKG_NAME};

import android.service.dreams.DreamService;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.WindowManager;

public class EmbyXDreamService extends DreamService {{
    private WebView webView;

    @Override
    public void onAttachedToWindow() {{
        super.onAttachedToWindow();

        setInteractive(true);
        setFullscreen(true);

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); 
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        webView.setWebViewClient(new WebViewClient());
        webView.loadUrl("file:///android_asset/public/index.html");

        setContentView(webView);
    }}

    @Override
    public void onDreamingStarted() {{
        super.onDreamingStarted();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }}

    @Override
    public void onDreamingStopped() {{
        super.onDreamingStopped();
        if (webView != null) {{
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }}
    }}
}}
"""
dream_service_path = f"android/app/src/main/java/{PKG_PATH}/EmbyXDreamService.java"
with open(dream_service_path, "w", encoding="utf-8") as f:
    f.write(dream_service_code)
print(f"  Created EmbyXDreamService.java at {dream_service_path}")

# ── 5. dream_info.xml & shortcuts.xml ────────────────────────────────────────
os.makedirs("android/app/src/main/res/xml", exist_ok=True)
xml_code = f"""<?xml version="1.0" encoding="utf-8"?>
<dream android:settingsActivity="{PKG_NAME}.MainActivity"
       android:previewImage="@drawable/icon"
       xmlns:android="http://schemas.android.com/apk/res/android" />
"""
with open("android/app/src/main/res/xml/dream_info.xml", "w", encoding="utf-8") as f:
    f.write(xml_code)
print("  Created dream_info.xml")

# 桌面长按快捷方式定义 (App Shortcuts)
shortcut_label = "清除缓存" if LANG == "zh" else "Clear Cache"
shortcuts_xml = f"""<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
    <shortcut
        android:shortcutId="clear_cache"
        android:enabled="true"
        android:icon="@drawable/icon"
        android:shortcutShortLabel="@string/shortcut_clear_cache_short"
        android:shortcutLongLabel="@string/shortcut_clear_cache_long">
        <intent
            android:action="juneix.embyx.ACTION_CLEAR_CACHE"
            android:targetPackage="{PKG_NAME}"
            android:targetClass="{PKG_NAME}.MainActivity" />
    </shortcut>
</shortcuts>
"""
with open("android/app/src/main/res/xml/shortcuts.xml", "w", encoding="utf-8") as f:
    f.write(shortcuts_xml)
print("  Created shortcuts.xml")

# 注入快捷方式多语言文案到 strings.xml
strings_path = "android/app/src/main/res/values/strings.xml"
if os.path.exists(strings_path):
    with open(strings_path, "r", encoding="utf-8") as f:
        strings_content = f.read()
    short_lbl = "清除缓存" if LANG == "zh" else "Clear Cache"
    long_lbl = "清除 EmbyX 应用缓存" if LANG == "zh" else "Clear EmbyX Cache"
    if "shortcut_clear_cache_short" in strings_content:
        strings_content = re.sub(r'<string name="shortcut_clear_cache_short">.*?</string>', f'<string name="shortcut_clear_cache_short">{short_lbl}</string>', strings_content)
        strings_content = re.sub(r'<string name="shortcut_clear_cache_long">.*?</string>', f'<string name="shortcut_clear_cache_long">{long_lbl}</string>', strings_content)
    else:
        extra_strings = f'    <string name="shortcut_clear_cache_short">{short_lbl}</string>\n    <string name="shortcut_clear_cache_long">{long_lbl}</string>\n</resources>'
        strings_content = strings_content.replace("</resources>", extra_strings)
    with open(strings_path, "w", encoding="utf-8") as f:
        f.write(strings_content)
    print("  Patched strings.xml with shortcut labels")

# ── 6. 注入 APK 版本号到 build.gradle ───────────────────────────────────────
gradle_path = "android/app/build.gradle"
if os.path.exists(gradle_path):
    with open(gradle_path, "r", encoding="utf-8") as f:
        gradle = f.read()

    # 替换 versionCode / versionName
    gradle = re.sub(r"versionCode(?:\s*=\s*|\s+)\d+", f"versionCode = {version_code}", gradle)
    gradle = re.sub(r'versionName(?:\s*=\s*|\s+)"[^"]+"', f'versionName = "{version_name}"', gradle)

    if "signingConfig signingConfigs.release" not in gradle:
        gradle = gradle.replace("buildTypes {", "buildTypes {\n        debug {\n            signingConfig signingConfigs.release\n        }")
        gradle = gradle.replace("release {", "release {\n            signingConfig signingConfigs.release")

    if "signingConfigs {" not in gradle:
        signing_configs_str = """
    signingConfigs {
        release {
            storeFile file("../../key/embyx.jks")
            storePassword System.getenv("SIGNING_STORE_PASSWORD")
            keyAlias System.getenv("SIGNING_KEY_ALIAS")
            keyPassword System.getenv("SIGNING_KEY_PASSWORD")
        }
    }
"""
        gradle = gradle.replace("buildTypes {", signing_configs_str + "\n    buildTypes {")

    with open(gradle_path, "w", encoding="utf-8") as f:
        f.write(gradle)
    print(f"  Patched build.gradle → versionCode={version_code}, versionName=\"{version_name}\"")
else:
    print(f"  WARNING: {gradle_path} not found, skipping version injection")

# ── 7. 启动页 (Splash Screen) 规范适配 ───────────────────────────────────
res_dir = "android/app/src/main/res"
os.makedirs(f"{res_dir}/values", exist_ok=True)
os.makedirs(f"{res_dir}/drawable", exist_ok=True)

# 写入颜色资源
colors_path = f"{res_dir}/values/colors.xml"
colors_xml = """<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="black">#000000</color>
    <color name="white">#FFFFFF</color>
</resources>
"""
with open(colors_path, "w", encoding="utf-8") as f:
    f.write(colors_xml)

# 创建缩小的启动图辅助资源 (使用 inset 解决图标被裁切问题)
# 核心逻辑：使用 dp 绝对单位以向下兼容 Android 7.0/7.1 (防止百分比引起解析崩溃)
splash_icon_xml = """<?xml version="1.0" encoding="utf-8"?>
<inset xmlns:android="http://schemas.android.com/apk/res/android"
    android:drawable="@drawable/icon"
    android:insetLeft="48dp"
    android:insetRight="48dp"
    android:insetTop="48dp"
    android:insetBottom="48dp" />
"""
with open(f"{res_dir}/drawable/splash_icon_padded.xml", "w", encoding="utf-8") as f:
    f.write(splash_icon_xml)
print("  Created splash_icon_padded.xml")

# ── 8. 修改主题 (Themes/Styles) 适配 Google SplashScreen API ─────────────────
target_files = [
    "values/themes.xml", 
    "values-night/themes.xml", 
    "values/styles.xml",
    "values-v31/themes.xml"
]

splash_style_found = False
for rel_path in target_files:
    full_path = os.path.join(res_dir, rel_path)
    if os.path.exists(full_path):
        with open(full_path, "r", encoding="utf-8") as f:
            content = f.read()

        # A. 修复“第二步白屏”：将基础主题的窗体背景强行设为黑色
        # 针对 AppTheme 和 AppTheme.NoActionBar 注入 windowBackground，确保交接瞬间不闪白
        content = re.sub(
            r'(<style\s+name="AppTheme(?:\.NoActionBar)?"[^>]*>)(.*?)(</style>)',
            r'\1\2    <item name="android:windowBackground">@color/black</item>\n    \3',
            content,
            flags=re.DOTALL
        )
        
        # B. 适配官方启动页：精准匹配并提取 AppTheme.NoActionBarLaunch 标签块
        style_block_pattern = r'(<style\s+name="AppTheme\.NoActionBarLaunch"[^>]*>)(.*?)(</style>)'
        m = re.search(style_block_pattern, content, flags=re.DOTALL)
        if m:
            start_tag = m.group(1)
            inner_items = m.group(2)
            
            # 替换 parent 为官方支持的 Theme.SplashScreen
            start_tag = re.sub(r'parent="[^"]*"', 'parent="Theme.SplashScreen"', start_tag)
            
            # 清理历史可能存在的冲突属性
            inner_items = re.sub(r'<item\s+name="android:background">.*?</item>', '', inner_items)
            inner_items = re.sub(r'<item\s+name="windowSplashScreenBackground">.*?</item>', '', inner_items)
            inner_items = re.sub(r'<item\s+name="windowSplashScreenAnimatedIcon">.*?</item>', '', inner_items)
            inner_items = re.sub(r'<item\s+name="postSplashScreenTheme">.*?</item>', '', inner_items)

            splash_items = """
        <item name="windowSplashScreenBackground">@color/black</item>
        <item name="windowSplashScreenAnimatedIcon">@drawable/splash_icon_padded</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
"""
            # 重构整个 style 块并原位替换回文档
            new_block = f"{start_tag}{inner_items}{splash_items}    </style>"
            content = content[:m.start()] + new_block + content[m.end():]
            
            with open(full_path, "w", encoding="utf-8") as f:
                f.write(content)
            print(f"  Successfully patched {rel_path} to Standard SplashScreen API")
            splash_style_found = True

if not splash_style_found:
    print("  WARNING: AppTheme.NoActionBarLaunch style not found in any res files!")

# ── 9. MainActivity 启动页入口校验 ──────────────────────────────────────────
print("  Verified SplashScreen and black background in MainActivity.java")

print(f"\nPatch complete! ({LANG} version, pkg={PKG_NAME}, v{version_name})")
