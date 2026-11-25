/* Minimal LVGL 9 config — everything not set here uses LVGL's defaults. */
#ifndef LV_CONF_H
#define LV_CONF_H

#define LV_COLOR_DEPTH 16
#define LV_FONT_FMT_TXT_LARGE 1
#define LV_USE_FONT_COMPRESSED 1
#define LV_USE_STDLIB_MALLOC  LV_STDLIB_CLIB   /* use malloc -> PSRAM when available */
#define LV_USE_STDLIB_STRING  LV_STDLIB_CLIB
#define LV_USE_STDLIB_SPRINTF LV_STDLIB_CLIB
#define LV_DEF_REFR_PERIOD 20

#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_16 1
#define LV_FONT_MONTSERRAT_22 1
#define LV_FONT_SIMSUN_16_CJK 0  /* use the complete basic CJK font in src/fonts */
#define LV_FONT_DEFAULT &lv_font_montserrat_16

#define LV_USE_LOG 0
#define LV_USE_SYSMON 0
#define LV_BUILD_EXAMPLES 0
#define LV_USE_DEMO_WIDGETS 0
#endif
