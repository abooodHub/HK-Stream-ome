#!/usr/bin/env bash
# نشر HK-Stream-ome على الخادم.
# يتطلب وصول SSH (يُفضّل بمفتاح، لا كلمة مرور).
#
# الاستخدام:
#   ./deploy.sh user@host
#   DEPLOY_TARGET=user@host ./deploy.sh
#
# متغيّرات قابلة للتعديل (أو من البيئة):
#   WEB_ROOT     جذر الموقع على الخادم
#   TRACKER_DIR  مجلد خادم التتبّع
set -euo pipefail

TARGET="${1:-${DEPLOY_TARGET:-}}"
if [ -z "$TARGET" ]; then
  echo "الاستخدام: ./deploy.sh user@host   (أو ضع DEPLOY_TARGET في البيئة)" >&2
  exit 1
fi

WEB_ROOT="${WEB_ROOT:-/var/www/your-domain.com/web}"
TRACKER_DIR="${TRACKER_DIR:-/opt/ome-tracker}"
STAGE="/tmp/hk-deploy-$$"

echo "==> رفع الملفات إلى $TARGET ..."
ssh "$TARGET" "mkdir -p '$STAGE'"
scp -rq tracker/ome_tracker tracker/tracker_rtmp.py web "$TARGET:$STAGE/"

echo "==> تركيب وإعادة التشغيل ..."
ssh "$TARGET" "set -e
  sudo rm -rf '$TRACKER_DIR/ome_tracker' '$TRACKER_DIR/__pycache__'
  sudo cp -r '$STAGE/ome_tracker' '$TRACKER_DIR/ome_tracker'
  sudo cp '$STAGE/tracker_rtmp.py' '$TRACKER_DIR/tracker_rtmp.py'
  sudo mkdir -p '$WEB_ROOT'
  sudo cp -r '$STAGE/web/.' '$WEB_ROOT/'
  sudo chown -R www-data:www-data '$WEB_ROOT'
  sudo systemctl restart ome-tracker
  sudo nginx -t && sudo systemctl reload nginx
  rm -rf '$STAGE'
  echo '   حالة الخدمة:' \$(systemctl is-active ome-tracker)
"
echo "==> تم النشر بنجاح ✅"
