#!/usr/bin/env python3
"""Nginx-RTMP / OvenMediaEngine Stream Tracker & Admin API — نقطة الدخول.

البنية مقسّمة إلى حزمة ome_tracker:
  config   الثوابت والمسارات والسجلّ الأمني
  store    الحالة المشتركة + حفظ/تحميل JSON + المشاهدون + الحظر/الطرد
  auth     المصادقة والتوكنات وحدّ المحاولات والإيقاف المؤقت
  geoip    تحديد بلد الـ IP مع تخزين مؤقت
  detect   كشف الجهاز/المتصفّح
  matches  مواعيد المباريات (football-data)
  metrics  قياسات الخادم (CPU/RAM/Disk)
  ome      استعلام OvenMediaEngine + خيط الاستطلاع + الجلسات
  handler  معالج HTTP لكل المسارات
"""
from ome_tracker import config, ome, handler

if __name__ == "__main__":
    ome.start_poller()
    srv = handler.ThreadedServer((config.HOST, config.PORT), handler.Handler)
    print(f"Tracker running on {config.HOST}:{config.PORT}")
    srv.serve_forever()
