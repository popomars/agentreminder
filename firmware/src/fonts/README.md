# Chinese font

`agentreminder_cjk_18.c` is generated from **Noto Sans SC Regular** (SIL OFL 1.1,
see OFL.txt), at 18px / 2bpp. It covers Basic CJK U+4E00–U+9FFF, Latin-1, Japanese kana, arrows,
Chinese/general punctuation and full-width characters. LVGL's Montserrat font
provides fallback UI symbols. Emoji and supplementary-plane Han are not covered.

Source: https://github.com/notofonts/noto-cjk/tree/main/Sans/SubsetOTF/SC

Regenerate from a downloaded `NotoSansSC-Regular.otf`:

```sh
npx --yes lv_font_conv --size 18 --bpp 2 --format lvgl \
  --font NotoSansSC-Regular.otf \
  -r '0x20-0xFF,0x2000-0x206F,0x2190-0x21FF,0x3000-0x30FF,0x4E00-0x9FFF,0xFF00-0xFFEF' \
  --no-kerning --lv-font-name agentreminder_cjk_18 \
  -o firmware/src/fonts/agentreminder_cjk_18.c
```

The build enables `LV_LVGL_H_INCLUDE_SIMPLE` , `LV_FONT_FMT_TXT_LARGE`, and `LV_USE_FONT_COMPRESSED`.
The startup self-test decodes representative Chinese, ASCII and symbol glyphs
and exposes the result as `font_ok` in the device handshake.
