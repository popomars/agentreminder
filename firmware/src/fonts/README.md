# Chinese font

`agentreminder_cjk_35.c` is generated from **Noto Sans SC Regular** (SIL OFL 1.1,
see OFL.txt), at 35px / 2bpp. It covers Basic CJK U+4E00–U+9FFF, Latin-1, Japanese kana, arrows,
Chinese/general punctuation and full-width characters. LVGL's Montserrat font
provides fallback UI symbols. Emoji and supplementary-plane Han are not covered.

Source: https://github.com/notofonts/noto-cjk/tree/main/Sans/SubsetOTF/SC

`agentreminder_hint_22.c` uses the same font at 22 px with only the characters
in `单击任务可清除`. To regenerate it, use `--size 22 --symbols '单击任务可清除'`
in place of the size and range below, and use `agentreminder_hint_22` as the
font name and output basename.

`agentreminder_meta_24.c` keeps the card metadata and connection status legible at
24 px. It uses 1 bpp to fit the application partition. The 35 px font supplies
glyphs outside this smaller font's Latin, punctuation, kana and first-level
GB2312 character sets. Regenerate with the same OTF as follows:

```sh
characters=$(python3 -c 'print("".join(bytes((hi, lo)).decode("gb2312", "ignore") for hi in range(0xB0, 0xD8) for lo in range(0xA1, 0xFF)))')
npx --yes lv_font_conv --size 24 --bpp 1 --format lvgl \
  --font NotoSansSC-Regular.otf -r '0x20-0xFF,0x2000-0x206F,0x3000-0x30FF' \
  --symbols "$characters" --no-kerning --lv-font-name agentreminder_meta_24 \
  -o firmware/src/fonts/agentreminder_meta_24.c
```

Regenerate from a downloaded `NotoSansSC-Regular.otf`:

```sh
npx --yes lv_font_conv --size 35 --bpp 2 --format lvgl \
  --font NotoSansSC-Regular.otf \
  -r '0x20-0xFF,0x2000-0x206F,0x2190-0x21FF,0x3000-0x30FF,0x4E00-0x9FFF,0xFF00-0xFFEF' \
  --no-kerning --lv-font-name agentreminder_cjk_35 \
  -o firmware/src/fonts/agentreminder_cjk_35.c
```

The build enables `LV_LVGL_H_INCLUDE_SIMPLE` , `LV_FONT_FMT_TXT_LARGE`, and `LV_USE_FONT_COMPRESSED`.
The startup self-test decodes representative Chinese, ASCII and symbol glyphs
and exposes the result as `font_ok` in the device handshake.
