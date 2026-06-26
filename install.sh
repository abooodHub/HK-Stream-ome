#!/usr/bin/env bash
# ============================================================================
#  install.sh — تثبيت HK-Stream-ome كاملاً على خادم Ubuntu جديد بأمر واحد.
#  يشغّل: OvenMediaEngine + خادم التتبّع (Python) + nginx + TLS + الجدار الناري.
#
#  الاستخدام (على الخادم الجديد، بعد git clone):
#     sudo DOMAIN=example.com EMAIL=you@mail.com \
#          FOOTBALL_API_KEY=xxxx bash install.sh
#
#  المتغيّرات (من البيئة، أو يسأل عنها تفاعلياً):
#     DOMAIN            النطاق المُوجَّه للخادم (إلزامي)
#     EMAIL             بريد لإصدار شهادة Let's Encrypt (إلزامي)
#     FOOTBALL_API_KEY  مفتاح football-data.org (اختياري — للمباريات)
#     OME_API_TOKEN     توكن OME API (يُولَّد عشوائياً إن تُرك فارغاً)
#     PUBLIC_IP         IP العام للخادم (يُكتشف تلقائياً إن تُرك فارغاً)
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_ROOT_BASE="/var/www"
TRACKER_DIR="/opt/ome-tracker"
OME_CONF_DIR="/opt/ovenmediaengine/origin_conf"

if [ "$(id -u)" -ne 0 ]; then echo "شغّل السكربت بصلاحية root (sudo)." >&2; exit 1; fi

# ── 1) جمع الإعدادات ──────────────────────────────────────────────
DOMAIN="${DOMAIN:-}"
if [ -z "$DOMAIN" ]; then read -rp "النطاق (domain): " DOMAIN; fi
EMAIL="${EMAIL:-}"
if [ -z "$EMAIL" ]; then read -rp "البريد لشهادة TLS: " EMAIL; fi
FOOTBALL_API_KEY="${FOOTBALL_API_KEY:-}"
OME_API_TOKEN="${OME_API_TOKEN:-$(openssl rand -hex 32)}"
PUBLIC_IP="${PUBLIC_IP:-$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me || echo)}"
WEB_ROOT="$WEB_ROOT_BASE/$DOMAIN/web"
if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then echo "DOMAIN و EMAIL إلزاميان." >&2; exit 1; fi
if [ -z "$PUBLIC_IP" ]; then echo "تعذّر اكتشاف PUBLIC_IP — مرّره يدوياً." >&2; exit 1; fi
echo "==> النطاق=$DOMAIN  IP=$PUBLIC_IP"

# ── 2) الاعتماديات ────────────────────────────────────────────────
echo "==> تثبيت الحزم..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx python3 python3-pip iptables certbot python3-certbot-nginx \
                       docker.io openssl curl >/dev/null
systemctl enable --now docker >/dev/null 2>&1 || true

# ── 3) OvenMediaEngine (Docker) ───────────────────────────────────
echo "==> إعداد OvenMediaEngine..."
mkdir -p "$OME_CONF_DIR"
sed -e "s/__OME_API_TOKEN__/$OME_API_TOKEN/" \
    -e "s/__PUBLIC_IP__/$PUBLIC_IP/g" \
    -e "s/__DISTRIBUTION__/$DOMAIN/" \
    "$REPO_DIR/config/ome/Server.xml" > "$OME_CONF_DIR/Server.xml"
docker rm -f ovenmediaengine >/dev/null 2>&1 || true
# شبكة المضيف (host) بدل نشر المنافذ (bridge): تُلغي docker-proxy وNAT،
# فتمرّ حزم البث (خصوصاً 100 منفذ UDP لـ WebRTC) مباشرة لشبكة المضيف.
# يخفّض استهلاك dockerd بشكل كبير. المنافذ نفسها تُفتح على المضيف مباشرة.
docker run -d --name ovenmediaengine --restart always \
  --network host \
  -v "$OME_CONF_DIR:/opt/ovenmediaengine/bin/origin_conf" \
  airensoft/ovenmediaengine:latest -c origin_conf >/dev/null

# ── 4) خادم التتبّع (Python + systemd) ────────────────────────────
echo "==> نشر خادم التتبّع..."
mkdir -p "$TRACKER_DIR/data"
cp "$REPO_DIR/tracker/tracker_rtmp.py" "$TRACKER_DIR/"
rm -rf "$TRACKER_DIR/ome_tracker"
cp -r "$REPO_DIR/tracker/ome_tracker" "$TRACKER_DIR/ome_tracker"
pip3 install -q -r "$REPO_DIR/requirements.txt" 2>/dev/null || true

cat > "$TRACKER_DIR/.env" <<EOF
FOOTBALL_API_KEY=$FOOTBALL_API_KEY
OME_API_TOKEN=$OME_API_TOKEN
ALLOWED_ORIGIN=https://$DOMAIN
EOF
chmod 600 "$TRACKER_DIR/.env"

cp "$REPO_DIR/deploy/ome-tracker.service" /etc/systemd/system/ome-tracker.service
systemctl daemon-reload
systemctl enable --now ome-tracker

# ── 5) الواجهة ───────────────────────────────────────────────────
echo "==> نشر الواجهة..."
mkdir -p "$WEB_ROOT"
cp -r "$REPO_DIR/web/." "$WEB_ROOT/"
chown -R www-data:www-data "$WEB_ROOT_BASE/$DOMAIN"

# ── 6) شهادة TLS (قبل نشر إعداد nginx الذي يحتاجها) ───────────────
echo "==> إصدار شهادة TLS..."
systemctl stop nginx >/dev/null 2>&1 || true
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  certbot certonly --standalone --non-interactive --agree-tos -m "$EMAIL" -d "$DOMAIN"
fi

# ── 7) إعداد nginx ───────────────────────────────────────────────
echo "==> تفعيل nginx..."
sed "s/your-domain.com/$DOMAIN/g" "$REPO_DIR/config/your-domain.com.conf" \
    > "/etc/nginx/sites-available/$DOMAIN.conf"
ln -sf "/etc/nginx/sites-available/$DOMAIN.conf" "/etc/nginx/sites-enabled/$DOMAIN.conf"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl start nginx
systemctl reload nginx

# ── 8) الجدار الناري ─────────────────────────────────────────────
echo "==> ضبط الجدار الناري..."
if command -v ufw >/dev/null; then
  ufw allow 22/tcp >/dev/null;  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null; ufw allow 1935/tcp >/dev/null
  ufw allow 3478 >/dev/null;    ufw allow 10000:10099/udp >/dev/null
  ufw deny 8080/tcp >/dev/null; ufw deny 8081/tcp >/dev/null
  ufw --force enable >/dev/null
fi

# ── تم ───────────────────────────────────────────────────────────
echo ""
echo "==================================================================="
echo "  ✅ تم التثبيت — https://$DOMAIN"
echo "  لوحة التحكّم:  https://$DOMAIN/dashboard.html"
echo "  OME_API_TOKEN: $OME_API_TOKEN"
echo "  كلمة مرور admin (أول مرة):"
echo "     journalctl -u ome-tracker -n 30 --no-pager | grep -i pass"
echo "  بثّ من OBS:  rtmp://$DOMAIN:1935/app   (مفتاح البث: من اللوحة)"
echo "==================================================================="
