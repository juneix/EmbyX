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

# 添加 WAKE_LOCK 权限（屏保与视频常亮需要）
if "android.permission.WAKE_LOCK" not in manifest:
    manifest = manifest.replace(
        "</manifest>",
        '    <uses-permission android:name="android.permission.WAKE_LOCK" />\n</manifest>'
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

with open(manifest_path, "w", encoding="utf-8") as f:
    f.write(manifest)
print("  Patched AndroidManifest.xml")

# ── 3. MainActivity.java 补丁 ────────────────────────────────────────────────
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

# 添加 FLAG_KEEP_SCREEN_ON（防止视频播放时熄屏）
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

# ── 5. dream_info.xml ────────────────────────────────────────────────────────
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
gradle_path = "android/app/build.gradle"
if os.path.exists(gradle_path):
    with open(gradle_path, "r", encoding="utf-8") as f:
        gradle = f.read()

    # 替换 versionCode / versionName
    gradle = re.sub(r"versionCode(?:\s*=\s*|\s+)\d+", f"versionCode = {version_code}", gradle)
    gradle = re.sub(r'versionName(?:\s*=\s*|\s+)"[^"]+"', f'versionName = "{version_name}"', gradle)

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
# 核心逻辑：将原本占满 100% 的图标缩小到 60% 左右，使其落入 Google 的圆形安全区
splash_icon_xml = """<?xml version="1.0" encoding="utf-8"?>
<inset xmlns:android="http://schemas.android.com/apk/res/android"
    android:drawable="@drawable/icon"
    android:insetLeft="20%"
    android:insetRight="20%"
    android:insetTop="20%"
    android:insetBottom="20%" />
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

# ── 9. MainActivity 注入启动页入口 ──────────────────────────────────────────
with open(main_activity_path, "r", encoding="utf-8") as f:
    ma = f.read()

if "import androidx.core.splashscreen.SplashScreen;" not in ma:
    ma = ma.replace("import android.os.Bundle;", "import android.os.Bundle;\nimport androidx.core.splashscreen.SplashScreen;")

if "SplashScreen.installSplashScreen(this)" not in ma:
    # 注入官方 SplashScreen 入口，并增加“三重保险”防止闪白：
    # 1. installSplashScreen() 必须在 super.onCreate 之前
    # 2. 强行将 Window 背景设为黑（防止 Theme 没生效）
    # 3. 强行将 WebView 背景设为黑（防止 HTML 渲染慢）
    ma = ma.replace(
        "super.onCreate(savedInstanceState);",
        "SplashScreen.installSplashScreen(this);\n        super.onCreate(savedInstanceState);\n        // 三重保险：Window + WebView 全程变黑，彻底解决闪白问题\n        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(android.graphics.Color.BLACK));\n        this.bridge.getWebView().setBackgroundColor(android.graphics.Color.BLACK);"
    )

with open(main_activity_path, "w", encoding="utf-8") as f:
    f.write(ma)
print("  Injected installSplashScreen() and black background to MainActivity.java")

print(f"\nPatch complete! ({LANG} version, pkg={PKG_NAME}, v{version_name})")
