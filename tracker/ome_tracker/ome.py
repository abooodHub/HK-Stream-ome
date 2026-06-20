"""استعلام OvenMediaEngine، خيط الاستطلاع الدوري، وتتبّع جلسات البث.

يعيد كتابة عدّادات store (peak_viewers/total_*/last_poll_time) عبر store.NAME.
متغيّرات الجلسة هنا تُقرأ من handler عبر ome.current_session.
"""
import glob, json, os, threading, time
from datetime import datetime

from . import config, store, geoip, metrics

# --- متغيّرات تتبّع الجلسة ---
current_session = None
last_stream_online = False
session_viewer_samples = []
last_viewer_sample_ts = 0
session_bytes_recv_start = 0.0
session_bytes_sent_start = 0.0


def query_ome_api(path):
    try:
        import urllib.request, base64
        url = f"http://127.0.0.1:8081{path}"
        # Basic auth: base64(token:) — التوكن كاسم المستخدم وكلمة المرور فارغة
        auth_str = base64.b64encode(f"{config.OME_API_TOKEN}".encode()).decode('utf-8')
        req = urllib.request.Request(url, headers={
            "Authorization": f"Basic {auth_str}",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=2) as res:
            return json.loads(res.read().decode('utf-8'))
    except Exception:
        return None


def purge_viewer_ips():
    """حذف كل عناوين IP الخاصة بالمشاهدين فور توقف البث.
    لا يمس قوائم الحظر/الطرد لأنها ضرورية لاستمرار المنع."""
    with store.lock:
        store.viewers.clear()
    geoip.clear_cache()
    for path in glob.glob(config.NGINX_ACCESS_LOG_GLOB):
        try:
            if path.endswith("access.log"):
                open(path, "w").close()  # truncate الملف النشط بدون كسر nginx
            else:
                os.remove(path)          # حذف الأرشيف المدوّر (.1 / .gz)
        except OSError:
            pass


def track_session():
    global current_session, last_stream_online, session_viewer_samples, last_viewer_sample_ts
    global session_bytes_recv_start, session_bytes_sent_start
    online = store.stream_meta.get("online", False)
    now = time.time()

    if online and not last_stream_online:
        # بدأ البث — لقطة أساس البايتات
        session_bytes_recv_start = store.total_bytes_received
        session_bytes_sent_start = store.total_hls_bytes_sent
        current_session = {
            "id": datetime.now().strftime("%Y%m%d_%H%M%S"),
            "started_at": int(now), "ended_at": None, "duration_s": 0,
            "peak_viewers": 0, "avg_viewers": 0, "total_unique_ips": 0,
            "total_sent_bytes": 0, "total_recv_bytes": 0, "quality_events": 0,
            "viewer_timeline": [],
        }
        session_viewer_samples = []
        last_viewer_sample_ts = now

    elif not online and last_stream_online and current_session:
        # انتهى البث — احسب بايتات هذه الجلسة فقط
        current_session["ended_at"] = int(now)
        current_session["duration_s"] = int(now - current_session["started_at"])
        current_session["viewer_timeline"] = session_viewer_samples
        if session_viewer_samples:
            counts = [s["count"] for s in session_viewer_samples]
            current_session["peak_viewers"] = max(counts)
            current_session["avg_viewers"] = round(sum(counts)/len(counts), 1)
        current_session["total_sent_bytes"] = int(store.total_hls_bytes_sent - session_bytes_sent_start)
        current_session["total_recv_bytes"] = int(store.total_bytes_received - session_bytes_recv_start)
        store.sessions_log.insert(0, current_session)  # الأحدث أولاً
        if len(store.sessions_log) > 100:
            store.sessions_log.pop()
        try:
            with open(config.SESSIONS_FILE, "w") as f:
                json.dump(store.sessions_log, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
        current_session = None
        purge_viewer_ips()

    elif online and current_session:
        cur_count = len(store.viewers)
        if cur_count > current_session["peak_viewers"]:
            current_session["peak_viewers"] = cur_count
        if now - last_viewer_sample_ts >= 60:
            session_viewer_samples.append({"ts": int(now), "count": cur_count})
            last_viewer_sample_ts = now

    last_stream_online = online


def poller():
    while True:
        try:
            store.expire_viewers()

            # انتهاء صلاحية الطرد تلقائياً
            now = time.time()
            expired_kicks = [ip for ip, k in list(store.kicks.items()) if k.get("expires", 0) < now]
            if expired_kicks:
                with store.lock:
                    for ip in expired_kicks:
                        store.kicks.pop(ip, None)
                store.save_all()
                for ip in expired_kicks:
                    store.iptables("-D", ip)

            # استعلام OvenMediaEngine عن البثوث النشطة
            streams_res = query_ome_api("/v1/vhosts/default/apps/app/streams")
            online = False
            bitrate = 0
            started_at = now
            v_width = 1920
            v_height = 1080
            v_codec = "h264"
            a_codec = "aac"

            if streams_res and streams_res.get("statusCode") == 200:
                active_streams = streams_res.get("response", [])
                if active_streams:
                    target_key = active_streams[0]
                    online = True
                    details = query_ome_api(f"/v1/vhosts/default/apps/app/streams/{target_key}")
                    if details and details.get("statusCode") == 200:
                        resp = details.get("response", {})
                        input_data = resp.get("input", {})

                        created_str = input_data.get("createdTime")
                        if created_str:
                            try:
                                created_dt = datetime.fromisoformat(created_str.replace('Z', '+00:00'))
                                started_at = created_dt.timestamp()
                            except Exception:
                                started_at = now

                        tracks = input_data.get("tracks", [])
                        for track in tracks:
                            track_type = track.get("type", "").lower()
                            if track_type == "video":
                                vd = track.get("video", {})
                                bitrate += vd.get("bitrate", 0)
                                v_width = vd.get("width", v_width)
                                v_height = vd.get("height", v_height)
                                v_codec = vd.get("codec", v_codec)
                            elif track_type == "audio":
                                ad = track.get("audio", {})
                                bitrate += ad.get("bitrate", 0)
                                a_codec = ad.get("codec", a_codec)

            dt = max(0.0, now - store.last_poll_time)
            store.last_poll_time = now

            if streams_res is None:
                store.ome_api_fail_count += 1
                if store.ome_api_fail_count >= 6:
                    # 30 ثانية بدون API → نعتبر البث توقف
                    with store.lock:
                        store.stream_meta["online"] = False
                        store.stream_meta["bw_in"] = 0
                        store.stream_meta["bw_out"] = 0
                        store.stream_meta["time_ms"] = 0
                elif store.stream_meta.get("online") and store.stream_meta.get("started_at", 0) > 0:
                    # API مؤقتاً غير متاح — أبقِ الحالة وحدّث الوقت فقط
                    with store.lock:
                        store.stream_meta["last_active_time"] = now
                        store.stream_meta["time_ms"] = int((now - store.stream_meta["started_at"]) * 1000)
                        bw_in_current = store.stream_meta.get("bw_in", 0)
                        if bw_in_current > 0:
                            bw_out = bw_in_current * len(store.viewers)
                            store.stream_meta["bw_out"] = bw_out
                            store.stream_meta["bytes_in"] = store.stream_meta.get("bytes_in", 0) + int((bw_in_current / 8.0) * dt)
                            store.total_bytes_received = store.stream_meta["bytes_in"]
                            store.stream_meta["bytes_out"] = store.stream_meta.get("bytes_out", 0) + int((bw_out / 8.0) * dt)
                            store.total_hls_bytes_sent = store.stream_meta["bytes_out"]
            elif online:
                store.ome_api_fail_count = 0
                if bitrate <= 0:
                    bitrate = 6000000  # 6 Mbps افتراضي احتياطي

                with store.lock:
                    store.stream_meta["online"] = True
                    store.stream_meta["started_at"] = started_at
                    store.stream_meta["last_active_time"] = now
                    store.stream_meta["time_ms"] = int((now - started_at) * 1000)
                    store.stream_meta["bw_in"] = bitrate

                    active_viewers = len(store.viewers)
                    bw_out = bitrate * active_viewers
                    store.stream_meta["bw_out"] = bw_out

                    store.stream_meta["bytes_in"] = store.stream_meta.get("bytes_in", 0) + int((bitrate / 8.0) * dt)
                    store.total_bytes_received = store.stream_meta["bytes_in"]
                    store.stream_meta["bytes_out"] = store.stream_meta.get("bytes_out", 0) + int((bw_out / 8.0) * dt)
                    store.total_hls_bytes_sent = store.stream_meta["bytes_out"]

                    store.stream_meta["video"] = {"width": v_width, "height": v_height, "codec": v_codec}
                    store.stream_meta["audio"] = {"codec": a_codec, "samplerate": 48000}
            else:
                store.ome_api_fail_count = 0
                with store.lock:
                    store.stream_meta["online"] = False
                    store.stream_meta["bw_in"] = 0
                    store.stream_meta["bw_out"] = 0
                    store.stream_meta["time_ms"] = 0

            kbps = store.stream_meta.get("bw_in", 0) // 1000
            store.bw_history.append({"ts": int(time.time()), "kbps": kbps})
            if len(store.bw_history) > 120:
                store.bw_history.pop(0)
            cur = len(store.viewers)
            if cur > store.peak_viewers:
                store.peak_viewers = cur

            metrics.update_cpu_percent()
            track_session()

            # تعبئة مسبقة لذاكرة GeoIP للمشاهدين النشطين (غير حاجبة للطلبات)
            for _ip_addr in list(store.viewers.keys()):
                geoip.resolve_ip_country(_ip_addr)

        except Exception:
            pass
        time.sleep(5)


def start_poller():
    threading.Thread(target=poller, daemon=True).start()
