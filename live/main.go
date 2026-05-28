/*
EmbyX - 直播中转服务
© 2026 谢週五 (https://juneix.github.io)
*/
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// 配置文件 live.json 对应的结构体
type ManualChannel struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Logo string `json:"logo,omitempty"`
}

type AutoChannel struct {
	Name     string `json:"name"`
	Platform string `json:"platform"`
	RoomID   string `json:"room_id"`
	Logo     string `json:"logo,omitempty"`
}

type LiveConfig struct {
	ManualList []ManualChannel `json:"manual_list"`
	AutoList   []AutoChannel   `json:"auto_list"`
}

// 包含 BaseURL 的保存请求结构体
type SaveRequest struct {
	LiveConfig
	BaseURL string `json:"base_url"`
}

var (
	configPath = "live/live.json"
	strmOutDir = "./strm_out"
	mu         sync.Mutex
)

func main() {
	// 读取配置的环境变量
	if envPath := os.Getenv("CONFIG_PATH"); envPath != "" {
		configPath = envPath
	}
	if envOutDir := os.Getenv("STRM_OUT_DIR"); envOutDir != "" {
		strmOutDir = envOutDir
	}

	// 确保 strm 输出目录存在
	if err := os.MkdirAll(strmOutDir, 0755); err != nil {
		log.Fatalf("无法创建 strm 输出目录: %v", err)
	}

	// 注册路由
	http.HandleFunc("/api/config", handleConfig)
	http.HandleFunc("/api/fetch_avatar", handleFetchAvatar)
	http.HandleFunc("/api/scan_library", handleScanLibrary)
	http.HandleFunc("/api/logo", handleGetLogo)
	http.HandleFunc("/play", handlePlayRedirect)

	// 后台运行在 8091 端口 (支持 LIVE_PORT 或 PROXY_PORT 环境变量控制)
	port := "8091"
	if envPort := os.Getenv("LIVE_PORT"); envPort != "" {
		port = envPort
	} else if envPort := os.Getenv("PROXY_PORT"); envPort != "" {
		port = envPort
	}

	log.Printf("📱 EmbyX 直播中转已启动，监听端口: %s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("服务器启动失败: %v", err)
	}
}

// ==================== 1. API 路由处理器 ====================

// 读写配置文件，并自动同步 `.strm` 文件夹
func handleConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Access-Control-Allow-Methods", "*")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	mu.Lock()
	defer mu.Unlock()

	// 智能判定是否为本地测试环境 (Referer 或 Origin 包含 5500 端口)
	path := configPath
	outDir := strmOutDir
	referer := r.Header.Get("Referer")
	origin := r.Header.Get("Origin")
	if strings.Contains(referer, ":5500") || strings.Contains(origin, ":5500") {
		path = "strm_test/live.json"
		outDir = "./strm_test"
	}

	if r.Method == http.MethodGet {
		// GET 请求: 返回当前的配置
		data, err := os.ReadFile(path)
		if err != nil {
			// 文件不存在则返回空模板
			w.Write([]byte(`{"manual_list":[],"auto_list":[]}`))
			return
		}
		w.Write(data)
		return
	}

	if r.Method == http.MethodPost {
		// POST 请求: 保存配置并同步 strm
		var req SaveRequest
		decoder := json.NewDecoder(r.Body)
		if err := decoder.Decode(&req); err != nil {
			http.Error(w, `{"message":"无效的JSON数据"}`, http.StatusBadRequest)
			return
		}

		// 格式化回写 live.json
		jsonData, err := json.MarshalIndent(req.LiveConfig, "", "  ")
		if err != nil {
			http.Error(w, `{"message":"JSON序列化失败"}`, http.StatusInternalServerError)
			return
		}

		if err := os.WriteFile(path, jsonData, 0644); err != nil {
			http.Error(w, `{"message":"写入配置文件失败"}`, http.StatusInternalServerError)
			return
		}

		// 同步指定目录的 strm 与海报图片
		go syncStrmDirectory(req.LiveConfig, req.BaseURL, outDir)

		w.Write([]byte(`{"status":"success"}`))
		return
	}

	w.WriteHeader(http.StatusMethodNotAllowed)
}

// 自动联想拉取主播头像
func handleFetchAvatar(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	platform := r.URL.Query().Get("platform")
	roomID := r.URL.Query().Get("room_id")

	if platform == "" || roomID == "" {
		http.Error(w, `{"message":"缺少平台或房间号"}`, http.StatusBadRequest)
		return
	}

	var avatar, nickname string
	var err error

	switch platform {
	case "douyu":
		avatar, nickname, err = fetchDouyuInfo(roomID)
	case "huya":
		avatar, nickname, err = fetchHuyaInfo(roomID)
	case "bilibili":
		avatar, nickname, err = fetchBilibiliInfo(roomID)
	default:
		err = fmt.Errorf("不支持的平台")
	}

	if err != nil {
		log.Printf("获取主播信息失败 [%s:%s]: %v", platform, roomID, err)
		http.Error(w, fmt.Sprintf(`{"message":"%v"}`, err), http.StatusInternalServerError)
		return
	}

	resp := map[string]string{
		"avatar":   avatar,
		"nickname": nickname,
	}
	json.NewEncoder(w).Encode(resp)
}

// 发起 Emby 后台库扫描
func handleScanLibrary(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	// 直接从请求参数或默认配置里通知 Emby (如果有配置的话)
	// 在 live.html 中也可以让前端直接通过 ajax 请求 Emby。我们这里预留 Go 发送
	// 由于前端活泼的配置，我们可以读取 live.json 里可能的设置，或者直接支持前端在 POST 里指定 Server 和 Token
	type EmbyNotify struct {
		Server string `json:"server"`
		Token  string `json:"token"`
	}

	var notify EmbyNotify
	json.NewDecoder(r.Body).Decode(&notify)

	if notify.Server == "" || notify.Token == "" {
		// 如果前端没给，尝试从环境变量获取默认配置
		notify.Server = os.Getenv("EMBY_SERVER")
		notify.Token = os.Getenv("EMBY_TOKEN")
	}

	if notify.Server == "" || notify.Token == "" {
		// 如果都没有，返回提示让前端自行发送或者直接算成功 (因为 live.html 也会在前台自己发送以做双保险)
		w.Write([]byte(`{"status":"skipped","message":"未提供 Emby Server 和 Token 变量"}`))
		return
	}

	// 格式化 Emby 刷新 URL
	u := fmt.Sprintf("%s/emby/Library/Media/Refresh?api_key=%s", strings.TrimSuffix(notify.Server, "/"), notify.Token)
	resp, err := http.Post(u, "application/json", nil)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"message":"连接Emby失败: %v"}`, err), http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	w.Write([]byte(`{"status":"success"}`))
}

// 播放时实时 302 重定向或中继到真实的播放地址
func handlePlayRedirect(w http.ResponseWriter, r *http.Request) {
	// 强行注入局域网 CORS 放行头以支持 mpegts.js / Hls.js 跨域请求
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Access-Control-Allow-Methods", "*")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	name := r.URL.Query().Get("id")
	playType := r.URL.Query().Get("type")

	if name == "" {
		http.Error(w, "缺少 id 参数", http.StatusBadRequest)
		return
	}

	var playURL string
	var err error

	// 智能多路径降级查找：优先尝试读取本地测试 strm_test/live.json
	data, errLocal := os.ReadFile("strm_test/live.json")
	if errLocal == nil {
		var config LiveConfig
		if json.Unmarshal(data, &config) == nil {
			playURL, err = findPlayURLInConfig(config, name, playType)
		}
	}

	// 如果在测试配置中没找到或出错，则回退到默认的根目录 live.json 配置
	if playURL == "" {
		dataDefault, errDefault := os.ReadFile(configPath)
		if errDefault != nil {
			http.Error(w, "未发现任何直播源配置文件", http.StatusNotFound)
			return
		}
		var configDefault LiveConfig
		if err = json.Unmarshal(dataDefault, &configDefault); err != nil {
			http.Error(w, "配置文件损坏", http.StatusInternalServerError)
			return
		}
		playURL, err = findPlayURLInConfig(configDefault, name, playType)
	}

	if err != nil {
		http.Error(w, fmt.Sprintf("实时解析流失败: %v", err), http.StatusInternalServerError)
		return
	}

	if playURL == "" {
		http.Error(w, "主播当前可能下播或频道未找到", http.StatusNotFound)
		return
	}

	// 设备与格式智能判定：iOS/苹果移动端或非FLV格式走302重定向，防止iOS无法播放FLV或相对TS路径404
	userAgent := r.Header.Get("User-Agent")
	isAppleMobile := strings.Contains(userAgent, "iPhone") || strings.Contains(userAgent, "iPad") || strings.Contains(userAgent, "iPod") || (strings.Contains(userAgent, "Macintosh") && strings.Contains(userAgent, "Mobile"))
	isFlv := strings.Contains(playURL, ".flv") || strings.Contains(playURL, "flv=") || strings.Contains(playURL, "/flv")

	// 智能分流
	if isAppleMobile || !isFlv {
		// 苹果端或 HLS/m3u8 协议流使用 302 直连重定向
		log.Printf("🍏 iOS 设备或 HLS 协议流走 302 重定向: %s -> %s", name, playURL)
		http.Redirect(w, r, playURL, http.StatusFound)
		return
	}

	// Chrome/Edge FLV 流：高性能 io.Copy 二进制中继 (Timeout=0 永不超时防止断流)
	client := &http.Client{Timeout: 0}
	req, err := http.NewRequest("GET", playURL, nil)
	if err != nil {
		http.Error(w, fmt.Sprintf("创建中继请求失败: %v", err), http.StatusInternalServerError)
		return
	}

	// 智能伪造请求头以破除平台防盗链
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	if strings.Contains(playURL, "bilibili") || strings.Contains(playURL, "bilivideo") {
		req.Header.Set("Referer", "https://live.bilibili.com/")
	} else if strings.Contains(playURL, "huya") {
		req.Header.Set("Referer", "https://m.huya.com/")
	}

	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, fmt.Sprintf("连接直播源流失败: %v", err), http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	// chunked 块分发，保持原画无损低延时
	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.Header().Set("Transfer-Encoding", "chunked")

	log.Printf("💻 PC端 FLV 直连中继启动: %s -> %s", name, playURL)
	_, _ = io.Copy(w, resp.Body)
}
// 辅助函数：在一套 LiveConfig 配置中检索出指定主播/频道的播放 URL (包含实时解析)
func findPlayURLInConfig(config LiveConfig, name string, playType string) (string, error) {
	if playType == "manual" {
		for _, item := range config.ManualList {
			if item.Name == name {
				return item.URL, nil
			}
		}
	} else {
		for _, item := range config.AutoList {
			if item.Name == name {
				url, err := parseLiveStream(item.Platform, item.RoomID)
				if err != nil {
					return "", err
				}
				return url, nil
			}
		}
	}
	return "", nil
}

// ==================== 2. 直播流解析核心算法 ====================

// 动态解析核心分流器
func parseLiveStream(platform, roomID string) (string, error) {
	switch platform {
	case "douyu":
		return parseDouyu(roomID)
	case "huya":
		return parseHuya(roomID)
	case "bilibili":
		return parseBilibili(roomID)
	}
	return "", fmt.Errorf("不支持的平台: %s", platform)
}

// A. 斗鱼免签 HTML5 播放流解析
func parseDouyu(roomID string) (string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	u := fmt.Sprintf("https://m.douyu.com/html5/live?roomId=%s", roomID)
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result struct {
		Error int    `json:"error"`
		Msg   string `json:"msg"`
		Data  struct {
			HlsURL string `json:"hls_url"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}

	if result.Error != 0 {
		return "", fmt.Errorf("斗鱼 API 报错: %s", result.Msg)
	}

	if result.Data.HlsURL == "" {
		return "", fmt.Errorf("未获取到斗鱼直播流链接，主播可能已下播")
	}

	return result.Data.HlsURL, nil
}

// B. 虎牙动态 m3u8 反算拼接解析
func parseHuya(roomID string) (string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	u := fmt.Sprintf("https://m.huya.com/%s", roomID)
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	bodyStr := string(bodyBytes)

	// 正则提取 stream JSON 字符串
	reg := regexp.MustCompile(`"stream"\s*:\s*(\{.+?\})`)
	match := reg.FindStringSubmatch(bodyStr)
	if len(match) < 2 {
		return "", fmt.Errorf("未能从虎牙页面提取出播放流配置，主播可能已下播")
	}

	// 解析虎牙 stream 数据结构
	var streamData struct {
		Data []struct {
			GameStreamInfoList []struct {
				SFlvUrl       string `json:"sFlvUrl"`
				SHlsUrl       string `json:"sHlsUrl"`
				SStreamName   string `json:"sStreamName"`
				SHlsUrlSuffix string `json:"sHlsUrlSuffix"`
				SHlsAntiCode  string `json:"sHlsAntiCode"`
			} `json:"gameStreamInfoList"`
		} `json:"data"`
	}

	if err := json.Unmarshal([]byte(match[1]), &streamData); err != nil {
		return "", err
	}

	if len(streamData.Data) == 0 || len(streamData.Data[0].GameStreamInfoList) == 0 {
		return "", fmt.Errorf("虎牙没有可用的线路")
	}

	info := streamData.Data[0].GameStreamInfoList[0]
	// 拼接真正的 HLS 播放流，虎牙 HLS 流最稳定
	hlsURL := fmt.Sprintf("%s/%s.%s?%s", info.SHlsUrl, info.SStreamName, info.SHlsUrlSuffix, info.SHlsAntiCode)
	// 将 http 转换为 https 兼容部分客户端
	hlsURL = strings.Replace(hlsURL, "http://", "https://", 1)

	return hlsURL, nil
}

// C. 哔哩哔哩官方免签 HLS 流解析
func parseBilibili(roomID string) (string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	u := fmt.Sprintf("https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=%s&protocol=0,1&format=0,1,2&codec=0,1&platform=h5", roomID)
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			PlayURLInfo struct {
				PlayURL struct {
					Stream []struct {
						Format []struct {
							Codec []struct {
								BaseURL string `json:"base_url"`
								URLInfo []struct {
									Host  string `json:"host"`
									Extra string `json:"extra"`
								} `json:"url_info"`
							} `json:"codec"`
						} `json:"format"`
					} `json:"stream"`
				} `json:"playurl"`
			} `json:"playurl_info"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}

	if result.Code != 0 {
		return "", fmt.Errorf("B站 API 报错: %s", result.Message)
	}

	stream := result.Data.PlayURLInfo.PlayURL.Stream
	if len(stream) == 0 || len(stream[0].Format) == 0 || len(stream[0].Format[0].Codec) == 0 {
		return "", fmt.Errorf("未获取到B站播放流链接，主播可能下播了")
	}

	codec := stream[0].Format[0].Codec[0]
	if len(codec.URLInfo) == 0 {
		return "", fmt.Errorf("B站返回的 CDN 列表为空")
	}

	// 拼接 m3u8
	playURL := fmt.Sprintf("%s%s%s", codec.URLInfo[0].Host, codec.BaseURL, codec.URLInfo[0].Extra)
	return playURL, nil
}

// ==================== 3. 联想头像与信息抓取逻辑 ====================

// 斗鱼主播基本信息免签拉取
func fetchDouyuInfo(roomID string) (string, string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	u := fmt.Sprintf("https://open.douyucdn.cn/api/RoomApi/room/%s", roomID)
	req, _ := http.NewRequest("GET", u, nil)

	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	var result struct {
		Error int `json:"error"`
		Data  struct {
			RoomName  string `json:"room_name"`
			OwnerName string `json:"owner_name"`
			Avatar    string `json:"avatar"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", "", err
	}

	if result.Error != 0 {
		return "", "", fmt.Errorf("房间不存在或解析失败")
	}

	return result.Data.Avatar, result.Data.OwnerName, nil
}

// 虎牙主播基本信息免签拉取
func fetchHuyaInfo(roomID string) (string, string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	u := fmt.Sprintf("https://m.huya.com/%s", roomID)
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1")

	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", err
	}
	bodyStr := string(bodyBytes)

	// 正则抓取昵称
	regNick := regexp.MustCompile(`<p class="nick">(.+?)</p>`)
	matchNick := regNick.FindStringSubmatch(bodyStr)
	nickname := "未知主播"
	if len(matchNick) >= 2 {
		nickname = matchNick[1]
	}

	// 正则抓取头像
	regAvatar := regexp.MustCompile(`<img class="avatar" src="(.+?)"`)
	matchAvatar := regAvatar.FindStringSubmatch(bodyStr)
	avatar := ""
	if len(matchAvatar) >= 2 {
		avatar = matchAvatar[1]
		if !strings.HasPrefix(avatar, "http") {
			avatar = "https:" + avatar
		}
	}

	if avatar == "" {
		// 备用匹配逻辑
		regAvatarBackup := regexp.MustCompile(`"avatar"\s*:\s*"(.+?)"`)
		matchAvatarBackup := regAvatarBackup.FindStringSubmatch(bodyStr)
		if len(matchAvatarBackup) >= 2 {
			avatar = matchAvatarBackup[1]
		}
	}

	return avatar, nickname, nil
}

// B站主播基本信息免签拉取
func fetchBilibiliInfo(roomID string) (string, string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	u := fmt.Sprintf("https://api.live.bilibili.com/room/v1/Room/get_info?room_id=%s", roomID)
	req, _ := http.NewRequest("GET", u, nil)

	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	var result struct {
		Code int `json:"code"`
		Data struct {
			UID      int    `json:"uid"`
			Title    string `json:"title"`
			CoverURL string `json:"user_cover"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", "", err
	}

	if result.Code != 0 {
		return "", "", fmt.Errorf("B站房间未找到")
	}

	// 进一步获取 B站主播昵称与头像
	uInfo := fmt.Sprintf("https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=%s", roomID)
	req2, _ := http.NewRequest("GET", uInfo, nil)
	resp2, err2 := client.Do(req2)
	if err2 == nil {
		defer resp2.Body.Close()
		var res2 struct {
			Code int `json:"code"`
			Data struct {
				Info struct {
					Face  textOrInt `json:"face"`
					Uname string    `json:"uname"`
				} `json:"info"`
			} `json:"data"`
		}
		if json.NewDecoder(resp2.Body).Decode(&res2) == nil && res2.Code == 0 {
			faceStr := string(res2.Data.Info.Face)
			if faceStr != "" {
				return faceStr, res2.Data.Info.Uname, nil
			}
		}
	}

	return result.Data.CoverURL, "B站主播", nil
}

// 解决B站API中face字段可能返回string或int的类型兼容处理
type textOrInt string

func (t *textOrInt) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		*t = textOrInt(s)
		return nil
	}
	var i int
	if err := json.Unmarshal(b, &i); err == nil {
		*t = textOrInt(fmt.Sprintf("%d", i))
		return nil
	}
	return nil
}

// ==================== 4. 本地 STRM 与海报文件同步核心 ====================

func syncStrmDirectory(config LiveConfig, baseURL string, targetOutDir string) {
	log.Printf("⏳ 开始同步 STRM 文件目录，使用网关网基址: %s", baseURL)

	// 1. 读取旧的目录文件
	files, err := os.ReadDir(targetOutDir)
	if err == nil {
		for _, f := range files {
			if !f.IsDir() && (strings.HasSuffix(f.Name(), ".strm") || strings.HasSuffix(f.Name(), ".jpg")) {
				os.Remove(filepath.Join(targetOutDir, f.Name()))
			}
		}
	}

	// 2. 遍历手动配置列表
	for _, item := range config.ManualList {
		safeName := sanitizeFilename(item.Name)
		strmName := fmt.Sprintf("[手动]%s.strm", safeName)
		jpgName := fmt.Sprintf("[手动]%s.jpg", safeName)

		// 写入 strm 文件
		strmContent := fmt.Sprintf("%s/play?id=%s&type=manual", baseURL, url.QueryEscape(item.Name))
		os.WriteFile(filepath.Join(targetOutDir, strmName), []byte(strmContent), 0644)

		// 下载或写入本地海报
		if item.Logo != "" {
			go downloadImage(item.Logo, filepath.Join(targetOutDir, jpgName))
		}
	}

	// 3. 遍历动态配置列表
	for _, item := range config.AutoList {
		safeName := sanitizeFilename(item.Name)
		platMap := map[string]string{"douyu": "斗鱼", "huya": "虎牙", "bilibili": "B站"}
		plat := platMap[item.Platform]
		if plat == "" {
			plat = item.Platform
		}

		strmName := fmt.Sprintf("[%s]%s.strm", plat, safeName)
		jpgName := fmt.Sprintf("[%s]%s.jpg", plat, safeName)

		// 写入 strm 文件
		strmContent := fmt.Sprintf("%s/play?id=%s&type=auto", baseURL, url.QueryEscape(item.Name))
		os.WriteFile(filepath.Join(targetOutDir, strmName), []byte(strmContent), 0644)

		// 下载或写入本地海报
		if item.Logo != "" {
			go downloadImage(item.Logo, filepath.Join(targetOutDir, jpgName))
		}
	}

	log.Println("✅ STRM 文件目录同步完成！")
}

// 下载图片并写入本地
func downloadImage(urlStr, savePath string) {
	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("GET", urlStr, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

	resp, err := client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return
	}

	out, err := os.Create(savePath)
	if err != nil {
		return
	}
	defer out.Close()

	_, _ = io.Copy(out, resp.Body)
}

// 过滤掉非法的文件字符
func sanitizeFilename(name string) string {
	reg := regexp.MustCompile(`[\\/:*?"<>|]`)
	return reg.ReplaceAllString(name, "_")
}

// 本地静态海报图片流分发接口，彻底绕过各大直播平台防盗链限制
func handleGetLogo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	name := r.URL.Query().Get("name")
	if name == "" {
		http.Error(w, "缺少 name 参数", http.StatusBadRequest)
		return
	}

	safeName := sanitizeFilename(name)

	// 智能多路径合并查找海报图片
	dirs := []string{"./strm_test", strmOutDir}
	for _, dir := range dirs {
		files, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if !f.IsDir() && strings.HasSuffix(f.Name(), ".jpg") && strings.Contains(f.Name(), safeName) {
				imgPath := filepath.Join(dir, f.Name())
				http.ServeFile(w, r, imgPath)
				return
			}
		}
	}

	http.Error(w, "海报图片尚未下载或已下线", http.StatusNotFound)
}
