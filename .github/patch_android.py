import os
import re
import sys
import shutil
import argparse

# 根据命令行参数决定打包中文版还是英文版
# 用法: python patch_android.py --lang zh 或 --lang en
parser = argparse.ArgumentParser()
parser.add_argument("--lang", choices=["zh", "en"], default="zh", help="打包语言版本")
args = parser.parse_args()

LANG = args.lang
PKG_NAME = "juneix.embyx"
PKG_PATH = PKG_NAME.replace(".", "/")  # juneix/embyx
APP_NAME = "EmbyX"
ICON_SRC = f"{LANG}/icon.png"          # zh/icon.png 或 en/icon.png

# ── 0. 从 HTML 徽章提取版本号 ─────────────────────────────────────────────────
# HTML 中的版本徽章格式为 ">v1.1<"，两个版本的徽章内容保持一致，统一读 zh/index.html
# 修改规格：如需从其他文件读取版本，修改下方 VERSION_SRC 路径即可
VERSION_SRC = "zh/index.html"
version_name = "1.0"      # 默认回退值
version_code = 100        # 对应 v1.0

if os.path.exists(VERSION_SRC):
    with open(VERSION_SRC, "r", encoding="utf-8") as f:
        html = f.read()
    # 匹配徽章文本，例如 ">v1.1<" 或 ">v2.0<"（非贪婪，只取第一个）
    m = re.search(r">v(\d+)\.(\d+)(?:\.(\d+))?<", html)
    if m:
        major = int(m.group(1))
        minor = int(m.group(2))
        patch = int(m.group(3)) if m.group(3) else 0
        version_name = f"{major}.{minor}" if patch == 0 else f"{major}.{minor}.{patch}"
        # versionCode 规则：major×10000 + minor×100 + patch
        # 示例：v1.0→10000, v1.1→10100, v1.9→10900, v2.0→20000, v1.1.2→10102
        # 这样三段版本号也能正确递增，且不会与两段版本号冲突
        version_code = major * 10000 + minor * 100 + patch
        print(f"  Detected version: v{version_name} → versionCode={version_code}")
    else:
        print(f"  WARNING: Version badge not found in {VERSION_SRC}, using default {version_name}")
else:
    print(f"  WARNING: {VERSION_SRC} not found, using default version {version_name}")

print(f"Patching Android Project for lang={LANG}, pkg={PKG_NAME}, version={version_name}...")

# ── 1. 图标文件 ──────────────────────────────────────────────────────────────
# 将对应语言版本的 icon.png 复制到 Android drawable 资源目录
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

# 替换默认图标引用为我们的 drawable/icon
manifest = manifest.replace("@mipmap/ic_launcher_round", "@drawable/icon")
manifest = manifest.replace("@mipmap/ic_launcher", "@drawable/icon")
manifest = manifest.replace("@drawable/icon_round", "@drawable/icon")

# 添加 WAKE_LOCK 权限（屏保/常亮需要）
if "android.permission.WAKE_LOCK" not in manifest:
    manifest = manifest.replace(
        "</manifest>",
        '    <uses-permission android:name="android.permission.WAKE_LOCK" />\n</manifest>'
    )

# 注册 EmbyXDreamService（Android 系统屏保服务）
# 修改规格：如需换 label 或 icon，修改下方 android:label / android:permission 即可
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

with open(manifest_path, "w", encoding="utf-8") as f:
    f.write(manifest)
print("  Patched AndroidManifest.xml")

# ── 3. MainActivity.java 补丁 ────────────────────────────────────────────────
# 添加全屏沉浸式模式 + FLAG_KEEP_SCREEN_ON（视频播放常亮）
# 修改规格：如需改变沉浸式行为，修改下方 SYSTEM_UI_FLAG_* 标志位组合
main_activity_path = f"android/app/src/main/java/{PKG_PATH}/MainActivity.java"
with open(main_activity_path, "r", encoding="utf-8") as f:
    main_activity = f.read()

immersive_code = """
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            getWindow().getDecorView().setSystemUiVisibility(
                android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | android.view.View.SYSTEM_UI_FLAG_FULLSCREEN);
        }
    }
"""

# 添加 FLAG_KEEP_SCREEN_ON（视频播放常亮，防止熄屏打断视频）
if "FLAG_KEEP_SCREEN_ON" not in main_activity:
    main_activity = main_activity.replace(
        "super.onCreate(savedInstanceState);",
        "super.onCreate(savedInstanceState);\n        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);"
    )

# 添加全屏沉浸式覆盖
if "onWindowFocusChanged" not in main_activity:
    main_activity = main_activity.replace("}", immersive_code + "\n}", 1)

with open(main_activity_path, "w", encoding="utf-8") as f:
    f.write(main_activity)
print("  Patched MainActivity.java (fullscreen + keep screen on)")

# ── 4. EmbyXDreamService.java ───────────────────────────────────────────────
# 屏保实现：使用 Android DreamService，内嵌 WebView 加载 EmbyX 本地页面
# Capacitor 打包后的 webDir 内容位于 file:///android_asset/public/index.html
# EmbyX 会读取 localStorage 中已保存的 Emby 服务器配置，自动连接并播放
# 修改规格：如需改变屏保交互性，修改 setInteractive(true/false)
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

        // 允许用户与屏保交互（点击/滑动视频）
        setInteractive(true);
        setFullscreen(true);

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);     // localStorage 需要，用于读取 Emby token
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);  // 屏保自动播放视频无需手势
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW); // 允许 HTTP 视频流

        webView.setWebViewClient(new WebViewClient());
        // 加载 Capacitor 打包的本地 index.html（EmbyX 会自动读取已保存的 Emby 配置）
        webView.loadUrl("file:///android_asset/public/index.html");

        setContentView(webView);
    }}

    @Override
    public void onDreamingStarted() {{
        super.onDreamingStarted();
        // 屏保激活时保持屏幕常亮（播放视频需要）
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

# ── 5. dream_info.xml ────────────────────────────────────────────────────────
# Android 需要此 XML 文件来注册屏保，previewImage 显示在系统屏保选择列表中
os.makedirs("android/app/src/main/res/xml", exist_ok=True)
xml_code = f"""<?xml version="1.0" encoding="utf-8"?>
<dream android:settingsActivity="{PKG_NAME}.MainActivity"
       android:previewImage="@drawable/icon"
       xmlns:android="http://schemas.android.com/apk/res/android" />
"""
with open("android/app/src/main/res/xml/dream_info.xml", "w", encoding="utf-8") as f:
    f.write(xml_code)
print("  Created dream_info.xml")

# ── 6. 注入 APK 版本号到 build.gradle ───────────────────────────────────────
# Android 覆盖安装依赖 versionCode（整数）必须递增，versionName 是人类可读标签
# Capacitor 生成的默认值是 versionCode=1, versionName="1.0"
# 这里用从 HTML 读取的版本替换，保证每次发布 APK 能覆盖旧版本
# 修改规格：versionCode 算法在脚本顶部第 0 步，修改 major/minor/patch 的乘数即可
gradle_path = "android/app/build.gradle"
if os.path.exists(gradle_path):
    with open(gradle_path, "r", encoding="utf-8") as f:
        gradle = f.read()

    # 替换 versionCode（形如 "versionCode 1" 或 "versionCode 10000"）
    gradle = re.sub(r"versionCode\s+\d+", f"versionCode {version_code}", gradle)
    # 替换 versionName（形如 versionName "1.0"）
    gradle = re.sub(r'versionName\s+"[^"]+"', f'versionName "{version_name}"', gradle)

    with open(gradle_path, "w", encoding="utf-8") as f:
        f.write(gradle)
    print(f"  Patched build.gradle → versionCode={version_code}, versionName=\"{version_name}\"")
else:
    print(f"  WARNING: {gradle_path} not found, skipping version injection")

# ── 7. 启动页 (Splash Screen) 官方规范适配 ───────────────────────────────────
# 遵循 Android 12+ SplashScreen API 标准 (Plan A)
os.makedirs("android/app/src/main/res/values", exist_ok=True)
colors_path = "android/app/src/main/res/values/colors.xml"
colors_xml = """<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="black">#000000</color>
    <color name="white">#FFFFFF</color>
</resources>
"""
with open(colors_path, "w", encoding="utf-8") as f:
    f.write(colors_xml)
print("  Created colors.xml")

# ── 8. 修改主题 (Themes) 适配 Google SplashScreen API ────────────────────────
# 我们将强制主题继承自 Theme.SplashScreen，这是 Android 12+ 的官方标准方法
# 兼容库 (androidx.core:core-splashscreen) 会负责向下兼容至 Android 6+
themes_dirs = ["android/app/src/main/res/values", "android/app/src/main/res/values-night"]
for t_dir in themes_dirs:
    t_path = os.path.join(t_dir, "themes.xml")
    if os.path.exists(t_path):
        with open(t_path, "r", encoding="utf-8") as f:
            t_content = f.read()
        
        # 1. 强制修改 parent 为 Theme.SplashScreen
        t_content = re.sub(
            r'<style name="AppTheme\.NoActionBarLaunch" parent=".*?">',
            '<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">',
            t_content
        )
        
        # 2. 注入官方规范属性
        splash_items = """
        <item name="windowSplashScreenBackground">@color/black</item>
        <item name="windowSplashScreenAnimatedIcon">@drawable/icon</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
"""
        # 清理旧属性并注入新规范属性
        if '<style name="AppTheme.NoActionBarLaunch"' in t_content:
            # 移除旧的 background 属性以防冲突
            t_content = re.sub(r'<item name="android:background">.*?</item>', '', t_content)
            # 在 style 闭合前注入
            t_content = t_content.replace('</style>', f'{splash_items}    </style>', 1)
        
        with open(t_path, "w", encoding="utf-8") as f:
            f.write(t_content)
        print(f"  Patched {t_path} to Standard SplashScreen API")

# ── 9. MainActivity 注入官方启动入口 ──────────────────────────────────────────
with open(main_activity_path, "r", encoding="utf-8") as f:
    ma = f.read()

# 注入核心初始化代码 installSplashScreen
# 这是 Google 规范要求的标准入口，必须在 super.onCreate 之前执行
if "installSplashScreen" not in ma:
    ma = ma.replace(
        "super.onCreate(savedInstanceState);",
        "androidx.core.splashscreen.SplashScreen.installSplashScreen(this);\n        super.onCreate(savedInstanceState);\n        // 消除衔接瞬间的可能白屏\n        this.bridge.getWebView().setBackgroundColor(android.graphics.Color.BLACK);"
    )

with open(main_activity_path, "w", encoding="utf-8") as f:
    f.write(ma)
print("  Injected installSplashScreen() to MainActivity.java")

print(f"\nPatch complete! ({LANG} version, pkg={PKG_NAME}, v{version_name})")
